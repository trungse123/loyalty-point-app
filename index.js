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
      mission_key: String,   // daily_login, review_product, share_fb...
      date: Date,            // Lần cuối hoàn thành
      points: Number         // Số điểm được cộng
    }
  ]
});
const UserPoints = mongoose.model('UserPoints', UserPointsSchema);

// === BẢNG NHIỆM VỤ (có thể chỉnh điểm tùy ý) ===
const MissionList = [
  // --- NHIỆM VỤ HÀNG NGÀY ---
  { key: 'daily_login',      type: 'daily',    name: 'Đăng nhập mỗi ngày',        points: 100,   max_per_day: 1 },
  { key: 'share_fb',         type: 'daily',    name: 'Chia sẻ website lên Facebook', points: 150,   max_per_day: 1 },
  { key: 'review_product',   type: 'daily',    name: 'Đánh giá sản phẩm',         points: 300,   max_per_day: 3 },
  // --- NHIỆM VỤ THÁNG ---
  { key: 'monthly_order',    type: 'monthly',  name: 'Hoàn thành 5 đơn hàng trong tháng', points: 2000,  max_per_month: 1 },
  { key: 'monthly_review',   type: 'monthly',  name: 'Đánh giá 5 sản phẩm trong tháng',   points: 1500,  max_per_month: 1 },
  // --- NHIỆM VỤ ĐẶC BIỆT ---
  { key: 'referral',         type: 'special',  name: 'Mời bạn bè đặt đơn đầu tiên (cả 2 cùng nhận)',  points: 5000,  max_per_day: 10 },
  // ... thêm nhiệm vụ sự kiện tuỳ thích ...
];

// === GIỮ TOÀN BỘ LOGIC CŨ, BỔ SUNG API NHIỆM VỤ BÊN DƯỚI ===

// === WEBHOOK: ĐƠN HÀNG HARAVAN ===
app.post('/webhook/order', async (req, res) => {
  try {
    console.log('📦 [Webhook] Nhận dữ liệu từ Haravan:');
    console.dir(req.body, { depth: null });

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
      console.log(`⚠️ Bỏ qua đơn không hợp lệ\nSĐT: ${phone}\nThanh toán: ${order.financial_status}\nGiao hàng: ${order.fulfillment_status}`);
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

    // === Kiểm tra nhiệm vụ đặc biệt: Referral (Bạn bè mời nhau) ===
    // Bạn có thể truyền referral_code (sdt của người mời) trong order.note_attributes hoặc order.referral_code
    // Mỗi khi người được mời hoàn thành đơn đầu tiên => cả 2 cùng nhận
    const refAttr = (order.note_attributes || []).find(x => x.name === 'referral_code');
    const referral_code = refAttr?.value || order.referral_code; // Ví dụ bạn lưu mã giới thiệu là SĐT người mời

    if (referral_code && referral_code !== phone) {
      // Kiểm tra người này đã từng được mời bởi referral_code chưa
      const alreadyGot = user.missions?.find(m => m.mission_key === 'referral' && m.date && m.referral_by === referral_code);
      if (!alreadyGot) {
        // Cộng điểm cho người được mời
        user.total_points += 5000;
        user.missions = user.missions || [];
        user.missions.push({
          mission_key: 'referral',
          date: new Date(),
          points: 5000,
          referral_by: referral_code
        });
        await user.save();

        // Cộng điểm cho người mời (referral_code là sdt)
        const inviter = await UserPoints.findOne({ phone: referral_code });
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

    console.log(`✅ Cộng ${points} điểm cho: ${phone}`);
    res.status(200).send('Đã xử lý xong');
  } catch (err) {
    console.error('❌ Webhook lỗi:', err.message);
    res.status(500).send('Lỗi webhook');
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
      missions: user.missions || []
    });
  } catch (err) {
    console.error('❌ Lỗi tra điểm:', err.message);
    res.status(500).json({ error: 'Không thể lấy dữ liệu điểm' });
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

          // ✅ Giới hạn mã
          usage_limit: 1, // chỉ dùng 1 lần
          customer_selection: "prerequisite", // chỉ định người dùng
          prerequisite_customer_emails: [user.email] // chỉ cho email này dùng
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
    console.error('❌ Lỗi đổi điểm:', err.response?.data || err.message);
    res.status(500).json({ error: 'Không tạo được voucher' });
  }
});

// === API: LẤY DANH SÁCH NHIỆM VỤ + TRẠNG THÁI NGƯỜI DÙNG ===
app.get('/missions', async (req, res) => {
  const { phone } = req.query;
  const user = await UserPoints.findOne({ phone });
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });

  // Mapping trạng thái hoàn thành
  const today = new Date().toLocaleDateString();
  const thisMonth = `${new Date().getMonth() + 1}-${new Date().getFullYear()}`;

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
        (new Date(m.date).getMonth() + 1) === (new Date().getMonth() + 1) &&
        (new Date(m.date).getFullYear()) === (new Date().getFullYear())
      ).length;
      return { ...mission, completed_this_month: count >= (mission.max_per_month || 1) };
    }
    if (mission.type === 'special') {
      // Tuỳ ý, không hạn chế
      return { ...mission };
    }
    return mission;
  });
  res.json(missionStates);
});

// === API: HOÀN THÀNH NHIỆM VỤ (BẤT KỲ) ===
app.post('/missions/complete', async (req, res) => {
  const { phone, mission_key } = req.body;
  const mission = MissionList.find(m => m.key === mission_key);
  if (!mission) return res.status(400).json({ error: 'Nhiệm vụ không tồn tại' });

  const user = await UserPoints.findOne({ phone });
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });

  const now = new Date();

  // Logic kiểm tra giới hạn
  if (mission.type === 'daily') {
    const doneToday = (user.missions || []).filter(m =>
      m.mission_key === mission_key &&
      new Date(m.date).toLocaleDateString() === now.toLocaleDateString()
    ).length;
    if (doneToday >= (mission.max_per_day || 1)) {
      return res.json({ message: 'Đã nhận thưởng nhiệm vụ hôm nay!' });
    }
  }
  if (mission.type === 'monthly') {
    const doneThisMonth = (user.missions || []).filter(m =>
      m.mission_key === mission_key &&
      (new Date(m.date).getMonth() + 1) === (now.getMonth() + 1) &&
      (new Date(m.date).getFullYear()) === (now.getFullYear())
    ).length;
    if (doneThisMonth >= (mission.max_per_month || 1)) {
      return res.json({ message: 'Đã nhận thưởng nhiệm vụ tháng!' });
    }
  }

  user.total_points += mission.points;
  user.missions = user.missions || [];
  user.missions.push({ mission_key, date: now, points: mission.points });
  await user.save();

  res.json({ message: 'Nhận thưởng thành công', points: mission.points, total_points: user.total_points });
});

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
});
