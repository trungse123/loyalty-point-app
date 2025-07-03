const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

const SHOP = 'neko-chin-shop-5.myharavan.com';
const ACCESS_TOKEN = 'DFE528F8C4CBA1B43727A729CD57187766E059E88AE96682DC2CF04AF4F61306';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://admin:admin1234@cluster0.edubkxs.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true, useUnifiedTopology: true
});

app.use(cors());
app.use(express.json());

const UserPointsSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  email: String,
  total_points: { type: Number, default: 0 },
  history: [
    { order_id: String, earned_points: Number, timestamp: Date }
  ],
  missions: [
    { mission_key: String, date: Date, points: Number, meta: Object }
  ]
});
const UserPoints = mongoose.model('UserPoints', UserPointsSchema);

// ================== DANH SÁCH NHIỆM VỤ ==================
const MissionList = [
  {
    key: 'daily_login',
    type: 'daily',
    name: 'Đăng nhập mỗi ngày',
    points: 300,
    max_per_day: 1,
    check: async (user) => true
  },
  {
    key: 'share_fb',
    type: 'daily',
    name: 'Chia sẻ website lên Facebook',
    points: 500,
    max_per_day: 1,
    check: async (user) => true
  },
  {
    key: 'review_product',
    type: 'daily',
    name: 'Đánh giá sản phẩm',
    points: 800,
    max_per_day: 3,
    check: async (user) => true
  },
  {
    key: 'monthly_order',
    type: 'monthly',
    name: 'Hoàn thành 5 đơn hàng trong tháng',
    points: 3000,
    max_per_month: 1,
    check: async (user) => {
      const now = new Date();
      const count = (user.history||[]).filter(h =>
        h.timestamp.getMonth() === now.getMonth() &&
        h.timestamp.getFullYear() === now.getFullYear() &&
        !h.order_id.startsWith('REDEEM')
      ).length;
      return count >= 5;
    }
  },
  {
    key: 'monthly_review',
    type: 'monthly',
    name: 'Đánh giá 5 sản phẩm trong tháng',
    points: 2000,
    max_per_month: 1,
    check: async (user) => true
  }
];

// ================== API TRA CỨU ĐIỂM ==================
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
      history: user.history || [],
      missions: user.missions || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Không thể lấy dữ liệu điểm' });
  }
});

// ================== API TRA CỨU NHIỆM VỤ ==================
app.get('/missions', async (req, res) => {
  const { phone } = req.query;
  const user = await UserPoints.findOne({ phone });
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });

  const today = new Date().toLocaleDateString();
  const now = new Date();

  const missionStates = await Promise.all(MissionList.map(async mission => {
    let state = { ...mission, can_claim: false };
    if (mission.type === 'daily') {
      const count = (user.missions || []).filter(m =>
        m.mission_key === mission.key &&
        new Date(m.date).toLocaleDateString() === today
      ).length;
      state.completed_today = count >= (mission.max_per_day || 1);
      state.can_claim = !state.completed_today;
    }
    if (mission.type === 'monthly') {
      const count = (user.missions || []).filter(m =>
        m.mission_key === mission.key &&
        (new Date(m.date).getMonth() + 1) === (now.getMonth() + 1) &&
        (new Date(m.date).getFullYear()) === (now.getFullYear())
      ).length;
      state.completed_this_month = count >= (mission.max_per_month || 1);
      state.can_claim = !state.completed_this_month && await mission.check(user);
    }
    return state;
  }));
  res.json(missionStates);
});

// ================== API HOÀN THÀNH NHIỆM VỤ ==================
app.post('/missions/complete', async (req, res) => {
  const { phone, mission_key } = req.body;
  const mission = MissionList.find(m => m.key === mission_key);
  if (!mission) return res.status(400).json({ error: 'Nhiệm vụ không tồn tại' });

  const user = await UserPoints.findOne({ phone });
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });

  const now = new Date();

  // CHỐNG GIAN LẬN
  let isEligible = false;
  try { isEligible = await mission.check(user); } catch { isEligible = false; }
  if (!isEligible && mission.type === 'monthly') return res.status(400).json({ error: 'Chưa đủ điều kiện nhận thưởng!' });

  if (mission.type === 'daily') {
    const doneToday = (user.missions || []).filter(m =>
      m.mission_key === mission_key &&
      new Date(m.date).toLocaleDateString() === now.toLocaleDateString()
    ).length;
    if (doneToday >= (mission.max_per_day || 1)) {
      return res.status(400).json({ error: 'Đã nhận thưởng nhiệm vụ hôm nay!' });
    }
  }
  if (mission.type === 'monthly') {
    const doneThisMonth = (user.missions || []).filter(m =>
      m.mission_key === mission_key &&
      (new Date(m.date).getMonth() + 1) === (now.getMonth() + 1) &&
      (new Date(m.date).getFullYear()) === (now.getFullYear())
    ).length;
    if (doneThisMonth >= (mission.max_per_month || 1)) {
      return res.status(400).json({ error: 'Đã nhận thưởng nhiệm vụ tháng!' });
    }
  }

  user.total_points += mission.points;
  user.missions = user.missions || [];
  user.missions.push({ mission_key, date: now, points: mission.points });
  await user.save();

  res.json({ message: 'Nhận thưởng thành công', points: mission.points, total_points: user.total_points });
});

// ================== WEBHOOK ĐƠN HÀNG HARAVAN ==================
app.post('/webhook/order', async (req, res) => {
  try {
    const order = req.body;
    const customer = order.customer || {};
    const billing = order.billing_address || {};
    const phone = customer.phone || billing.phone;
    const email = customer.email || null;
    const order_id = order.id?.toString();
    const total = parseInt(order.total_price || 0);
    const points = Math.floor(total / 100);

    const paid = order.financial_status === 'paid';
    const fulfilled = ['fulfilled', 'delivered'].includes(order.fulfillment_status);

    if (!phone || !paid || !fulfilled) {
      return res.status(200).send('❌ Bỏ qua đơn không hợp lệ');
    }

    let user = await UserPoints.findOne({ phone });
    if (user) {
      const existed = user.history.find(h => h.order_id === order_id);
      if (!existed) {
        user.total_points += points;
        user.history.push({ order_id, earned_points: points, timestamp: new Date() });
        await user.save();
      }
    } else {
      user = await UserPoints.create({
        phone,
        email,
        total_points: points,
        history: [{ order_id, earned_points: points, timestamp: new Date() }]
      });
    }
    res.status(200).send('Đã xử lý xong');
  } catch (err) {
    res.status(500).send('Lỗi webhook');
  }
});

// ================== API ĐỔI ĐIỂM LẤY VOUCHER ==================
app.post('/redeem', async (req, res) => {
  const { phone, points } = req.body;
  if (!phone || !points || isNaN(points)) {
    return res.status(400).json({ error: 'Thiếu thông tin hoặc điểm không hợp lệ' });
  }
  try {
    const user = await UserPoints.findOne({ phone });
    if (!user || user.total_points < points) {
      return res.status(400).json({ error: 'Không đủ điểm để đổi' });
    }
    if (!user.email) {
      return res.status(400).json({ error: 'Người dùng chưa có email, không thể tạo voucher' });
    }
    const code = 'VOUCHER-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const discountValue = points;
    // Không gọi API Haravan mẫu nữa cho demo!
    user.total_points -= points;
    user.history.push({
      order_id: `REDEEM-${code}`,
      earned_points: -points,
      timestamp: new Date()
    });
    await user.save();
    res.json({
      message: '🎉 Đổi điểm thành công',
      code,
      value: `${discountValue}đ`
    });
  } catch (err) {
    res.status(500).json({ error: 'Không tạo được voucher' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
});
