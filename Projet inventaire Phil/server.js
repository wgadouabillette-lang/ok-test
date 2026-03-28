/**
 * Express server for Will Inventory
 * - Landing at ./index.html (repo root); static assets from ./public (app, login, Assets, pages)
 * - Stripe Checkout API + webhook
 *
 * eBay OAuth : voir Cloud Functions (`functions/index.js`) + Secret Manager.
 *
 * Run: node server.js
 * Requires: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (for webhook) in .env
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const PUBLIC_DIR = path.join(__dirname, 'public');

let admin = null;
try {
  const fs = require('fs');
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'serviceAccountKey.json');
  if (fs.existsSync(credPath)) {
    const firebaseAdmin = require('firebase-admin');
    if (!firebaseAdmin.apps.length) {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(cred) });
    }
    admin = firebaseAdmin;
  }
} catch (_) {
  admin = null;
}

const app = express();
const PORT = process.env.PORT || 4242;

app.use(express.static(PUBLIC_DIR, { index: false }));

// CORS for API (if frontend on different origin)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Stripe webhook - MUST be before express.json(), needs raw body
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return res.status(400).json({ error: 'Webhook not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      console.log('Payment succeeded:', session.id, 'customer:', session.customer_email);
      if (admin && userId) {
        try {
          await admin.firestore().collection('users').doc(userId).set({
            subscription: { status: 'active', stripeSessionId: session.id, paidAt: new Date().toISOString() }
          }, { merge: true });
        } catch (e) {
          console.error('Firestore update failed:', e.message);
        }
      }
      break;
    }
    case 'payment_intent.succeeded': {
      console.log('PaymentIntent succeeded:', event.data.object.id);
      break;
    }
    case 'payment_intent.payment_failed': {
      console.log('Payment failed:', event.data.object.id);
      break;
    }
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// JSON body for other API routes
app.use(express.json());

// Create Stripe Checkout session (subscription or one-time)
app.post('/api/create-checkout-session', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe not configured. Add STRIPE_SECRET_KEY to .env' });
  }
  try {
    const { priceId, successUrl, cancelUrl, customerEmail, metadata } = req.body;
    const effectivePriceId = priceId || process.env.STRIPE_PRICE_ID;
    const session = await stripe.checkout.sessions.create({
      mode: effectivePriceId ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      line_items: effectivePriceId
        ? [{ price: effectivePriceId, quantity: 1 }]
        : [{
            price_data: {
              currency: 'cad',
              product_data: {
                name: 'Will Inventory - Plan',
                description: 'Subscription or one-time payment for Will Inventory',
              },
              unit_amount: (metadata?.amount || 999) * 100, // cents
            },
            quantity: 1,
          }],
      success_url: successUrl || `${req.protocol}://${req.get('host')}/app.html?payment=success`,
      cancel_url: cancelUrl || `${req.protocol}://${req.get('host')}/app.html?payment=cancelled`,
      customer_email: customerEmail || undefined,
      metadata: metadata || {},
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: err.message || 'Checkout failed' });
  }
});

// API 404 - always return JSON
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn('STRIPE_SECRET_KEY not set - payment features disabled');
  }
});
