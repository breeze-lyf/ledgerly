# Ledgerly

Less chasing. More creating. Ledgerly is a chat-native PayPal invoicing and payments assistant for freelancers, built for the PayPal AI Hackathon.

Create monthly invoice batches, send and remind clients, track payments live, record external refunds, and generate PayPal Checkout links from a conversation. A deterministic parser keeps the demo useful without an LLM. SQLite preserves chat, invoices, mock PayPal objects, and the activity timeline across restarts.

## Stack

Node 20+, TypeScript, Express, better-sqlite3, React, and Vite. One package, one production process. The backend serves `web/dist` and the API; no separate frontend server is required.

## Quickstart

```sh
cp .env.example .env
npm install
npm run build
npm start
# in another terminal
bash scripts/smoke.sh
```

Open http://localhost:3000. `npm run dev` builds the SPA and watches the backend with tsx; rebuild with `npm run build:web` after frontend changes.

Try:

- Invoice Acme $800/month maintenance for 3 months
- Send invoice to Acme
- Who hasn't paid this month?
- Send a reminder to Acme
- Refund $200 to Acme
- Create payment link $50 for design

Select an invoice to see its timeline and actions. In mock mode, send an invoice and use **Simulate paid**, or open its payer-view link from the stored PayPal response. Checkout orders have a local approve page with a **Pay now** button. SSE refreshes invoices as events arrive. Monthly recurrence creates up to 24 drafts immediately, spaced one month apart; it is not a background scheduler.

## Environment

See `.env.example` for all settings. Defaults: `PORT=3000`, `BASE_PATH=/`, `PAYPAL_MODE=mock`, `DB_PATH=./data/app.db`. Set `LLM_BASE_URL` (including `/v1` if required), `LLM_API_KEY`, and `LLM_MODEL` to enable OpenAI-compatible tool calling. Missing configuration or a failed call activates the fallback parser; responses include `mode`.

For sandbox use, set `PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID`. The server optionally loads `/home/box/.secrets/paypal_sandbox.env`, or `PAYPAL_ENV_FILE`; existing environment and `.env` values take precedence. Sandbox calls use real PayPal sandbox APIs and require valid recipient/account details. Register the public `${BASE_PATH}api/webhooks/paypal` URL with PayPal. Mock-only endpoints are unavailable in sandbox mode.

Invoice refunds use PayPal's **record refund** API: they record money returned externally. The `refund` agent tool with a `capture_id` uses the actual capture refund API. The detail button records a full invoice refund. Partial-payment and refund amounts are available in the activity data; the initial dashboard displays invoice face values, not a reconciled accounting balance. This skeleton has no authentication or tenant isolation; use locally for the hackathon.

## Path prefix / nginx

Use the same `BASE_PATH` for build and runtime. The server normalizes leading and trailing slashes, injects the API base, and serves the SPA fallback for nested routes under that prefix.

```sh
BASE_PATH=/paypal-agent/ npm run build
BASE_PATH=/paypal-agent/ npm start
BASE_PATH=/paypal-agent/ bash scripts/smoke.sh
```

Preserve the prefix when proxying:

```nginx
location /paypal-agent/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_buffering off; # live SSE updates
    proxy_read_timeout 1h;
    proxy_set_header Host $host;
}
```

## API

All paths are relative to `${BASE_PATH}api/`:

- `POST chat` with `{message}` → `{reply,cards,mode}`
- `GET health`, `GET messages`, `GET invoices`, `GET invoices/:id` (includes timeline)
- `POST invoices/:id/send|remind|cancel|refund` (refund accepts optional `amount`)
- `GET events`, `GET stream` (SSE)
- `POST webhooks/paypal` (signature verified in sandbox; event IDs deduplicated)
- `POST dev/simulate-webhook` with `{event_type,resource_id,amount?}` (mock only)

The mock simulator and webhook route share processing. Supported events: `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`, `INVOICING.INVOICE.REFUNDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`. Orders and capture events are persisted in the timeline; the invoice panel lists invoicing objects.

MIT · Copyright (c) 2026 Breeze Luo.
