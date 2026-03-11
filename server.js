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

function formatYmdJst_(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseYmdToLocalDate_(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDaysYmd_(ymd, days) {
  const d = parseYmdToLocalDate_(ymd);
  d.setDate(d.getDate() + days);
  return formatYmdJst_(d);
}

function normalizeBeds24CalendarRows_(json) {
  if (!json) return [];

  // すでに日別配列ならそのまま返す
  if (Array.isArray(json)) {
    // [{date:'2026-03-22', inventory:1}, ...] 形式
    if (json.length && (
      json[0].date ||
      json[0].day ||
      json[0].currentDate ||
      json[0].roomDate ||
      json[0].calendarDate
    )) {
      return json;
    }

    // [{ roomId, propertyId, calendar:[...] }] 形式を平坦化
    const flattened = [];
    json.forEach(item => {
      if (Array.isArray(item?.calendar)) {
        flattened.push(...item.calendar);
      }
    });
    if (flattened.length) return flattened;
    return [];
  }

  // { data:[...] } 形式
  if (Array.isArray(json.data)) {
    // data 自体が日別配列
    if (json.data.length && (
      json.data[0].date ||
      json.data[0].day ||
      json.data[0].currentDate ||
      json.data[0].roomDate ||
      json.data[0].calendarDate
    )) {
      return json.data;
    }

    // data が room 配列で、その中に calendar がある場合
    const flattened = [];
    json.data.forEach(item => {
      if (Array.isArray(item?.calendar)) {
        flattened.push(...item.calendar);
      }
    });
    if (flattened.length) return flattened;
  }

  // { calendar:[...] } 形式
  if (Array.isArray(json.calendar)) return json.calendar;

  // { rooms:[...] } 形式で、その中に calendar がある場合
  if (Array.isArray(json.rooms)) {
    const flattened = [];
    json.rooms.forEach(item => {
      if (Array.isArray(item?.calendar)) {
        flattened.push(...item.calendar);
      }
    });
    if (flattened.length) return flattened;
    return json.rooms;
  }

  return [];
}

function findBeds24CalendarRowByDate_(rows, ymd) {
  return rows.find((row) => {
    const rowDate =
      row.date ||
      row.day ||
      row.currentDate ||
      row.roomDate ||
      row.calendarDate ||
      '';
    return String(rowDate).slice(0, 10) === ymd;
  }) || null;
}

/**
 * Beds24の在庫を最終確認する
 * - checkin は到着日
 * - checkout は出発日
 * - 宿泊在庫は checkin 〜 (checkoutの前日) を確認
 * - 返り値:
 *   { ok: true }
 *   { ok: false, reason: '...', detail: ... }
 */
async function beds24CheckAvailability(checkin, checkout) {
  const startedAt = Date.now();

  if (!checkin || !checkout) {
    return { ok: false, reason: 'checkin/checkout missing' };
  }

  const token = await beds24GetAccessToken();

  if (!BEDS24_PROPERTY_ID) throw new Error('Missing BEDS24_PROPERTY_ID');
  if (!BEDS24_ROOM_ID) throw new Error('Missing BEDS24_ROOM_ID');

  const url = new URL(`${BEDS24_BASE_URL}/bookings`);
  url.searchParams.set('propertyId', String(BEDS24_PROPERTY_ID));
  url.searchParams.set('roomId', String(BEDS24_ROOM_ID));
  url.searchParams.set('from', checkin);
  url.searchParams.set('to', checkout);
  url.searchParams.set('includeInvoiceItems', 'false');
  url.searchParams.set('includeInfoItems', 'false');

  console.log('🛏️ beds24CheckAvailability start:', url.toString());

  const r = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      token,
    },
  });

  const text = await r.text();
  console.log('🛏️ beds24CheckAvailability fetch ms =', Date.now() - startedAt);

  if (!r.ok) {
    throw new Error(`Beds24 /bookings availability lookup failed: ${r.status} ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Beds24 bookings response is not JSON: ${text}`);
  }

  const rows = Array.isArray(json.data) ? json.data : [];

  const hasOverlap = rows.some((row) => {
    const status = String(row.status || '').toLowerCase();

    if (status.includes('cancel') || status.includes('deleted')) {
      return false;
    }

    const arrival = String(row.arrival || '').slice(0, 10);
    const departure = String(row.departure || '').slice(0, 10);

    if (!arrival || !departure) return false;

    return arrival < checkout && departure > checkin;
  });

  console.log('🛏️ beds24CheckAvailability total ms =', Date.now() - startedAt);

  if (hasOverlap) {
    return {
      ok: false,
      reason: 'overlapping booking exists',
      detail: rows,
    };
  }

  return { ok: true };
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

      let status = '支払い完了';

      if (paymentMethod === 'konbini') {
        status = session.payment_status === 'paid' ? '支払い完了' : '支払い待ち';
      } else {
        status = session.payment_status === 'paid' ? '支払い完了' : '仮予約';
      }

      // ✅ 仮予約/支払い待ちの時点で Beds24 に予約作成して在庫を押さえる
      const md = session.metadata || {};
      const existing = await beds24FindExistingBookingBySessionId(
        session.id,
        md.checkin || undefined,
        md.checkout || undefined
      );

      if (!existing) {
        const beds24Result = await beds24CreateBookingFromSession(session, paymentMethod, status);
        console.log(
          '✅ Beds24 booking created from checkout.session.completed:',
          JSON.stringify(beds24Result).slice(0, 1000)
        );
      } else {
        console.log(
          `ℹ️ Beds24 booking already exists for session ${session.id} (bookingId=${existing.id})`
        );
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
        const md = session.metadata || {};
    
        // ✅ Beds24の自社予約を支払い完了に更新
        const updated = await beds24UpdateBookingStatusBySessionId(
          session.id,
          md.checkin || undefined,
          md.checkout || undefined,
          'confirmed'
        );
    
        console.log(
          '✅ Beds24 booking updated from payment_intent.succeeded:',
          JSON.stringify(updated).slice(0, 1000)
        );
    
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

      const sessions = await stripe.checkout.sessions.list({
        payment_intent: paymentIntent.id,
        limit: 1,
      });

      const session = sessions.data[0] || null;
      const md = session?.metadata || {};

      if (session) {
        const canceled = await beds24CancelBookingBySessionId(
          session.id,
          md.checkin || undefined,
          md.checkout || undefined
        );
        console.log(
          '🗑️ Beds24 booking canceled from payment_intent.canceled:',
          JSON.stringify(canceled).slice(0, 1000)
        );
      }

      const payload = {
        type: 'payment_intent.canceled',
        data: session ? { object: session } : null,
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

// Beds24 API: 予約を1件作成
async function beds24CreateBookingFromSession(session, paymentMethod = 'card', paymentStatus = '支払い完了') {
  const token = await beds24GetAccessToken();

  if (!BEDS24_PROPERTY_ID) throw new Error('Missing BEDS24_PROPERTY_ID');
  if (!BEDS24_ROOM_ID) throw new Error('Missing BEDS24_ROOM_ID');

  const md = session.metadata || {};

  const checkin = md.checkin || '';
  const checkout = md.checkout || '';

  if (!checkin || !checkout) {
    throw new Error('Beds24 booking requires metadata.checkin and metadata.checkout');
  }

  const firstName =
  md.kanjiFirstName ||
  md.firstName ||
  md.name ||
  'Guest';

  const lastName =
  md.kanjiLastName ||
  md.lastName ||
  'Direct Booking';

  const email = md.email || session.customer_details?.email || session.customer_email || '';
  const phone =
    md.phone ||
    md.tel ||
    session.customer_details?.phone ||
    '';

  const numAdult = Math.max(1, Number(md.adults || md.numAdults || md.adultCount || 1));

  const child11 = Number(md.child11 || 0);
  const child6  = Number(md.child6 || 0);
  const child3  = Number(md.child3 || 0);

  const numChild = Math.max(
    0,
    Number(md.children || md.numChildren || md.childCount || (child11 + child6 + child3))
  );

  const amountTotal =
    typeof session.amount_total === 'number'
      ? session.amount_total
      : Number(md.total || 0);

      const commentLines = [
        'Direct booking sync from stay-oceanus.com',
        session.id ? `Stripe session: ${session.id}` : '',
        session.payment_intent ? `PaymentIntent: ${session.payment_intent}` : '',
        paymentStatus ? `Payment status: ${paymentStatus}` : '',
        paymentMethod ? `Payment method: ${paymentMethod}` : '',
        md.detail ? `Detail: ${md.detail}` : '',
      ].filter(Boolean);

    const payload = [
    {
      propertyId: Number(BEDS24_PROPERTY_ID),
      roomId: Number(BEDS24_ROOM_ID),
      status: 'new',
      arrival: checkin,
      departure: checkout,
      numAdult,
      numChild,
      firstName,
      lastName,
      email,
      phone,
      referer: 'API',
      comments: commentLines.join('\n'),
      price: amountTotal ? Number(amountTotal) : 0,
    },
  ];

  const r = await fetch(`${BEDS24_BASE_URL}/bookings`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      token,
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Beds24 /bookings create failed: ${r.status} ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  return json;
}

// Beds24 API: 既存予約チェック（Stripe session.id ベース）
async function beds24FindExistingBookingBySessionId(sessionId, from, to) {
  if (!sessionId) return null;

  const token = await beds24GetAccessToken();

  const url = new URL(`${BEDS24_BASE_URL}/bookings`);
  url.searchParams.set('propertyId', String(BEDS24_PROPERTY_ID));
  url.searchParams.set('roomId', String(BEDS24_ROOM_ID));

  if (from) url.searchParams.set('from', String(from));
  if (to) url.searchParams.set('to', String(to));

  const r = await fetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json', token },
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Beds24 /bookings lookup failed: ${r.status} ${text}`);
  }

  const json = JSON.parse(text);
  const rows = Array.isArray(json.data) ? json.data : [];

  const existing =
    rows.find((row) => {
      const comments = String(row.comments || '');
      return comments.includes(`Stripe session: ${sessionId}`);
    }) || null;

  console.log(
    '🛏️ Beds24 existing booking lookup result:',
    JSON.stringify(existing || null).slice(0, 1000)
  );

  return existing;
}

// Beds24 API: Stripe session.id に対応する予約をキャンセル
async function beds24CancelBookingBySessionId(sessionId, from, to) {
  if (!sessionId) return null;

  const existing = await beds24FindExistingBookingBySessionId(sessionId, from, to);
  if (!existing) {
    console.log(`ℹ️ No Beds24 booking found for session ${sessionId}, skip cancel`);
    console.log('🛏️ Beds24 existing booking lookup result:',JSON.stringify(existing || null).slice(0, 1000));
    return null;
  }

  const token = await beds24GetAccessToken();
  const bookingId = Number(existing.id || 0);

  if (!bookingId) {
    throw new Error(`Beds24 booking id missing for session ${sessionId}`);
  }

  const tryRequests = [
    {
      label: 'PUT id + cancelled',
      method: 'PUT',
      body: [{ id: bookingId, status: 'cancelled' }],
    },
    {
      label: 'PUT bookingId + cancelled',
      method: 'PUT',
      body: [{ bookingId: bookingId, status: 'cancelled' }],
    },
    {
      label: 'PUT id + cancel',
      method: 'PUT',
      body: [{ id: bookingId, status: 'cancel' }],
    },
    {
      label: 'PUT bookingId + cancel',
      method: 'PUT',
      body: [{ bookingId: bookingId, status: 'cancel' }],
    },
  ];

  let lastError = '';

  for (const reqDef of tryRequests) {
    try {
      console.log(
        `🛏️ Beds24 cancel try: ${reqDef.label} bookingId=${bookingId} body=${JSON.stringify(reqDef.body)}`
      );

      const r = await fetch(`${BEDS24_BASE_URL}/bookings`, {
        method: reqDef.method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          token,
        },
        body: JSON.stringify(reqDef.body),
      });

      const text = await r.text();
      console.log(`🛏️ Beds24 cancel response: ${reqDef.label} status=${r.status} body=${text}`);

      if (!r.ok) {
        lastError = `${reqDef.label} failed: ${r.status} ${text}`;
        continue;
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }

      return {
        canceledBookingId: bookingId,
        requestLabel: reqDef.label,
        response: json,
      };
    } catch (e) {
      lastError = `${reqDef.label} exception: ${String(e.message || e)}`;
      console.error(`❌ Beds24 cancel exception on ${reqDef.label}:`, e);
    }
  }

  throw new Error(`Beds24 cancel failed for bookingId=${bookingId}. lastError=${lastError}`);
}

async function beds24UpdateBookingStatusBySessionId(sessionId, from, to, newStatus) {
  if (!sessionId) return null;

  const existing = await beds24FindExistingBookingBySessionId(sessionId, from, to);
  if (!existing) {
    console.log(`ℹ️ No Beds24 booking found for session ${sessionId}, skip status update`);
    return null;
  }

  const token = await beds24GetAccessToken();

  const payload = [
    {
      id: existing.id,
      status: newStatus,
    },
  ];

  const r = await fetch(`${BEDS24_BASE_URL}/bookings`, {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      token,
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Beds24 /bookings status update failed: ${r.status} ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  return {
    updatedBookingId: existing.id,
    status: newStatus,
    response: json,
  };
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
    if (!session) {
      return res.status(404).send('予約情報が見つかりませんでした。');
    }

    const md = session.metadata || {};

    if (md.captureMethod !== 'manual') {
      return res.status(403).send('この予約はキャンセルリンク対象ではありません。');
    }

    if (!md.cancelToken || token !== md.cancelToken) {
      return res.status(403).send('キャンセルトークンが一致しません。');
    }

    // ✅ 期限チェック
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

    // =========================
    // 1) Stripeキャンセル（最優先）
    // =========================
    let canceled = null;
    try {
      canceled = await stripe.paymentIntents.cancel(piId);
      console.log(`✅ Stripe payment canceled: ${piId}`);
    } catch (e) {
      console.error('❌ Stripe cancel failed:', e);
      return res.status(500).send('Stripeのキャンセル処理に失敗しました。お手数ですがご連絡ください。');
    }

    // =========================
    // 2) Beds24キャンセル（失敗しても全体は成功扱い）
    // =========================
    let beds24Canceled = null;
    let beds24CancelError = '';

    try {
      beds24Canceled = await beds24CancelBookingBySessionId(
        session.id,
        md.checkin || undefined,
        md.checkout || undefined
      );

      console.log(
        '🗑️ Beds24 booking canceled from /cancel/confirm:',
        JSON.stringify(beds24Canceled).slice(0, 1000)
      );
    } catch (e) {
      beds24CancelError = String(e.message || e);
      console.error('⚠️ Beds24 cancel failed, but Stripe cancel already succeeded:', beds24CancelError);
    }

    // =========================
    // 3) GAS通知（失敗しても全体は成功扱い）
    // =========================
    try {
      await forwardEventToGas({
        type: 'manual_capture_canceled',
        data: { object: session },
        payment_status: 'キャンセル',
        payment_method: 'card',
        payment_intent: piId,
        cancel_reason: canceled?.cancellation_reason || '',
        beds24_cancel: beds24Canceled || null,
        beds24_cancel_error: beds24CancelError || '',
      });

      console.log('✅ manual_capture_canceled forwarded to GAS');
    } catch (e) {
      console.error('⚠️ GAS forward failed after Stripe cancel:', e);
    }

    // =========================
    // 4) ユーザー返却
    // =========================
    if (beds24CancelError) {
      return res.status(200).send(
        'キャンセルは完了しました。なお、外部在庫連携の更新に時間がかかる場合があります。'
      );
    }

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

    // ✅ Beds24を正本として在庫最終チェック
    const checkout = metadata.checkout;
    const availability = await beds24CheckAvailability(checkin, checkout);

    if (!availability.ok) {
      console.warn('⚠️ Availability changed before checkout session creation:', availability);

      return res.status(409).json({
        code: 'AVAILABILITY_CHANGED',
        error: '他サイトから予約が入ったため、この日程は現在選択できません。最新の空室状況を反映するため、カレンダーを再読み込みしてから再度ご確認ください。'
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

// ✅ Beds24 在庫判定テスト（本番と同じ判定）
app.get('/test-beds24-availability', async (req, res) => {
  try {
    const checkin = String(req.query.checkin || '');
    const checkout = String(req.query.checkout || '');

    if (!checkin || !checkout) {
      return res.status(400).json({
        success: false,
        error: 'checkin と checkout を指定してください。例: /test-beds24-availability?checkin=2026-03-18&checkout=2026-03-21'
      });
    }

    const result = await beds24CheckAvailability(checkin, checkout);

    return res.json({
      success: true,
      checkin,
      checkout,
      result
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: String(e.message || e),
    });
  }
});

// ✅ Beds24 カレンダー返り値確認用
app.get('/test-beds24-calendar', async (req, res) => {
  try {
    const token = await beds24GetAccessToken();

    if (!BEDS24_ROOM_ID) throw new Error('Missing BEDS24_ROOM_ID');

    const from = String(req.query.from || '');
    const to = String(req.query.to || '');

    if (!from || !to) {
      return res.status(400).json({
        success: false,
        error: 'from と to を指定してください。例: /test-beds24-calendar?from=2026-03-18&to=2026-03-20'
      });
    }

    const url = new URL(`${BEDS24_BASE_URL}/inventory/rooms/calendar`);
    url.searchParams.set('roomId', String(BEDS24_ROOM_ID));
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);

    const r = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        token,
      },
    });

    const text = await r.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    return res.status(r.ok ? 200 : 500).json({
      success: r.ok,
      requestUrl: url.toString(),
      roomId: BEDS24_ROOM_ID,
      from,
      to,
      raw: json,
      normalized: normalizeBeds24CalendarRows_(json),
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: String(e.message || e),
    });
  }
});

// ✅ サーバー起動
app.listen(port, () => {
  console.log(`🌐 Server listening on port ${port}`);
});

// ✅ テスト用：1日だけ売止め（closed）を入れる
app.get('/test-beds24-block', async (req, res) => {
  try {
    // ✅ 統一：BEDS24_BASE_URL を使う（この関数内で baseUrl を再定義しない）
    const baseUrl = BEDS24_BASE_URL;

    const propertyId = Number(BEDS24_PROPERTY_ID);
    const roomId = Number(BEDS24_ROOM_ID);

    if (!BEDS24_REFRESH_TOKEN) throw new Error('Missing BEDS24_REFRESH_TOKEN');
    if (!propertyId) throw new Error('Missing BEDS24_PROPERTY_ID');
    if (!roomId) throw new Error('Missing BEDS24_ROOM_ID');

    // ✅ 未来日の1日（今日+30日）
    const d = new Date();
    d.setDate(d.getDate() + 30);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const date = `${yyyy}-${mm}-${dd}`;

    // 1) refreshToken -> access token
    const tokenResp = await fetch(`${baseUrl}/authentication/token`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        refreshToken: BEDS24_REFRESH_TOKEN,
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
    if (!apiToken) throw new Error(`Beds24 token missing: ${tokenText}`);

    // 2) ✅ 在庫（クローズ）反映：v2は /inventory/rooms/calendar を使うのが筋
    //    ※ payload 形式はBeds24側の定義に依存するので、まず「読めるか」をテストしてから更新が安全
    //    まず当日1日の状態を読む（GET）
    const calUrl = new URL(`${baseUrl}/inventory/rooms/calendar`);
    calUrl.searchParams.set('roomId', String(roomId));
    calUrl.searchParams.set('from', date);
    calUrl.searchParams.set('to', date);

    const getResp = await fetch(calUrl.toString(), {
      method: 'GET',
      headers: { accept: 'application/json', token: apiToken },
    });
    const getText = await getResp.text();

    if (!getResp.ok) {
      return res.status(500).json({
        success: false,
        step: 'inventory_get',
        status: getResp.status,
        getText,
        hint: 'まず /inventory/rooms/calendar がこのトークンで読めるか確認',
      });
    }

    // 次に「閉じる」を更新（PUT/POST はアカウント設定とAPI仕様で変わることがあるため、両対応の形で投げる）
    // まずPUTを試す
    const putPayload = [
      { roomId, date, closed: 1 }, // closed は 0/1
    ];

    const putResp = await fetch(`${baseUrl}/inventory/rooms/calendar`, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        token: apiToken,
      },
      body: JSON.stringify(putPayload),
    });

    const putText = await putResp.text();

    return res.status(200).json({
      success: putResp.ok,
      step: 'inventory_put',
      date,
      propertyId,
      roomId,
      inventory_get_preview: getText.slice(0, 500),
      put_status: putResp.status,
      put_text: putText.slice(0, 1000),
      note: 'PUTが405/400なら、Beds24 swaggerの /inventory/rooms/calendar の method/payload に合わせてPOSTへ変更',
    });
  } catch (e) {
    console.error('❌ test-beds24-block error:', e);
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
});