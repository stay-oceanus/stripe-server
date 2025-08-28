require('dotenv').config();
const cors = require('cors');
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;
const GAS_ENDPOINT =
  'https://script.google.com/macros/s/AKfycbx4dsZBMZIaVc1N2ueDxI2jrCvdfXOxbVRvv-3BmMX-x4vUnnF-VXqyPaYT3pTZvUxf/exec';

// ✅ CORS 許可ドメイン
const allowedOrigins = [
  'https://stay-oceanus.com',
  'http://localhost:5500'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS: ' + origin));
    }
  }
}));

// ✅ Stripe Webhookだけは raw body を必要とするので先に分岐
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook Error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ 決済完了（カード決済やコンビニ支払いの開始）
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log("📝 session.metadata:", session.metadata);

    try {
      const payload = {
        type: event.type,
        data: { object: session },
        payment_status: session.payment_status,
        payment_method: session.payment_method_types?.[0] || ''
      };

      const response = await fetch(GAS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      console.log('✅ GAS response:', await response.text());
    } catch (error) {
      console.error('❌ GAS送信失敗:', error);
    }
  }

  // ✅ コンビニ支払い完了
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const customerEmail =
      paymentIntent.receipt_email || paymentIntent.metadata?.email || '';

    console.log('💰 コンビニ支払い完了 email:', customerEmail);

    try {
      const successResponse = await fetch(GAS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'konbini_paid',
          email: customerEmail,
          payment_intent: paymentIntent.id
        })
      });
      console.log(
        '✅ コンビニ支払い完了をGASに送信:',
        await successResponse.text()
      );
    } catch (error) {
      console.error('❌ コンビニ支払い完了送信失敗:', error);
    }
  }

  // ✅ コンビニ支払いの期限切れ → キャンセル
  if (event.type === 'payment_intent.canceled') {
    const paymentIntent = event.data.object;
    const customerEmail = paymentIntent.receipt_email || paymentIntent.metadata?.email || '';

    console.log("🗑 キャンセル処理対象 email:", customerEmail);

    try {
      const cancelResponse = await fetch(GAS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cancel_reservation',
          email: customerEmail,
          payment_intent: paymentIntent.id
        })
      });
      console.log('✅ キャンセル通知をGASに送信:', await cancelResponse.text());
    } catch (error) {
      console.error('❌ GASキャンセル送信失敗:', error);
    }
  }

  res.status(200).send('Received');
});

// ✅ JSONのパース（Webhook以外）
app.use(express.json());

// ✅ チェックアウトセッション作成
app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'konbini'],
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: { name: 'Cottage SERAGAKI 宿泊予約' },
          unit_amount: req.body.amount || 25000,
        },
        quantity: 1,
      }],
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
        kanaLastName: req.body.kanaLastName || '',
        kanaFirstName: req.body.kanaFirstName || '',
        kanjiLastName: req.body.kanjiLastName || '',
        kanjiFirstName: req.body.kanjiFirstName || '',
        email: req.body.email || '',
        phone: req.body.tel || '',
        total: req.body.amount || '',
        detail: req.body.detail || ''
      }
    });
    res.json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 動作確認ページ
app.get('/success', (req, res) => res.send('決済が完了しました。'));
app.get('/cancel', (req, res) => res.send('決済がキャンセルされました。'));

// ✅ サーバー起動
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
