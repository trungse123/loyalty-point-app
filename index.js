const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIG FROM ENV ===
const SHOP = process.env.HARAVAN_SHOP;
const ACCESS_TOKEN = process.env.HARAVAN_ACCESS_TOKEN;
const MONGO_URI = process.env.MONGO_URI;

// === CONNECT TO MONGO ===
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

const UserPointsSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  email: String,
  total_points: { type: Number, default: 0 },
  history: [
    {
      order_id: String,
      earned_points: Number,
      timestamp: Date
    }
  ]
});
const UserPoints = mongoose.model('UserPoints', UserPointsSchema);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === HARAVAN WEBHOOK ===
app.post('/webhook/order', async (req, res) => {
  const order = req.body;
  const customer = order.customer || {};
  const billing = order.billing_address || {};
  const phone = customer.phone || billing.phone;

  if (
    order.financial_status !== 'paid' ||
    !['fulfilled', 'delivered'].includes(order.fulfillment_status) ||
    !phone
  ) return res.status(200).send('Skipped');

  const email = customer.email || 'Không có email';
  const total = parseInt(order.total_price || 0);
  const points = Math.floor(total / 100);
  const order_id = order.id;

  try {
    const existing = await UserPoints.findOne({ phone });
    if (existing) {
      const already = existing.history.find(h => h.order_id === order_id.toString());
      if (!already) {
        existing.total_points += points;
        existing.history.push({ order_id, earned_points: points, timestamp: new Date() });
        await existing.save();
      }
    } else {
      await UserPoints.create({
        phone,
        email,
        total_points: points,
        history: [{ order_id, earned_points: points, timestamp: new Date() }]
      });
    }

    console.log(`✅ Webhook: +${points} điểm cho ${phone}`);
    res.status(200).send('Done');
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.status(500).send('Error');
  }
});

// === TRA CỨU ===
app.get('/points', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).send('Missing phone');

  try {
    const user = await UserPoints.findOne({ phone });
    if (!user) return res.status(404).send('Not found');

    res.json({
      phone: user.phone,
      email: user.email,
      total_points: user.total_points,
      history: user.history
    });
  } catch (err) {
    res.status(500).send('Query error');
  }
});

// === ĐỔI ĐIỂM ===
app.post('/redeem', async (req, res) => {
  const { phone, points } = req.body;
  if (!phone || !points || isNaN(points)) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  try {
    const user = await UserPoints.findOne({ phone });

    if (!user || user.total_points < points) {
      return res.status(400).json({ error: 'Insufficient points' });
    }

    const code = 'VOUCHER-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    const response = await axios.post(
      `https://${SHOP}/admin/discounts.json`,
      {
        discount: {
          code,
          starts_at: new Date().toISOString(),
          usage_limit: 1,
          value_type: 'fixed_amount',
          value: points.toString(),
          customer_selection: 'all',
          applies_once: true
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        }
      }
    );

    user.total_points -= points;
    user.history.push({
      order_id: `REDEEM-${code}`,
      earned_points: -points,
      timestamp: new Date()
    });
    await user.save();

    res.json({
      message: 'Redeemed successfully',
      code,
      value: `${points}đ`,
      haravan_discount: response.data.discount
    });
  } catch (err) {
    console.error('❌ Redeem error:', err.message);
    res.status(500).send('Redeem failed');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
