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

For sandbox use, set `PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID`. The server optionally loads `/home/box/.secrets/paypal_sandbox.env`, or `PAYPAL_ENV_FILE`; nonempty environment and `.env` values take precedence. Blank credential placeholders do not mask the secret file. `PAYPAL_MODE` is never enabled by the secret file: explicitly choose sandbox. Sandbox calls use real PayPal sandbox APIs and require valid recipient/account details. Register the public `${BASE_PATH}api/webhooks/paypal` URL with PayPal. Mock-only endpoints are unavailable in sandbox mode.

The Ledgerly `refund_invoice` tool resolves a client or invoice and proposes a refund for confirmation. It uses Payments v2 when the invoice has a stored capture ID; otherwise it uses Invoicing's **record refund** API to record money returned externally. Mock paid webhooks and mock invoice payments store a capture ID automatically. The detail button proposes a full invoice refund. Both partial and full refunds require confirmation. Partial refunds retain `PARTIALLY_REFUNDED` and a remaining refundable balance; excessive or repeated full refunds are rejected. The dashboard displays invoice face values; reconciliation cards show collected or outstanding amounts by currency. This skeleton has no authentication or tenant isolation; use locally for the hackathon.

## Toolkit, confirmations, and conversations

The pinned official `@paypal/agent-toolkit@1.11.0` supplies the OpenAI tool names and JSON schemas via `PayPalAgentToolkit.getTools()`. The enabled products are invoices, orders, and payments (refund tools are part of payments in this version). Ledgerly exposes 13 selected PayPal definitions alongside `create_invoice_series`, `draft_reminder`, `reconcile`, and `ask_clarification`. Toolkit construction is offline, using dummy credentials in mock mode.

`PAYPAL_TOOLKIT_EXECUTION=ours|toolkit` defaults to `ours`. Mock mode always uses the local `PayPalClient`, including when this setting is `toolkit`, because the package hardcodes PayPal network hosts. In sandbox mode, `toolkit` routes official tool execution through `handleToolCall` with real credentials; `ours` uses our sandbox client. Ledgerly orchestration tools use our service. `/api/health` reports `toolkit: {version,toolCount,execution}`; assistant messages persist tool traces and display PayPal Agent Toolkit chips.

Invoices are always drafts first. The resulting action card offers **Confirm / Cancel**; only confirmation sends the draft or series. Saying **yes, send** confirms the latest pending action. A request such as “Send invoice to Acme” only proposes an action. Missing client, amount, or sending email prompts a follow-up; session state and conversation history survive restarts in SQLite. The browser stores a session ID locally; API callers can supply `session_id` (default `default`). Sessions separate conversations, not authentication or invoice access.

Try “Invoice Acme acme@example.com $800/month maintenance for 3 months”, confirm the series, simulate payment, then “Refund $200 to Acme” and confirm. Invoice refunds record external money returned; capture refunds actually return funds through PayPal. Reminders are drafted with `friendly`, `firm`, or `final` tone, subject, amount, client, and days overdue. **Send reminder** submits the exact draft note to the reminder API.

Reconciliation supports “Who hasn't paid this month?”, “How much did I get paid this month?”, and “What's overdue?”. “This month” includes invoices with a due date **or issue date** in the current calendar month in the server's local timezone. Drafts are excluded and counted separately. Unpaid includes SENT, PARTIALLY_PAID, and overdue invoices other than PAID/CANCELLED/REFUNDED. Paid summaries use recorded gross receipts for the matching invoice cohort; refunds remain separately tracked. Totals are grouped by currency. Unavailable LLM calls fall back with a visible notice.

The smoke script requires an already-running mock server with LLM settings unset. It creates a unique conversation and verifies draft series, pending confirmation, sending, payment simulation, reconciliation, partial refunds, over-refund rejection, amount/email clarification, reminder tones, and persisted cards/traces. Use a temporary `DB_PATH` for isolated checks.

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

- `POST chat` with `{message,session_id?}` → `{reply,cards,mode,traces,notice}`
- `POST actions/:id/confirm` or `actions/:id/cancel` with `{session_id?}`
- `GET health`, `GET messages?session_id=...`, `GET invoices`, `GET invoices/:id` (includes timeline)
- `POST invoices/:id/send|remind|cancel|refund` (refund accepts optional `amount`)
- `GET events`, `GET stream` (SSE)
- `POST webhooks/paypal` (signature verified in sandbox; event IDs deduplicated)
- `POST dev/simulate-webhook` with `{event_type,resource_id,amount?}` (mock only)

The mock simulator and webhook route share processing. Supported events: `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`, `INVOICING.INVOICE.REFUNDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`. Orders and capture events are persisted in the timeline; the invoice panel lists invoicing objects.

MIT · Copyright (c) 2026 Breeze Luo.
