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

// === MONGODB CONNECT ===
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('✅ Đã kết nối MongoDB'))
  .catch((err) => console.error('❌ Lỗi kết nối MongoDB:', err.message));

// === MIDDLEWARE ===
app.use(cors());
app.use(express.json());

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
  ],
  missions: [
    {
      mission_key: String,   // daily_login, review_product, share_fb, referral
      date: Date,
      points: Number,
      referral_by: String,
      referral_to: String
    }
  ],
  referred_by: String,              // Mã bạn nhập
  referral_rewarded: { type: Boolean, default: false } // Đã nhận điểm referral lần đầu chưa
});
const UserPoints = mongoose.model('UserPoints', UserPointsSchema);

// === BẢNG NHIỆM VỤ (chỉ dùng cho nhiệm vụ khác, không ref) ===
const MissionList = [
  { key: 'daily_login',      type: 'daily',    name: 'Đăng nhập mỗi ngày',        points: 100,   max_per_day: 1 },
  { key: 'share_fb',         type: 'daily',    name: 'Chia sẻ website lên Facebook', points: 150,   max_per_day: 1 },
  { key: 'review_product',   type: 'daily',    name: 'Đánh giá sản phẩm',         points: 300,   max_per_day: 3 },
  { key: 'monthly_order',    type: 'monthly',  name: 'Hoàn thành 5 đơn hàng trong tháng', points: 2000,  max_per_month: 1 },
  { key: 'monthly_review',   type: 'monthly',  name: 'Đánh giá 5 sản phẩm trong tháng',   points: 1500,  max_per_month: 1 },
];

// === API: ĐĂNG KÝ MÃ GIỚI THIỆU ===
app.post('/referral-code', async (req, res) => {
  const { phone, referral_code } = req.body;
  if (!phone || !referral_code || phone === referral_code) {
    return res.status(400).json({ error: 'Mã không hợp lệ!' });
  }
  try {
    const user = await UserPoints.findOne({ phone });
    if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });
    if (user.referred_by) return res.status(400).json({ error: 'Bạn đã nhập mã rồi!' });
    // Kiểm tra mã tồn tại
    const refUser = await UserPoints.findOne({ phone: referral_code });
    if (!refUser) return res.status(400).json({ error: 'Mã giới thiệu không hợp lệ!' });
    user.referred_by = referral_code;
    await user.save();
    res.json({ message: "Đã nhập mã thành công! Bạn sẽ nhận điểm khi đặt đơn đầu tiên." });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi server khi nhập mã.' });
  }
});

// === API: TRA CỨU ĐIỂM ===
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
      missions: user.missions || [],
      referred_by: user.referred_by || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Không thể lấy dữ liệu điểm' });
  }
});

// === API: LẤY DANH SÁCH NHIỆM VỤ + TRẠNG THÁI NGƯỜI DÙNG ===
app.get('/missions', async (req, res) => {
  const { phone } = req.query;
  const user = await UserPoints.findOne({ phone });
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });
  const today = new Date().toLocaleDateString();
  const now = new Date();

  const missionStates = MissionList.map(mission => {
    if (mission.type === 'daily') {
      const count = (user.missions || []).filter(m =>
        m.mission_key === mission.key &&
        new Date(m.date).toLocaleDateString() === today
      ).length;
      return { ...mission, completed_today: count >= (mission.max_per_day || 1) };
    }
    if (mission.type === 'monthly') {
      const count = (user.missions || []).filter(m =>
        m.mission_key === mission.key &&
        (new Date(m.date).getMonth() + 1) === (now.getMonth() + 1) &&
        (new Date(m.date).getFullYear()) === (now.getFullYear())
      ).length;
      return { ...mission, completed_this_month: count >= (mission.max_per_month || 1) };
    }
    return mission;
  });
  // Bổ sung nhiệm vụ referral
  missionStates.push({
    key: 'referral',
    type: 'special',
    name: 'Mời bạn bè đặt đơn đầu tiên (cả 2 cùng nhận)',
    points: 5000,
    completed: user.referral_rewarded,
    my_ref_code: user.phone,
    referred_by: user.referred_by
  });
  res.json(missionStates);
});

// === API: HOÀN THÀNH NHIỆM VỤ KHÁC (KHÔNG PHẢI referral) ===
app.post('/missions/complete', async (req, res) => {
  const { phone, mission_key } = req.body;
  if (!phone || !mission_key) return res.status(400).json({ error: 'Thiếu thông tin' });
  if (mission_key === 'referral') return res.status(400).json({ error: 'Dùng endpoint /referral-code để nhập mã!' });

  const mission = MissionList.find(m => m.key === mission_key);
  if (!mission) return res.status(400).json({ error: 'Nhiệm vụ không tồn tại' });
  const user = await UserPoints.findOne({ phone });
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });

  const now = new Date();
  // Check giới hạn nhiệm vụ (daily, monthly)
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

  // Cộng điểm + lưu lịch sử
  user.total_points += mission.points;
  user.missions = user.missions || [];
  user.missions.push({ mission_key, date: now, points: mission.points });
  await user.save();
  res.json({ message: 'Nhận thưởng thành công', points: mission.points, total_points: user.total_points });
});

// === WEBHOOK: ĐƠN HÀNG HARAVAN ===
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

    // ==== LOGIC ĐIỂM REFERRAL ====
    if (user.referred_by && !user.referral_rewarded) {
      const validOrders = (user.history || []).filter(h => !h.order_id.startsWith('REDEEM'));
      if (validOrders.length === 1) { // Đơn đầu tiên
        // Cộng điểm cho user
        user.total_points += 5000;
        user.missions = user.missions || [];
        user.missions.push({
          mission_key: 'referral',
          date: new Date(),
          points: 5000,
          referral_by: user.referred_by
        });
        user.referral_rewarded = true;
        await user.save();

        // Cộng điểm cho người giới thiệu
        const inviter = await UserPoints.findOne({ phone: user.referred_by });
        if (inviter) {
          inviter.total_points += 5000;
          inviter.missions = inviter.missions || [];
          inviter.missions.push({
            mission_key: 'referral',
            date: new Date(),
            points: 5000,
            referral_to: phone
          });
          await inviter.save();
        }
      }
    }

    res.status(200).send('Đã xử lý xong');
  } catch (err) {
    res.status(500).send('Lỗi webhook');
  }
});

// === API: ĐỔI ĐIỂM LẤY VOUCHER ===
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

    const haravanResponse = await axios.post(
      `https://${SHOP}/admin/discounts.json`,
      {
        discount: {
          code: code,
          discount_type: "fixed_amount",
          value: discountValue,
          minimum_order_amount: 0,
          starts_at: new Date().toISOString(),
          usage_limit: 1,
          customer_selection: "prerequisite",
          prerequisite_customer_emails: [user.email]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
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
      message: '🎉 Đổi điểm thành công',
      code,
      value: `${discountValue}đ`,
      haravan_discount: haravanResponse.data.discount
    });
  } catch (err) {
    res.status(500).json({ error: 'Không tạo được voucher' });
  }
});

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
});
