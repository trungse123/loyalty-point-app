const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// === CONFIG ===
const SHOP = 'neko-chin-shop-5.myharavan.com';
const ACCESS_TOKEN = '8D69E2B91FDF0D073CAC0126CCA36B924276EB0DFF55C7F76097CFD8283920BE';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://admin:admin1234@cluster0.edubkxs.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const REVIEW_BACKEND_URL = 'https://review-backend-dukv.onrender.com'; // <-- THÊM DÒNG NÀY

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
      timestamp: Date,
      meta: Object
    }
  ],
   missions: [
    { 
      mission_key: String,
      date: Date,
      points: Number
    }
  ]
});
const UserPoints = mongoose.model('UserPoints', UserPointsSchema);
const MissionList = [
    // --- Daily Missions ---
    {
        key: 'daily_login', type: 'daily', name: 'Đăng nhập mỗi ngày',
        points: 300, limit_per_day: 1, check: async () => true // Luôn đủ điều kiện, quan trọng là đã nhận chưa
    },
    {
        key: 'share_fb', type: 'daily', name: 'Chia sẻ website lên Facebook',
        points: 500, limit_per_day: 1, check: async () => true // Luôn đủ điều kiện, quan trọng là đã nhận chưa
    },
    {
        key: 'review_product', type: 'daily', name: 'Đánh giá sản phẩm đã mua',
        points: 800, limit_per_day: 3, check: async () => true // Logic check được thực hiện trong API /missions dựa vào số review thực tế
    },
    // --- Monthly Milestone Missions ---
    {
        key: 'monthly_login_10', type: 'monthly', name: 'Đăng nhập 10 ngày trong tháng',
        points: 1000, limit_per_month: 1,
        check: async (user) => {
            const now = new Date();
            const missionsInMonth = (user.missions || []).filter(m =>
                m.mission_key === 'daily_login' &&
                new Date(m.date).getMonth() === now.getMonth() &&
                new Date(m.date).getFullYear() === now.getFullYear()
            );
            const uniqueDays = new Set(missionsInMonth.map(m => new Date(m.date).getDate()));
            return uniqueDays.size >= 10;
        }
    },
    {
        key: 'monthly_login_15', type: 'monthly', name: 'Đăng nhập 15 ngày trong tháng',
        points: 2000, limit_per_month: 1,
        check: async (user) => {
            const now = new Date();
            const missionsInMonth = (user.missions || []).filter(m =>
                m.mission_key === 'daily_login' &&
                new Date(m.date).getMonth() === now.getMonth() &&
                new Date(m.date).getFullYear() === now.getFullYear()
            );
            const uniqueDays = new Set(missionsInMonth.map(m => new Date(m.date).getDate()));
            return uniqueDays.size >= 15;
        }
    },
    {
        key: 'monthly_review_5', type: 'monthly', name: 'Đánh giá 5 sản phẩm trong tháng',
        points: 1000, limit_per_month: 1,
        check: async (user) => {
            // Logic check này sẽ được tính dựa trên actualReviewsMonthlyCount trong API /missions
            // và không cần thực hiện lại ở đây
            return true;
        }
    }
];

// === API: LẤY TRẠNG THÁI NHIỆM VỤ ===
app.get('/missions', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'Thiếu số điện thoại' });

    let user = await UserPoints.findOne({ phone });
    const isNewUser = !user;
    if (isNewUser) {
        user = { phone, missions: [], total_points: 0 };
    }

    const now = new Date();
    const todayStr = now.toLocaleDateString('vi-VN');

    const missionsInMonth = (user.missions || []).filter(m =>
        new Date(m.date).getMonth() === now.getMonth() &&
        new Date(m.date).getFullYear() === now.getFullYear()
    );

    const dailyLoginsInMonth = missionsInMonth.filter(m => m.mission_key === 'daily_login');
    const uniqueLoginDays = new Set(dailyLoginsInMonth.map(m => new Date(m.date).getDate())).size;

    // --- LẤY SỐ LƯỢNG ĐÁNH GIÁ THỰC TẾ TỪ BACKEND ĐÁNH GIÁ ---
    let actualReviewsTodayCount = 0;
    let actualReviewsMonthlyCount = 0;
    try {
        const reviewResponse = await axios.get(`${REVIEW_BACKEND_URL}/api/review/count?phone=${phone}`);
        if (reviewResponse.data) {
            actualReviewsTodayCount = reviewResponse.data.today || 0;
            actualReviewsMonthlyCount = reviewResponse.data.monthly || 0;
        }
    } catch (error) {
        console.error('Lỗi khi lấy số lượng review từ Backend Đánh giá:', error.message);
    }
    // -----------------------------------------------------------

    const missionStates = await Promise.all(MissionList.map(async (mission) => {
        let claimed_count = 0; // Số lần đã nhận thưởng (đã được ghi vào user.missions)
        let limit = 0; // Giới hạn số lần có thể nhận thưởng
        let progress = 0; // Tiến độ hiện tại của nhiệm vụ (ví dụ: 1)
        let progress_limit = 0; // Giới hạn tiến độ (ví dụ: 3)
        let can_claim = false; // Flag để frontend biết có thể nhấn nút "Nhận thưởng" không

        if (mission.type === 'daily') {
            claimed_count = (user.missions || []).filter(m =>
                m.mission_key === mission.key &&
                new Date(m.date).toLocaleDateString('vi-VN') === todayStr
            ).length;
            limit = mission.limit_per_day || 1;

            if (mission.key === 'review_product') {
                progress = actualReviewsTodayCount;
                progress_limit = limit; // 3
                // can_claim: Có thể nhận nếu số review thực tế lớn hơn số lần đã nhận thưởng
                // VÀ số lần đã nhận thưởng chưa đạt giới hạn
                can_claim = (actualReviewsTodayCount > claimed_count) && (claimed_count < limit);
            } else { // Đối với 'daily_login' và 'share_fb'
                progress = claimed_count;
                progress_limit = limit;
                // can_claim: Có thể nhận nếu điều kiện check của nhiệm vụ là true VÀ chưa nhận thưởng đủ giới hạn
                can_claim = (await mission.check(user)) && (claimed_count < limit);
            }

        } else if (mission.type === 'monthly') {
            claimed_count = missionsInMonth.filter(m => m.mission_key === mission.key).length;
            limit = mission.limit_per_month || 1; // Thường là 1 cho nhiệm vụ tháng

            if (mission.key.startsWith('monthly_login_')) {
                progress = uniqueLoginDays;
                progress_limit = parseInt(mission.key.split('_').pop()); // 10 hoặc 15
                // can_claim: Có thể nhận nếu điều kiện check của nhiệm vụ là true VÀ chưa nhận thưởng đủ giới hạn
                can_claim = (await mission.check(user)) && (claimed_count < limit);
            } else if (mission.key === 'monthly_review_5') {
                progress = actualReviewsMonthlyCount; // Sử dụng số lượng review thực tế trong tháng
                progress_limit = parseInt(mission.key.split('_').pop()); // 5
                // can_claim: Có thể nhận nếu số review thực tế đạt ngưỡng VÀ chưa nhận thưởng đủ giới hạn
                can_claim = (actualReviewsMonthlyCount >= progress_limit) && (claimed_count < limit);
            }
        }
        
        // Xác định trạng thái cuối cùng cho frontend
        let status_for_frontend = 'not_completed';
        if (claimed_count >= limit) {
            status_for_frontend = 'claimed'; // Đã nhận thưởng hết số lần cho phép
        } else if (can_claim) {
            status_for_frontend = 'available_to_claim'; // Đủ điều kiện để nhấn nút "Nhận thưởng"
        }

        return {
            key: mission.key,
            name: mission.name,
            points: mission.points,
            type: mission.type,
            status: status_for_frontend, // 'claimed', 'available_to_claim', 'not_completed'
            can_claim: can_claim, // TRUE nếu có thể nhấn nút "Nhận thưởng"
            is_claimed: claimed_count >= limit, // TRUE nếu đã nhận thưởng hết giới hạn (cho những nhiệm vụ chỉ 1 lần)
            progress: progress,
            progress_limit: progress_limit
        };
    }));

    res.json(missionStates);
});


// === WEBHOOK: ĐƠN HÀNG HARAVAN ===
app.post('/webhook/order', async (req, res) => {
  try {
    console.log('📦 [Webhook] Nhận dữ liệu từ Haravan:');
    console.dir(req.body, { depth: null });

    const order = req.body;
    const customer = order.customer || {};
    const billing = order.billing_address || {};
    const phone = customer.phone || billing.phone;
    const email = customer.email || 'Không có email';
    const order_id = order.id?.toString();
    const total = parseInt(order.total_price || 0);
    const points = Math.floor(total / 100);

    const paid = order.financial_status === 'paid';
    const fulfilled = ['fulfilled', 'delivered'].includes(order.fulfillment_status);

    if (!phone || !paid || !fulfilled) {
      console.log(`⚠️ Bỏ qua đơn không hợp lệ\nSĐT: ${phone}\nThanh toán: ${order.financial_status}\nGiao hàng: ${order.fulfillment_status}`);
      return res.status(200).send('❌ Bỏ qua đơn không hợp lệ');
    }

    const user = await UserPoints.findOne({ phone });

    if (user) {
      const existed = user.history.find(h => h.order_id === order_id);
      if (!existed) {
        user.total_points += points;
        user.history.push({ order_id, earned_points: points, timestamp: new Date() });
        await user.save();
      }
    } else {
      await UserPoints.create({
        phone,
        email,
        total_points: points,
        history: [{ order_id, earned_points: points, timestamp: new Date() }]
      });
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
      history: user.history || []
    });
  } catch (err) {
    console.error('❌ Lỗi tra điểm:', err.message);
    res.status(500).json({ error: 'Không thể lấy dữ liệu điểm' });
  }
});
app.post('/missions/complete', async (req, res) => {
    const { phone, mission_key } = req.body;
    if (!phone || !mission_key) return res.status(400).json({ error: 'Thiếu thông tin' });

    const mission = MissionList.find(m => m.key === mission_key);
    if (!mission) return res.status(404).json({ error: 'Nhiệm vụ không tồn tại' });

    const user = await UserPoints.findOne({ phone });
    if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng' });

    const now = new Date();
    
    // Kiểm tra giới hạn hoàn thành nhiệm vụ
    if (mission.type === 'daily') {
        const todayStr = now.toLocaleDateString('vi-VN');
        const completed_count = (user.missions || []).filter(m =>
            m.mission_key === mission.key && new Date(m.date).toLocaleDateString('vi-VN') === todayStr
        ).length;
        
        if (completed_count >= (mission.limit_per_day || 1)) {
            return res.status(400).json({ error: 'Bạn đã hoàn thành nhiệm vụ này hôm nay rồi!' });
        }
    } else if (mission.type === 'monthly') {
        const completed_count = (user.missions || []).filter(m =>
            m.mission_key === mission.key && new Date(m.date).getMonth() === now.getMonth() && new Date(m.date).getFullYear() === now.getFullYear()
        ).length;
        
        if (completed_count >= (mission.limit_per_month || 1)) {
            return res.status(400).json({ error: 'Bạn đã nhận thưởng cho mốc này trong tháng rồi!' });
        }
    }

    // Kiểm tra điều kiện đặc biệt của nhiệm vụ
    const is_eligible = await mission.check(user);
    if (!is_eligible) {
        return res.status(400).json({ error: 'Bạn chưa đủ điều kiện để nhận thưởng.' });
    }

    // Cộng điểm và lưu lịch sử
    user.total_points += mission.points;
    user.missions.push({ mission_key: mission.key, date: new Date(), points: mission.points });
    await user.save();

    res.json({ message: `Chúc mừng! Bạn đã nhận được ${mission.points} điểm.`, total_points: user.total_points });
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
      timestamp: new Date(),
      meta: {
              redeemed_by: admin_user 
            }
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
app.post('/points/adjust', async (req, res) => {
  // Trong thực tế, bạn cần một lớp bảo mật để xác thực admin
  const { phone, points_to_adjust, reason, admin_user } = req.body;

  if (!phone || !points_to_adjust || isNaN(points_to_adjust)) {
    return res.status(400).json({ error: 'Thông tin không hợp lệ.' });
  }

  try {
    const user = await UserPoints.findOne({ phone });
    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
    }

    user.total_points += points_to_adjust;

    const historyEntry = {
      order_id: `ADJUST-${Date.now()}`, // Tạo ID đặc biệt cho hành động điều chỉnh
      earned_points: points_to_adjust,
      timestamp: new Date(),
      meta: {
        reason: reason || 'Điều chỉnh bởi admin',
        admin_user: admin_user || 'Không rõ'
      }
    };

    user.history.push(historyEntry);
    await user.save();

    res.json({
      message: 'Cập nhật điểm thành công!',
      new_total_points: user.total_points,
      history_entry: historyEntry
    });

  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi cập nhật điểm.' });
  }
}),
// === START SERVER ===
app.listen(PORT, () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
});

