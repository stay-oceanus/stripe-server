/**
 * Cottage SERAGAKI - Stripe Server
 * ✅ 本番／テスト切り替え対応
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripeLib = require('stripe');
const crypto = require('crypto');

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

// ===== Beds24 API V2 =====
const BEDS24_BASE_URL = process.env.BEDS24_BASE_URL || 'https://api.beds24.com/v2';
const BEDS24_REFRESH_TOKEN = process.env.BEDS24_REFRESH_TOKEN;
const BEDS24_PROPERTY_ID = process.env.BEDS24_PROPERTY_ID;
const BEDS24_ROOM_ID = process.env.BEDS24_ROOM_ID;

let beds24TokenCache = null;
let beds24TokenFetchedAt = 0;

async function beds24GetAccessToken() {
  if (!BEDS24_REFRESH_TOKEN) throw new Error('Missing BEDS24_REFRESH_TOKEN');

  const now = Date.now();
  // tokenは24時間。安全側に23時間で更新
  if (beds24TokenCache && now - beds24TokenFetchedAt < 23 * 60 * 60 * 1000) {
    return beds24TokenCache;
  }

  const r = await fetch(`${BEDS24_BASE_URL}/authentication/token`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      refreshToken: BEDS24_REFRESH_TOKEN,
    },
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Beds24 /authentication/token failed: ${r.status} ${text}`);
  }

  const json = JSON.parse(text);
  const token = json.token;
  if (!token) throw new Error(`Beds24 token missing: ${text}`);

  beds24TokenCache = token;
  beds24TokenFetchedAt = now;
  return token;
}

// === Stripe初期化 ===
if (!stripeSecretKey) {
  throw new Error('Missing STRIPE_SECRET_KEY in environment variables.');
}
const stripe = stripeLib(stripeSecretKey);

// ===== 売り止め設定（JST基準） =====
const SELL_STOP_HOUR = 12;
const SELL_STOP_MIN = 0;

// JSTで現在時刻を取得
function nowJST() {
  const now = new Date();
  return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

function isAfterSellStop(now) {
  const h = now.getHours();
  const m = now.getMinutes();
  return h > SELL_STOP_HOUR || (h === SELL_STOP_HOUR && m >= SELL_STOP_MIN);
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

function isAtLeast48HoursBeforeCheckinJST(checkinStr) {
  if (!checkinStr) return false;

  const now = nowJST();

  // チェックインは15:00基準（JST）
  const [y, m, d] = checkinStr.split('-').map(Number);
  const checkin = new Date(y, m - 1, d, 15, 0, 0); // JSTローカル扱い

  const diffMs = checkin.getTime() - now.getTime();
  return diffMs >= 48 * 60 * 60 * 1000;
}

app.use(cors());

// ✅ Webhook用：rawボディ保持（署名検証のため）
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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

      const pmTypes = session.payment_method_types || [];
      const paymentMethod = pmTypes.includes('konbini') ? 'konbini' : 'card';

      // ✅ ステータス（GASにこのまま渡して整合性を作る）
      // konbini: unpaidなら支払い待ち
      // card: manual captureだと paid にならないので 仮予約
      let status = '支払い完了';

      if (paymentMethod === 'konbini') {
        status = session.payment_status === 'paid' ? '支払い完了' : '支払い待ち';
      } else {
        status = session.payment_status === 'paid' ? '支払い完了' : '仮予約';
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
        const pmTypes = session.payment_method_types || [];
        const paymentMethod = pmTypes.includes('konbini') ? 'konbini' : 'card';

        const payload = {
          type: 'payment_intent.succeeded',
          data: { object: session },
          payment_status: '支払い完了',
          payment_method: paymentMethod,
        };
        await forwardEventToGas(payload);
      }
    } else if (event.type === 'payment_intent.canceled') {
      const paymentIntent = event.data.object;
      const customerEmail = paymentIntent.receipt_email || paymentIntent.metadata?.email || '';

      const payload = {
        type: 'payment_intent.canceled',
        email: customerEmail,
        payment_intent: paymentIntent.id,
        payment_status: 'キャンセル',
        payment_method: 'konbini',
      };
      await forwardEventToGas(payload);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Failed to forward event to GAS:', err.message);
    return res.status(500).send(`Forward Error: ${err.message}`);
  }
});

// ✅ 他のルートは通常JSONパーサー
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));

// ===== Beds24 Booking Webhook 受信 =====
const BEDS24_WEBHOOK_TOKEN = process.env.BEDS24_WEBHOOK_TOKEN || '';

// ✅ Beds24 webhook 疎通チェック（ブラウザ用GET）
app.get('/beds24/webhook/booking', (req, res) => {
  const token = String(req.query.token || '');
  if (!BEDS24_WEBHOOK_TOKEN) {
    return res.status(500).send('BEDS24_WEBHOOK_TOKEN missing');
  }
  if (token !== BEDS24_WEBHOOK_TOKEN) {
    return res.status(403).send('Forbidden (token mismatch)');
  }
  return res.status(200).send('OK (token verified)');
});

// Beds24 API: bookingId で詳細を取る（取れない場合は期間で拾う）
async function beds24GetBookingDetail({ bookingId, from, to }) {
  const token = await beds24GetAccessToken();

  const url = new URL(`${BEDS24_BASE_URL}/bookings`);

  // property/room はあなたの設計通り固定でもOK（1棟なら特に）
  if (BEDS24_PROPERTY_ID) url.searchParams.set('propertyId', String(BEDS24_PROPERTY_ID));
  if (BEDS24_ROOM_ID) url.searchParams.set('roomId', String(BEDS24_ROOM_ID));

  // まず bookingId が取れるならそれ優先（最小取得）
  if (bookingId) url.searchParams.set('bookingId', String(bookingId));

  // bookingId が無い/効かない時の保険：from/to
  if (from) url.searchParams.set('from', String(from));
  if (to) url.searchParams.set('to', String(to));

  const r = await fetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json', token }
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Beds24 /bookings failed: ${r.status} ${text}`);
  return JSON.parse(text);
}

app.post('/beds24/webhook/booking', async (req, res) => {
  try {
    // 1) 超簡易認証（URLトークン）
    const token = String(req.query.token || '');
    if (BEDS24_WEBHOOK_TOKEN && token !== BEDS24_WEBHOOK_TOKEN) {
      return res.status(403).send('Forbidden');
    }

    // 2) 受信ボディ（Beds24の実際の形に依存するので、まずログ）
    const body = req.body || {};
    console.log('📩 Beds24 webhook received:', JSON.stringify(body).slice(0, 2000));

    // 3) bookingId をできるだけ拾う（形が違っても耐える）
    const bookingId =
      body.bookingId ||
      body.bookingID ||
      body.id ||
      (Array.isArray(body.bookingIds) ? body.bookingIds[0] : null) ||
      (body.booking ? (body.booking.bookingId || body.booking.id) : null) ||
      null;

    // 4) bookingId で詳細取得（ダメなら期間で保険取得）
    //    from/to は webhook に入ってないこともあるので、保険で「今日±120日」でも可
    let detail;
    try {
      detail = await beds24GetBookingDetail({ bookingId });
    } catch (e) {
      const today = new Date();
      const from = new Date(today); from.setDate(from.getDate() - 3);
      const to = new Date(today); to.setDate(to.getDate() + 365);

      const fmt = (d) =>
        `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

      detail = await beds24GetBookingDetail({ from: fmt(from), to: fmt(to) });
    }

    // 5) GASへ転送（あなたの既存 forwardEventToGas を流用）
    await forwardEventToGas({
      type: 'beds24_booking_webhook',
      beds24: {
        bookingId: bookingId || '',
        raw: body,
        detail
      }
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('❌ Beds24 webhook error:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

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

// ✅ キャンセル確認画面（ここではまだキャンセルしない）
app.get('/cancel', async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || '');
    const token = String(req.query.token || '');

    if (!sessionId || !token) {
      return res.status(400).send('キャンセルURLが不正です（必要な情報が不足しています）。');
    }

    // 1) Checkout Session を取得（metadata確認）
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session) return res.status(404).send('予約情報が見つかりませんでした。');

    const md = session.metadata || {};
    const captureMethod = md.captureMethod || '';
    const cancelToken = md.cancelToken || '';

    // ✅ manual capture 以外は不可
    if (captureMethod !== 'manual') {
      return res.status(403).send('この予約はキャンセルリンク対象ではありません。');
    }

    // ✅ token照合
    if (!cancelToken || token !== cancelToken) {
      return res.status(403).send('キャンセルトークンが一致しません。');
    }

    // ✅ 期限チェック（cancelUntilEpoch 優先）
    const cancelUntilEpoch = md.cancelUntilEpoch ? Number(md.cancelUntilEpoch) : NaN;
    const cancelUntilText = md.cancelUntil || '';

    if (Number.isFinite(cancelUntilEpoch) && Date.now() > cancelUntilEpoch) {
      return res.status(410).send('キャンセル可能期限を過ぎています。');
    }

    // ✅ すでに確定/キャンセル済みの場合のガード
    const piId = session.payment_intent;
    if (!piId) return res.status(400).send('決済情報（PaymentIntent）が見つかりませんでした。');

    const pi = await stripe.paymentIntents.retrieve(piId);
    if (pi.status === 'succeeded') {
      return res.status(409).send('この予約は既に確定（支払い完了）しているためキャンセルできません。');
    }
    if (pi.status === 'canceled') {
      return res.status(200).send('この予約はすでにキャンセル済みです。');
    }

    // 予約内容（表示用）
    const checkin = md.checkin || '';
    const checkout = md.checkout || '';

    // ✅ 確認ページ（POSTで確定）
    return res.status(200).send(`
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>キャンセル確認</title>
        </head>
        <body style="font-family: sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px;">
          <h2>キャンセル確認</h2>
          <p>以下の仮予約をキャンセルします。よろしいですか？</p>

          <ul>
            <li>チェックイン：${checkin}</li>
            <li>チェックアウト：${checkout}</li>
            ${cancelUntilText ? `<li>キャンセル期限：${cancelUntilText}</li>` : ``}
          </ul>

          <form method="POST" action="/cancel/confirm">
            <input type="hidden" name="session_id" value="${sessionId.replace(/"/g, '&quot;')}" />
            <input type="hidden" name="token" value="${token.replace(/"/g, '&quot;')}" />
            <button type="submit" style="padding: 12px 16px; font-size: 16px;">
              この予約をキャンセルする
            </button>
          </form>

          <p style="margin-top: 18px; color:#666;">
            ※ボタンを押すとキャンセル処理が実行されます。
          </p>
        </body>
      </html>
    `);
  } catch (e) {
    console.error('❌ Cancel confirm page error:', e);
    return res.status(500).send('キャンセル画面の表示に失敗しました。');
  }
});

// ✅ キャンセル実行（ここで初めてStripe cancel）
app.post('/cancel/confirm', async (req, res) => {
  try {
    const sessionId = String(req.body.session_id || '');
    const token = String(req.body.token || '');

    if (!sessionId || !token) {
      return res.status(400).send('必要な情報が不足しています。');
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session) return res.status(404).send('予約情報が見つかりませんでした。');

    const md = session.metadata || {};
    if (md.captureMethod !== 'manual') {
      return res.status(403).send('この予約はキャンセルリンク対象ではありません。');
    }
    if (!md.cancelToken || token !== md.cancelToken) {
      return res.status(403).send('キャンセルトークンが一致しません。');
    }

    // ✅ 期限チェック（epoch優先）
    const cancelUntilEpoch = md.cancelUntilEpoch ? Number(md.cancelUntilEpoch) : NaN;
    if (Number.isFinite(cancelUntilEpoch) && Date.now() > cancelUntilEpoch) {
      return res.status(410).send('キャンセル可能期限を過ぎています。');
    }

    const piId = session.payment_intent;
    if (!piId) {
      return res.status(400).send('決済情報（PaymentIntent）が見つかりませんでした。');
    }

    const pi = await stripe.paymentIntents.retrieve(piId);
    if (pi.status === 'succeeded') {
      return res.status(409).send('この予約は既に確定（支払い完了）しているためキャンセルできません。');
    }
    if (pi.status === 'canceled') {
      return res.status(200).send('この予約はすでにキャンセル済みです。');
    }

    const canceled = await stripe.paymentIntents.cancel(piId);

    // ✅ GASへ通知（シート更新など）
    await forwardEventToGas({
      type: 'manual_capture_canceled',
      data: { object: session },
      payment_status: 'キャンセル',
      payment_method: 'card',
      payment_intent: piId,
      cancel_reason: canceled.cancellation_reason || '',
    });

    return res.status(200).send('キャンセルが完了しました。ご利用ありがとうございました。');
  } catch (e) {
    console.error('❌ Cancel execute error:', e);
    return res.status(500).send('キャンセル処理に失敗しました。お手数ですがご連絡ください。');
  }
});

// ✅ Checkout セッション作成
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { amount, email } = req.body;

    // ✅ payMethod（confirmから来る）
    const payMethod = (req.body.payMethod || 'card').toString(); // 'card' or 'konbini'

    // ✅ metadata（metadata[xxx] を express が metadata オブジェクトにしてくれる）
    const metadata = req.body.metadata || {};
    const checkin = metadata.checkin;

    const now = nowJST();

    // ✅ 明日チェックイン＋12:00以降はブロック
    if (isTomorrowJST(checkin) && isAfterSellStop(now)) {
      return res.status(400).json({
        error: '翌日のチェックインは本日12:00以降は受付できません。',
      });
    }

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // ✅ GAS整合性のため：サーバで確実にmetadataへ格納
    metadata.email = metadata.email || req.body.email || '';
    metadata.phone = metadata.phone || req.body.phone || req.body.tel || '';
    metadata.total = metadata.total || req.body.amount || '';
    metadata.detail = metadata.detail || '';
    metadata.payMethod = metadata.payMethod || payMethod;

    // ✅ 支払い方法を絞る
    let payment_method_types;
    if (payMethod === 'konbini') payment_method_types = ['konbini'];
    else if (payMethod === 'card') payment_method_types = ['card'];
    else payment_method_types = ['card', 'konbini']; // 保険

    // ✅ 「カード×チェックインまで48時間以上」＝オーソリ運用（manual capture）
    const shouldManualCapture =
      payment_method_types.includes('card') && isAtLeast48HoursBeforeCheckinJST(checkin);

    // ✅ manual capture のときだけ「キャンセル用トークン」と「期限」を metadata に付与
    if (shouldManualCapture) {
      const cancelToken = crypto.randomBytes(16).toString('hex'); // 32文字

      // 48時間後（ms）
      const cancelUntilEpoch = Date.now() + 48 * 60 * 60 * 1000;

      // GASメールにそのまま出したいので JST文字列も用意
      const cancelUntilJstText = new Date(cancelUntilEpoch).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });

      metadata.cancelToken = cancelToken;
      metadata.cancelUntil = cancelUntilJstText;          // ✅ GAS表示用（文字列）
      metadata.cancelUntilEpoch = String(cancelUntilEpoch); // ✅ サーバ判定用（文字列でOK）
      metadata.captureMethod = 'manual';
    } else {
      // manual capture じゃない場合はキャンセルリンク対象外
      delete metadata.cancelToken;
      delete metadata.cancelUntil;
      delete metadata.cancelUntilEpoch;
      metadata.captureMethod = 'automatic';
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types,

      // manual capture を使う場合だけ payment_intent_data を付ける
      ...(shouldManualCapture ? { payment_intent_data: { capture_method: 'manual' } } : {}),

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

    return res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    return res.status(500).json({ error: error.message });
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

    return res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Custom session error:', error.stack);
    return res.status(500).json({ error: 'Session creation failed' });
  }
});

// ✅ ヘルスチェック
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode });
});

// ✅ Beds24 接続テスト
app.get('/test-beds24', async (_req, res) => {
  try {
    const token = await beds24GetAccessToken();
    res.json({ success: true, tokenPreview: token.slice(0, 12) + '...' });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// ✅ Beds24 ブッキング取得テスト（指定期間）
app.get('/test-beds24-bookings', async (req, res) => {
  try {
    const token = await beds24GetAccessToken();

    if (!BEDS24_PROPERTY_ID) throw new Error('Missing BEDS24_PROPERTY_ID');
    if (!BEDS24_ROOM_ID) throw new Error('Missing BEDS24_ROOM_ID');

    // 期間は ?from=2026-03-01&to=2026-03-31 みたいに渡せる
    const from = req.query.from || '2026-03-01';
    const to = req.query.to || '2026-03-31';

    const url = new URL(`${BEDS24_BASE_URL}/bookings`);
    url.searchParams.set('propertyId', String(BEDS24_PROPERTY_ID));
    url.searchParams.set('roomId', String(BEDS24_ROOM_ID));
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);

    const r = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        token: token,
      },
    });

    const text = await r.text();
    if (!r.ok) throw new Error(`Beds24 /bookings failed: ${r.status} ${text}`);

    return res.json(JSON.parse(text));
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// ✅ サーバー起動
app.listen(port, () => {
  console.log(`🌐 Server listening on port ${port}`);
});

// ✅ テスト用：1日だけ売止め（closed）を入れる
app.get('/test-beds24-block', async (_req, res) => {
  try {
    const baseUrl = process.env.BEDS24_BASE_URL || 'https://beds24.com/api/v2';
    const propertyId = Number(process.env.BEDS24_PROPERTY_ID);
    const roomId = Number(process.env.BEDS24_ROOM_ID);
    const refreshToken = process.env.BEDS24_REFRESH_TOKEN;

    if (!propertyId || !roomId) throw new Error('Missing propertyId/roomId');
    if (!refreshToken) throw new Error('Missing refreshToken');

    // ✅ 未来日の1日（今日+30日）
    const d = new Date();
    d.setDate(d.getDate() + 30);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const date = `${yyyy}-${mm}-${dd}`;

    // 1) refreshToken -> token
    const tokenResp = await fetch(`${baseUrl}/authentication/token`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        refreshToken: refreshToken,
      },
    });

    const tokenText = await tokenResp.text();
    if (!tokenResp.ok) {
      return res.status(500).json({
        success: false,
        step: 'get_token',
        status: tokenResp.status,
        tokenText,
      });
    }

    const tokenJson = JSON.parse(tokenText);
    const apiToken = tokenJson.token;
    if (!apiToken) throw new Error(`token missing: ${tokenText}`);

    // 2) ✅ 正しい在庫APIへ：POST /inventory/rooms/calendar
    //    Body は docs の例に合わせて data/calendar 形式にする
    const payload = {
      data: [
        {
          propertyId,
          roomId,
          calendar: [
            {
              date,
              closed: true, // 売止め
            },
          ],
        },
      ],
    };

    const invResp = await fetch(`${baseUrl}/inventory/rooms/calendar`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        token: apiToken,
      },
      body: JSON.stringify(payload),
    });

    const invText = await invResp.text();

    // 返り値は配列になることが多い（success/errors など）
    return res.status(invResp.ok ? 200 : 500).json({
      success: invResp.ok,
      step: 'inventory_post',
      status: invResp.status,
      date,
      propertyId,
      roomId,
      invText,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
});