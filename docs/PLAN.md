# Ledgerly — Plan

**Pitch:** Ledgerly is a chat-native PayPal agent for freelancers and small studios. Type "Invoice Acme $800/month maintenance for 3 months" and it drafts, sends, tracks, chases, reconciles and refunds — all through PayPal.

## Architecture
- One Node 20 + TypeScript process (Fastify-style HTTP server + better-sqlite3) serving a React/Vite SPA. A single process with an SQLite file is easy to run with systemd behind nginx.
- `BASE_PATH` prefix support (e.g. `/paypal-agent/` on demo.yufeng.fun). All API routes live under `${BASE_PATH}api/`.
- `server/agent`: OpenAI-compatible tool-calling loop (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`, max 5 tool rounds) plus a deterministic fallback parser for when no LLM is available. Each reply is labelled `mode: llm|fallback`.
- `server/paypal`: a `PayPalClient` interface with two implementations, `MockPayPalClient` (uses the real REST response shapes, a mock pay page, and simulated webhooks) and `SandboxPayPalClient` (`https://api-m.sandbox.paypal.com`, cached OAuth token). The `PAYPAL_MODE=mock|sandbox` env var picks one.
- `server/service.ts`: invoice mirror, event timeline, webhook handling, and SSE push to the UI.
- `web/`: chat on the left; invoice cards, detail view, status timeline and actions on the right; mode badges and a stats strip.

## PayPal APIs
- OAuth2: `/v1/oauth2/token`
- Invoicing v2: generate-next-invoice-number, create draft, get, list, send, remind, cancel, record payment, record refund
- Orders v2: create (payment link / approve URL), get, capture
- Payments v2: refund a capture (full or partial)
- Webhooks: verify-webhook-signature. Handled events: INVOICING.INVOICE.PAID / CANCELLED / REFUNDED, PAYMENT.CAPTURE.COMPLETED / REFUNDED
- Stretch: Invoicing templates, Subscriptions/Plans for true recurring billing, Disputes read-only, Transaction Search for reconciliation

## Milestones (Beijing time)
- 11/01 ✅ Skeleton: mock end-to-end, LLM + fallback, BASE_PATH
- 11/02–03: Get sandbox keys; validate the sandbox client against the real API; register a webhook (needs a public URL, via demo.yufeng.fun)
- 11/04–05: Agent depth: multi-turn clarification, dunning drafts by tone, reconciliation Q&A ("who hasn't paid", "how much this month"), partial refunds, confirmations before sends
- 11/06–07: UI polish: timeline, invoice preview, empty states, mobile layout, error handling
- 11/08: Deploy to demo.yufeng.fun/paypal-agent/ (nginx + systemd), sandbox webhooks live
- 11/09: Tests, seed demo data, README with screenshots, architecture diagram
- 11/10: Demo video script and recording; Devpost text
- 11/11: Internal freeze; public GitHub repo (MIT); submit. Official deadline: 11/13 04:00

## Open items
- PayPal sandbox app credentials and webhook ID (`/home/box/.secrets/paypal_sandbox.env`)
- Production LLM key for the deployed app (the provider is swappable via env)
- Decide how recurring billing works: N scheduled invoices (current) or Subscriptions API
- "This month" semantics in reconciliation (by due date vs. issue date; whether drafts count)
- Auth for the public demo (shared demo session / rate limiting)
