require('dotenv').config(); // ← 必ず最初に追加！
const cors = require('cors');
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;

// ✅ 許可するオリジンを明示
const allowedOrigins = [
  'https://stay-oceanus.com',
  'http://localhost:5500'
];

app.use(cors({
  origin: function (origin, callback) {
    // 開発時（ファイル直開き）など origin が null の場合も許可
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS: ' + origin));
    }
  }
}));

app.use(express.json());

app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'konbini'],
      line_items: [
        {
          price_data: {
            currency: 'jpy',
            product_data: { name: 'Cottage SERAGAKI 宿泊予約' },
            unit_amount: req.body.amount || 25000, // ✅ ← 100倍しない
          },
          quantity: 1,
        }
      ],
      mode: 'payment',
      success_url: 'https://stay-oceanus.com/payment_success.html',
      cancel_url: 'https://stay-oceanus.com/payment_cancel.html',
      customer_email: req.body.email || undefined,
      metadata: {
        checkin: req.body.checkin || '',
        checkout: req.body.checkout || '',
        nights: req.body.nights || '',
        adults: req.body.adults || '',
        child11: req.body.child11 || '',
        child6: req.body.child6 || '',
        child3: req.body.child3 || '',
        kana: req.body.kana || '',
        kanji: req.body.kanji || '',
        tel: req.body.tel || '',
        detail: req.body.detail || ''
      }
    });
    res.json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/success', (req, res) => {
  res.send('決済が完了しました。ご予約ありがとうございました。');
});
app.get('/cancel', (req, res) => {
  res.send('決済がキャンセルされました。');
});

// ✅ listen は最後に1回だけ！
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});