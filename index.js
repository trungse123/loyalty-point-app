const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

const SHOP = 'neko-chin-shop-5.myharavan.com';
const ACCESS_TOKEN = 'DFE528F8C4CBA1B43727A729CD57187766E059E88AE96682DC2CF04AF4F61306';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://admin:admin1234@cluster0.edubkxs.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

// === MONGODB CONNECT ===
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true, useUnifiedTopology: true
});
app.use(cors());
app.use(express.json());

// === SCHEMA ===
const UserPointsSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  email: String,
  total_points: { type: Number, default: 0 },
  referred_by: String, // <-- Trường này lưu mã người giới thiệu
  history: [
    {
      order_id: String,
      earned_points: Number,
      timestamp: Date
    }
  ],
  missions: [
    {
      mission_key: String,
      date: Date,
      points: Number,
      referral_by: String,
      referral_to: String
    }
  ]
});
const UserPoints = mongoose.model('UserPoints', UserPointsSchema);

// === NHIỆM VỤ HỆ THỐNG (giữ logic cũ) ===
const MissionList = [
  { key: 'daily_login', type: 'daily', name: 'Đăng nhập mỗi ngày', points: 100, max_per_day: 1,
    check: async (user) => true },
  { key: 'share_fb', type: 'daily', name: 'Chia sẻ website lên Facebook', points: 150, max_per_day: 1,
    check: async (user) => true },
  { key: 'review_product', type: 'daily', name: 'Đánh giá sản phẩm', points: 300, max_per_day: 3,
    check: async (user) => false // TODO: Tích hợp thực tế
  },
  { key: 'monthly_order', type: 'monthly', name: 'Hoàn thành 5 đơn hàng trong tháng', points: 2000, max_per_month: 1,
    check: async (user) => {
      const now = new Date();
      const thisMonthOrders = (user.history||[]).filter(h =>
        h.timestamp.getMonth() === now.getMonth() &&
        h.timestamp.getFullYear() === now.getFullYear() &&
        !h.order_id.startsWith('REDEEM')
      );
      return thisMonthOrders.length >= 5;
    }
  },
  { key: 'monthly_review', type: 'monthly', name: 'Đánh giá 5 sản phẩm trong tháng', points: 1500, max_per_month: 1,
    check: async (user) => false // TODO
  },
  { key: 'referral', type: 'special', name: 'Mời bạn bè đặt đơn đầu tiên (cả 2 cùng nhận)', points: 5000, max_per_day: 10,
    check: async (user, { referral_code }) => false // CHỐT: xử lý bằng webhook đơn hàng!
  }
];

// === API nhập mã giới thiệu: chỉ lưu mã, không cộng điểm ===
app.post('/referral-code', async (req, res) => {
  const { phone, referral_code } = req.body;
  if (!phone || !referral_code || phone === referral_code)
    return res.status(400).json({ error: 'Mã không hợp lệ!' });
  let user = await UserPoints.findOne({ phone });
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user!' });
  if (user.referred_by)
    return res.status(400).json({ error: 'Bạn đã nhập mã giới thiệu trước đó!' });
  user.referred_by = referral_code;
  await user.save();
  res.json({ message: 'Nhập mã thành công! Khi bạn đặt đơn đầu tiên, cả 2 sẽ nhận điểm.' });
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

  const missionStates = await Promise.all(MissionList.map(async mission => {
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
    if (mission.type === 'special') {
      // Check nếu user đã từng nhận mời bạn trong ngày
      const count = (user.missions || []).filter(m =>
        m.mission_key === mission.key &&
        new Date(m.date).toLocaleDateString() === today
      ).length;
      return { ...mission, completed_today: count >= (mission.max_per_day || 10) };
    }
    return mission;
  }));
  res.json(missionStates);
});

// === API: HOÀN THÀNH NHIỆM VỤ === (giữ logic cũ, nhiệm vụ referral sẽ không nhận được bằng API này)
app.post('/missions/complete', async (req, res) => {
  const { phone, mission_key, referral_code } = req.body;
  const mission = MissionList.find(m => m.key === mission_key);
  if (!mission) return res.status(400).json({ error: 'Nhiệm vụ không tồn tại' });

  // Không cho phép nhận nhiệm vụ referral qua API
  if (mission.key === 'referral') {
    return res.status(400).json({ error: 'Hãy nhập mã giới thiệu và mua đơn đầu tiên để nhận điểm nhiệm vụ này!' });
  }

  const user = await UserPoints.findOne({ phone });
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });

  const now = new Date();

  let isEligible = false;
  try {
    isEligible = await mission.check(user, { referral_code });
  } catch { isEligible = false; }
  if (!isEligible) return res.status(400).json({ error: 'Bạn chưa hoàn thành đủ điều kiện nhiệm vụ!' });

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

// === WEBHOOK: ĐƠN HÀNG HARAVAN – Xử lý nhiệm vụ referral tại đây! ===
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

    if (!phone || !paid || !fulfilled)
      return res.status(200).send('❌ Bỏ qua đơn không hợp lệ');
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

    // ====== XỬ LÝ NHIỆM VỤ REFERRAL (CHỈ CỘNG 1 LẦN, đơn đầu tiên) ======
    if (user.referred_by) {
      const nonRedeemOrders = (user.history || []).filter(h => !h.order_id.startsWith('REDEEM'));
      const alreadyReferralMission = (user.missions || []).find(m => m.mission_key === 'referral');
      if (nonRedeemOrders.length === 1 && !alreadyReferralMission) {
        // Cộng điểm cho người được mời
        user.total_points += 5000;
        user.missions = user.missions || [];
        user.missions.push({ mission_key: 'referral', date: new Date(), points: 5000, referral_by: user.referred_by });
        await user.save();
        // Cộng điểm cho người mời
        if (user.referred_by && user.referred_by !== user.phone) {
          const inviter = await UserPoints.findOne({ phone: user.referred_by });
          if (inviter) {
            const alreadyGot = (inviter.missions || []).find(m => m.mission_key === 'referral' && m.referral_to === user.phone);
            if (!alreadyGot) {
              inviter.total_points += 5000;
              inviter.missions = inviter.missions || [];
              inviter.missions.push({ mission_key: 'referral', date: new Date(), points: 5000, referral_to: user.phone });
              await inviter.save();
            }
          }
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
