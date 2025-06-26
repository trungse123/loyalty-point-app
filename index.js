const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// === CONFIG ===
const SHOP = 'neko-chin-shop-5.myharavan.com';
const ACCESS_TOKEN = 'DFE528F8C4CBA1B43727A729CD57187766E059E88AE96682DC2CF04AF4F61306';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://admin:admin1234@cluster0.edubkxs.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

// === DB CONNECT ===
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ Kết nối MongoDB thành công'))
  .catch((err) => console.error('❌ MongoDB lỗi:', err.message));

// === SCHEMA ===
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

// === MIDDLEWARE ===
app.use(cors());
app.use(express.json());

// === WEBHOOK: HARAVAN GỬI KHI ĐƠN HÀNG HOÀN TẤT ===
app.post('/webhook/order', async (req, res) => {
  console.log('🔥 [Webhook] Nhận dữ liệu từ Haravan');
  console.log(JSON.stringify(req.body, null, 2)); // In toàn bộ JSON

  try {
    const order = req.body;
    const customer = order.customer || {};
    const billing = order.billing_address || {};
    const phone = customer.phone || billing.phone;
    const email = customer.email || 'Không có email';
    const order_id = order.id?.toString();
    const total = parseInt(order.total_price || 0);
    const points = Math.floor(total / 100);

    console.log(`➡️ Số điện thoại: ${phone}`);
    console.log(`➡️ Trạng thái thanh toán: ${order.financial_status}`);
    console.log(`➡️ Trạng thái giao hàng: ${order.fulfillment_status}`);
    console.log(`➡️ Tổng tiền: ${total} => Cộng: ${points} điểm`);

    if (!phone || order.financial_status !== 'paid' || !['fulfilled', 'delivered'].includes(order.fulfillment_status)) {
      console.log('⚠️ Bỏ qua đơn không hợp lệ');
      return res.status(200).send('Bỏ qua đơn');
    }

    const user = await UserPoints.findOne({ phone });

    if (user) {
      const existed = user.history.find(h => h.order_id === order_id);
      if (!existed) {
        user.total_points += points;
        user.history.push({ order_id, earned_points: points, timestamp: new Date() });
        await user.save();
        console.log(`✅ Cộng ${points} điểm cho: ${phone}`);
      } else {
        console.log('⚠️ Đơn đã được cộng điểm trước đó');
      }
    } else {
      await UserPoints.create({
        phone,
        email,
        total_points: points,
        history: [{ order_id, earned_points: points, timestamp: new Date() }]
      });
      console.log(`✅ Tạo mới và cộng ${points} điểm cho: ${phone}`);
    }

    res.status(200).send('Xử lý xong');
  } catch (err) {
    console.error('❌ Webhook lỗi:', err.message);
    res.status(500).send('Webhook lỗi');
  }
});

// === TEST GET WEBHOOK (chỉ để thử, không dùng trong thực tế)
app.get('/webhook/order', (req, res) => {
  res.status(405).send('Không hỗ trợ GET. Hãy dùng POST từ Haravan Webhook.');
});

// === API: LẤY ĐIỂM NGƯỜI DÙNG ===
app.get('/points', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'Thiếu số điện thoại' });

  try {
    const user = await UserPoints.findOne({ phone });
    if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng' });

    res.json({
      phone: user.phone,
      email: user.email,
      total_points: user.total_points,
      history: user.history || []
    });
  } catch (err) {
    console.error('❌ /points lỗi:', err.message);
    res.status(500).json({ error: 'Không thể lấy điểm' });
  }
});

// === KHỞI ĐỘNG SERVER ===
app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
});
