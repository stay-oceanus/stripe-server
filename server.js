/**
 * Cottage SERAGAKI - Stripe Server
 * ✅ 本番／テスト切り替え対応
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripeLib = require('stripe');

const app = express();

// === モード切り替え（test / live） ===
const mode = process.env.APP_MODE || 'test';
console.log(`🚀 Running in ${mode.toUpperCase()} mode`);

// === Stripe設定 ===
const stripeSecretKey =
  mode === 'live'
    ? process.env.STRIPE_SECRET_KEY_LIVE
    : process.env.STRIPE_SECRET_KEY_TEST;

const webhookSecret =
  mode === 'live'
    ? process.env.STRIPE_WEBHOOK_SECRET_LIVE
    : process.env.STRIPE_WEBHOOK_SECRET_TEST;

// === GAS Webhook URL ===
const gasWebhookUrl =
  mode === 'live'
    ? process.env.GAS_WEBHOOK_URL_LIVE
    : process.env.GAS_WEBHOOK_URL_TEST;

// === その他環境変数 ===
const port = process.env.PORT || 4242;

// === Stripe初期化 ===
if (!stripeSecretKey) {
  throw new Error('Missing STRIPE_SECRET_KEY in environment variables.');
}
const stripe = stripeLib(stripeSecretKey);

// ===== 売り止め設定（JST基準） =====
const SELL_STOP_HOUR = 12;
const SELL_STOP_MIN  = 0;

// JSTで現在時刻を取得
function nowJST() {
  const now = new Date();
  return new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
}

function isAfterSellStop(now) {
  const h = now.getHours();
  const m = now.getMinutes();
  return (h > SELL_STOP_HOUR) || (h === SELL_STOP_HOUR && m >= SELL_STOP_MIN);
}

function isTomorrowJST(checkinStr) {
  if (!checkinStr) return false;

  const now = nowJST();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  // 🔥 YYYY-MM-DD を安全に分解して生成（UTCズレ防止）
  const [y, m, d] = checkinStr.split('-').map(Number);
  const checkin = new Date(y, m - 1, d);

  return (
    checkin.getFullYear() === tomorrow.getFullYear() &&
    checkin.getMonth() === tomorrow.getMonth() &&
    checkin.getDate() === tomorrow.getDate()
  );
}

app.use(cors());

// ✅ Webhook用：rawボディ保持（署名検証のため）
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;

    try {
      if (!webhookSecret) {
        throw new Error('STRIPE_WEBHOOK_SECRET is not configured.');
      }

      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      // イベントタイプ別処理
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        let paymentMethod = 'card';
        let status = '支払い完了';

        if (session.payment_method_types.includes('konbini')) {
          paymentMethod = 'konbini';
          status = '支払い待ち';
        }

        const payload = {
          type: event.type,
          data: { object: session },
          payment_status: status,
          payment_method: paymentMethod,
        };
        await forwardEventToGas(payload);
      } else if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const sessions = await stripe.checkout.sessions.list({
          payment_intent: paymentIntent.id,
          limit: 1,
        });
        const session = sessions.data[0];
        if (session) {
          const payload = {
            type: 'payment_intent.succeeded',
            data: { object: session },
            payment_status: '支払い完了',
            payment_method: 'konbini',
          };
          await forwardEventToGas(payload);
        }
      } else if (event.type === 'payment_intent.canceled') {
        const paymentIntent = event.data.object;
        const customerEmail =
          paymentIntent.receipt_email || paymentIntent.metadata?.email || '';
        const payload = {
          type: 'payment_intent.canceled',
          email: customerEmail,
          payment_intent: paymentIntent.id,
          payment_status: 'キャンセル',
          payment_method: 'konbini',
        };
        await forwardEventToGas(payload);
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Failed to forward event to GAS:', err.message);
      res.status(500).send(`Forward Error: ${err.message}`);
    }
  }
);

// ✅ 他のルートは通常JSONパーサー
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));

// ✅ GAS転送関数
async function forwardEventToGas(payload) {
  if (!gasWebhookUrl) {
    console.warn('⚠️ GAS webhook URL not configured.');
    return;
  }

  console.log(`📤 Forwarding event to GAS (${mode})...`);
  const response = await fetch(gasWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GAS responded with error: ${text}`);
  }

  console.log('✅ Event successfully forwarded to GAS.');
}

// ✅ Checkout セッション作成
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { amount, email } = req.body;
    const metadata = req.body.metadata || {};
    const checkin = metadata.checkin;

    const now = nowJST();

    // ✅ 明日チェックイン＋12:00以降はブロック
    if (isTomorrowJST(checkin) && isAfterSellStop(now)) {
      return res.status(400).json({
        error: "翌日のチェックインは本日12:00以降は受付できません。"
      });
    }
    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    metadata.email = metadata.email || req.body.email || '';
    metadata.phone = metadata.phone || req.body.tel || '';
    metadata.total = metadata.total || req.body.amount || '';
    metadata.detail = metadata.detail || '';

    // ✅ コンビニ決済一時停止中（カードのみ）
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'konbini'],
      line_items: [
        {
          price_data: {
            currency: 'jpy',
            product_data: { name: '宿泊予約' },
            unit_amount: Number(amount),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      customer_email: email || undefined,
      success_url: 'https://stay-oceanus.com/payment_success.html',
      cancel_url: 'https://stay-oceanus.com/payment_cancel.html',
      metadata,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ カスタムセッション作成
app.post('/create-custom-session', async (req, res) => {
  try {
    const { comment, checkin, checkout, amount, email } = req.body;
    const metadata = { comment, checkin, checkout, createdBy: 'custom' };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'jpy',
            product_data: { name: '個別予約' },
            unit_amount: Number(amount),
          },
          quantity: 1,
        },
      ],
      metadata,
      success_url: 'https://stay-oceanus.com/success.html',
      cancel_url: 'https://stay-oceanus.com/cancel.html',
    });

    // ✅ GASへ転送（仮登録）
    await fetch(gasWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'provisional_reservation',
        sessionId: session.id,
        reservation_json: JSON.stringify({
          comment,
          checkin,
          checkout,
          amount,
          email,
          createdBy: 'custom',
        }),
      }),
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Custom session error:', error.stack);
    res.status(500).json({ error: 'Session creation failed' });
  }
});

// ✅ ヘルスチェック
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode });
});

// ✅ サーバー起動
app.listen(port, () => {
  console.log(`🌐 Server listening on port ${port}`);
});