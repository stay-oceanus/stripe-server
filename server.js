const express = require('express');
const cors = require('cors');
const stripeLib = require('stripe');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const gasWebhookUrl = process.env.GAS_WEBHOOK_URL;
const port = process.env.PORT || 4242;

if (!stripeSecretKey) {
  throw new Error('Missing STRIPE_SECRET_KEY in environment variables.');
}

const stripe = stripeLib(stripeSecretKey);

app.use(cors());

async function forwardEventToGas(payload) {
  if (!gasWebhookUrl) {
    console.warn('GAS webhook URL is not configured; skipping forward.');
    return;
  }

  const response = await fetch(gasWebhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to forward event to GAS (${response.status}): ${text}`
    );
  }
}

// ✅ Webhookは raw ボディを使う必要があるので最初に定義する
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

      event = stripe.webhooks.constructEvent(
        req.body, // Bufferのまま
        signature,
        webhookSecret
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        // ✅ checkout.session.completed の時点では:
        // カード: 支払い完了
        // コンビニ: 支払い待ち
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
        // ✅ コンビニ支払い完了時
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
        // ✅ コンビニ支払い期限切れ・キャンセル時
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

// ✅ 他のルートは JSON パーサーを使う
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));

// ✅ Checkout セッション作成エンドポイント
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { amount, email } = req.body;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // 👇 フロントから metadata[xxx] 形式で送られてくるので req.body.metadata に展開される
    const metadata = req.body.metadata || {};

    // email, phone, total など直下で送られてくる可能性がある項目は補完
    metadata.email = metadata.email || req.body.email || '';
    metadata.phone = metadata.phone || req.body.tel || '';
    metadata.total = metadata.total || req.body.amount || '';
    metadata.detail = metadata.detail || '';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'konbini'], // ✅ カード＋コンビニ払い
      line_items: [
        {
          price_data: {
            currency: 'jpy',
            product_data: { name: '宿泊予約' },
            unit_amount: Number(amount), // ✅ 円単位
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      customer_email: email || undefined,
      success_url: 'https://stay-oceanus.com/payment_success.html',
      cancel_url: 'https://stay-oceanus.com/payment_cancel.html',
      metadata, // 👈 ここに正しくチェックイン情報などが渡る
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ ヘルスチェック
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});