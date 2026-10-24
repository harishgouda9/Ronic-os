# Ronic OS — Backend Control Plane (Vercel + Supabase)

Implements the *Backend, Auth & Revenue Architecture Blueprint*: PKCE desktop
auth bounce, dual-gateway billing webhooks (Stripe USD + Razorpay INR/UPI),
Ed25519 offline license leases, wallet-gated Burst Compute, and the Tauri
update manifest. Zero runtime dependencies — `node:crypto` and `fetch` only.

## Layout

| Route | What it does |
| --- | --- |
| `POST /api/webhooks/billing` | Verifies `stripe-signature` / `x-razorpay-signature`, then fulfills: Founder Pass claims (atomic, capped at 500), Pro subscription activate/cancel. Idempotent via `billing_events`. |
| `POST /api/v1/checkout` | Creates a Stripe Checkout (founder one-time / pro sub) or a Razorpay INR order (UPI). User id rides in payment metadata; the webhook fulfills it. |
| `POST /api/v1/burst-llm` | Wallet-gated OpenRouter wholesale proxy. Verifies the user, pre-checks `compute_wallets`, charges cost + 20% in micro-USD via `debit_wallet`. |
| `GET/POST /api/v1/ghost-runners` | Lists cloud runners; POST answers **501** until `GHOST_CLUSTER_URL` is configured (Firecracker worker cluster is a separate deployment). |
| `GET /auth/bounce` | Last hop of desktop PKCE: forwards `?code=…` to `ronic://auth/callback`. |
| `GET /api/releases/latest` | Tauri v2 updater manifest from env (`RELEASE_*`). |

Supabase pieces live in the repo root:
- `supabase/schema.sql` — 6-table licensing schema, RLS, service-role RPCs.
- `supabase/functions/license-lease/` — Edge Function that signs the 7-day
  Ed25519 lease.

## Deploy

```bash
npm install          # typescript only
npm run typecheck    # must pass before deploy
npx vercel deploy --prod
```

## Secrets (page-4 checklist)

Vercel:
```
VITE_SUPABASE_URL / SUPABASE_URL
VITE_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY      # server only — never in the desktop binary
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET
OPENROUTER_WHOLESALE_KEY       # burst compute margin source
APP_ORIGIN                     # https://ronic.os
GHOST_CLUSTER_URL / GHOST_CLUSTER_SECRET   # when the worker cluster ships
RELEASE_VERSION / RELEASE_NOTES / RELEASE_WINDOWS_URL / RELEASE_WINDOWS_SIG …
```

Supabase (Edge Function secrets):
```
RONIC_ED25519_PRIVATE_KEY      # JWK from `npm run keys`
```

Desktop (`.env.production` for the Tauri build):
```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_POSTHOG_KEY
VITE_SENTRY_DSN
VITE_CHECKOUT_API              # https://ronic.os/api/v1/checkout
VITE_BURST_API                 # https://ronic.os/api/v1/burst-llm
VITE_LEASE_URL                 # https://<project>.supabase.co/functions/v1/license-lease
VITE_AUTH_BOUNCE_URL           # https://ronic.os/auth/bounce
RONIC_ED25519_PUBLIC_KEY       # base64 raw 32 bytes from `npm run keys`
```

## Generating the signing pair

```bash
node scripts/generate-ed25519-keys.mjs
```

Prints the private JWK (Edge Function secret), the base64 public key
(compile-time desktop env), and self-tests the pair against the exact lease
format the Rust verifier checks.

## Provider webhook setup

- Stripe dashboard → webhook endpoint `https://ronic.os/api/webhooks/billing`,
  events: `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`.
- Razorpay dashboard → webhook URL the same, events: `payment.captured`,
  `subscription.charged`.

## Invariants worth remembering

- The desktop binary carries **only** the Ed25519 public key + anon key.
- Money and Founder inventory mutate exclusively through SECURITY DEFINER
  RPCs callable with the service role.
- Every webhook event is claimed in `billing_events` before fulfillment;
  replays return `{replayed: true}`.
- A user's lease is bound to a registered `hardware_hash`; the device cap is
  enforced in `register_device`, not in the client.
