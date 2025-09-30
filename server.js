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

/**
 * Normalises the Stripe checkout session payload that will be delivered to GAS.
 * The Apps Script previously only read `event.data.object`, but now it can fall
 * back to top-level properties when `data.object` is unavailable. To maintain
 * compatibility, we include both the nested structure and the duplicated
 * top-level fields so that GAS can read whichever format it expects.
 *
 * @param {object} event The Stripe event object.
 * @returns {object} Payload forwarded to GAS.
 */
function buildCheckoutPayload(event) {
  const session = (event && event.data && event.data.object) || {};

  return {
    type: event.type,
    created: event.created,
    livemode: event.livemode,
    sessionId: session.id || event.sessionId || event.id || null,
    id: session.id || null,
    payment_intent: session.payment_intent || event.payment_intent || null,
    payment_status: session.payment_status || event.payment_status || null,
    payment_method_types:
      session.payment_method_types || event.payment_method_types || [],
    customer_email:
      (session.customer_details && session.customer_details.email) ||
      session.customer_email ||
      null,
    metadata: session.metadata || event.metadata || {},
    data: {
      object: session,
    },
  };
}

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
        req.body,
        signature,
        webhookSecret
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    try {
      if (event.type && event.type.startsWith('checkout.session.')) {
        const payload = buildCheckoutPayload(event);
        await forwardEventToGas(payload);
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Failed to forward event to GAS:', err.message);
      res.status(500).send(`Forward Error: ${err.message}`);
    }
  }
);

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

module.exports = {
  buildCheckoutPayload,
};
