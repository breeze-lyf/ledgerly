# Devpost submission fields — Ledgerly

**Project name:** Ledgerly
**Tagline (elevator pitch):** A chat-native PayPal invoicing agent for freelancers: draft, send, chase, reconcile and refund invoices by just asking — with a human confirm on every money move.

**Demo URL:** https://ledgerly.yufeng.fun/ (PayPal sandbox, no login)
**Repository:** https://github.com/breeze-lyf/ledgerly (public, MIT)
**Video (YouTube, public, < 3 min):** https://youtu.be/<VIDEO_ID> (TODO: add after upload)

## Inspiration
Freelancers have a second unpaid job: writing invoices, chasing late payments and figuring out who still owes what. We wanted that follow-through to feel as easy as a conversation, while keeping the person in control of anything that moves money.

## What it does
Type "Invoice Acme $800/month maintenance for 3 months" and Ledgerly creates PayPal sandbox draft invoices, shows a review card, and sends them through PayPal Invoicing only after you confirm. Payments arrive via verified PayPal webhooks and update a live timeline. A **Collections agent** finds overdue and near-due invoices and proposes friendly → firm → final reminders; a **cashflow dashboard** shows outstanding, overdue, next-7-day and received totals plus heuristic client risk. You can ask "Who hasn't paid this month?", record off-PayPal payments, create PayPal Orders payment links, and issue confirmed partial refunds with remaining-balance checks.

## How we built it
React + TypeScript + Vite front end; Node/Express API with SQLite and SSE. The **PayPal Agent Toolkit** (`@paypal/agent-toolkit` 1.11.0) supplies 17 tool schemas (13 invoice/order/refund tools plus read-only disputes, transaction search and subscription details) to an OpenAI-compatible LLM with tool calling; Ledgerly adds 12 higher-level tools (collections run, what needs collecting, cashflow, order and invoice refunds, invoice series, reminder drafting, reconciliation, clarification, and create/cancel/list retainers). Recurring work can be billed as a real PayPal subscription (Catalog Product → Plan → Subscription with a client approval link, tracked by subscription webhooks), and Ledgerly is itself an MCP server with 15 tools, so any outside agent can read receivables and propose actions that a human confirms. Clients pay from a hosted pay page using the PayPal JS SDK; capture, refund and denial webhooks plus a periodic sync keep invoice state correct, and an opt-in Autopilot sends guarded, LLM-written reminders with a human-approval threshold. Calls run against PayPal sandbox: Invoicing v2, Orders v2, Payments v2 refunds, Catalog Products and Billing Subscriptions v1, Disputes and Transaction Search (read-only), OAuth2 and Webhooks signature verification. A deterministic fallback keeps the demo working if the LLM is unreachable. Deployed with nginx + systemd.

## Challenges we ran into
Financial intent needs more than a plausible answer: separating draft creation from send confirmation, validating refund balances, mapping PayPal webhook events to invoice state, and reconciling toolkit tool shapes with our own validated client.

## Accomplishments that we're proud of
A full sandbox loop — chat draft → confirmed send → reminder → payment → reconciliation → partial refund → cancel — passes an automated end-to-end test against the real PayPal sandbox, and is live for judges.

## What we learned
A trustworthy financial agent must make its work inspectable: tool chips, review cards, persistent timelines and explicit confirmation matter as much as language quality.

## What's next for Ledgerly
Subscriptions API for true recurring billing, scheduled reminder policies, accounting exports, multi-tenant auth, and a production readiness review.

## Built With
paypal-invoicing-api, paypal-orders-api, paypal-payments-api, paypal-webhooks, paypal-agent-toolkit, paypal-subscriptions-api, paypal-js-sdk, model-context-protocol, openai-compatible-llm, typescript, react, vite, node.js, express, sqlite, server-sent-events, playwright, nginx

## Testing instructions (for judges)
Open https://ledgerly.yufeng.fun/ — no account needed, sandbox only, no real money. Try: `Invoice Globex $250 for logo design, billing@globex-example.com` → Confirm; open the invoice → Remind; `Record payment $250 for <id>`; `What needs collecting?`; `Cashflow this month`; `Refund $50 to <id>` → Confirm. Local run: see README Quickstart (mock mode needs no credentials; sandbox mode needs your own PayPal sandbox app keys).

## AI tools used

- In the product: OpenAI-compatible LLM (Zhipu GLM) for tool calling and reminder writing; PayPal Agent Toolkit 1.11.0.
- While building: AI coding assistants (Cursor agents) for code, tests and docs.
