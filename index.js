const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios'); // <--- THÊM DÒNG NÀY
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

const SHOP = 'nekochin.com';
const ACCESS_TOKEN = '8D69E2B91FDF0D073CAC0126CCA36B924276EB0DFF55C7F76097CFD8283920BE';
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
// ================== API ĐỔI ĐIỂM LẤY VOUCHER (ĐÃ SỬA) ==================
app.post('/redeem', async (req, res) => {
  const { phone, points } = req.body;
  const parsedPoints = parseInt(points, 10);

  if (!phone || !parsedPoints || isNaN(parsedPoints) || parsedPoints <= 0) {
    return res.status(400).json({ error: 'Thiếu thông tin hoặc số điểm không hợp lệ.' });
  }

  try {
    const user = await UserPoints.findOne({ phone });

    if (!user || user.total_points < parsedPoints) {
      return res.status(400).json({ error: 'Không đủ điểm để đổi hoặc không tìm thấy người dùng.' });
    }

    // 1. Tạo thông tin cho mã giảm giá
    const code = 'NEKO-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const discountValue = parsedPoints; // 1 điểm = 1đ

    // 2. Chuẩn bị yêu cầu gửi đến Haravan
    const haravanApiUrl = `https://${SHOP}/admin/api/2020-04/discounts.json`;
    const discountPayload = {
      discount: {
        code: code,
        discount_type: 'fixed_amount', // Giảm giá theo số tiền cố định
        value: discountValue.toString(), // Giá trị giảm giá
        usage_limit: 1, // Chỉ sử dụng 1 lần
        applies_once_per_customer: true, // Mỗi khách hàng chỉ dùng 1 lần
        starts_at: new Date().toISOString() // Bắt đầu có hiệu lực ngay lập tức
      }
    };

    const haravanHeaders = {
      'Content-Type': 'application/json',
      'X-Haravan-Access-Token': ACCESS_TOKEN
    };

    // 3. Gọi API Haravan để tạo mã
    // Chúng ta sẽ đặt lời gọi này trong một khối try...catch riêng để xử lý lỗi từ Haravan
    try {
      await axios.post(haravanApiUrl, discountPayload, { headers: haravanHeaders });
    } catch (apiError) {
      // Dòng mới, chi tiết hơn
console.error('Lỗi chi tiết từ Haravan:', JSON.stringify(apiError.response?.data || apiError.message));
      return res.status(500).json({ error: 'Không thể tạo mã giảm giá trên hệ thống Haravan.' });
    }

    // 4. Nếu tạo mã thành công, tiến hành trừ điểm và lưu lịch sử
    user.total_points -= parsedPoints;
    if (!user.history) user.history = [];
    user.history.push({
      order_id: `REDEEM-${code}`,
      earned_points: -parsedPoints,
      timestamp: new Date()
    });
    await user.save();

    // 5. Trả về kết quả thành công
    res.json({
      message: '🎉 Đổi điểm thành công! Mã voucher của bạn đã được tạo.',
      code: code,
      value: `${discountValue}đ`
    });

  } catch (dbError) {
    console.error('Lỗi cơ sở dữ liệu:', dbError);
    res.status(500).json({ error: 'Đã xảy ra lỗi với hệ thống nội bộ.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
});
