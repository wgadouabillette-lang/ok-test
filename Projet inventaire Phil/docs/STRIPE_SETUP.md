# Stripe Payment Setup

## Flow

1. User clicks **Subscribe to Pro** in Settings → Billing
2. Redirect to Stripe Checkout (page de paiement)
3. User pays
4. Stripe redirects back with `?payment=success`
5. Webhook receives `checkout.session.completed` → updates subscription status in Firestore

## .env

```
STRIPE_SECRET_KEY=sk_test_xxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxx
STRIPE_PRICE_ID=price_xxxxx
```

## Run

```bash
npm install
node server.js
```

Open `http://localhost:4242`. Landing is `index.html` at repo root; other static pages live in `public/` (`app.html`, `login.html`, etc.).

## Webhook (local)

```bash
stripe listen --forward-to localhost:4242/api/webhook
```

Copy the `whsec_xxx` to `.env` as `STRIPE_WEBHOOK_SECRET`.

## Firestore (optional)

To save subscription status in Firestore when payment succeeds, add `serviceAccountKey.json` (Firebase Console → Project Settings → Service accounts → Generate new key). The webhook will write to `users/{userId}` with `subscription: { status: 'active', ... }`.
