# Devpost submission fields — Ledgerly

**Project name:** Ledgerly
**Tagline (elevator pitch):** An AI finance employee for freelancers. It watches your GitHub and inbox, decides what to bill, holds client funds with PayPal, pays your collaborators and prepares dispute evidence. You just approve.

**Demo URL:** https://ledgerly.yufeng.fun/ (PayPal sandbox, no login)
**Repository:** https://github.com/breeze-lyf/ledgerly (public, MIT)
**Video (YouTube, public, < 3 min):** https://youtu.be/<VIDEO_ID> (TODO: add after upload)

## Inspiration
Freelancers do a second, unpaid job: they chase payments, split money with collaborators and lose disputes because the proof is scattered across GitHub, email and chat. We didn't want another invoicing chatbot. We wanted a finance employee that has already done the work by the time you look.

## What it does
- **Intake:** a merged PR (GitHub webhook, HMAC-verified) and the client's "looks good, approved" email arrive through intake. Ledgerly's feed shows what it *noticed* and what it *decided*.
- **Plan card:** each decision becomes one card with its evidence and an exact plan. Example: "Capture $98 of the $196 held via PayPal".
- **Approve:** one click runs the steps visibly. Ledgerly makes a partial capture on the PayPal authorization hold, pays the collaborator's share via PayPal Payouts and marks the milestone PAID.
- **Dispute defense:** when a client disputes, Ledgerly builds an evidence pack (PDF with the PR, the approval email and the timeline) that is **ready to file**. Submitting it to PayPal is not automated.
- **Agent-to-agent negotiation:** Ledgerly is an MCP server. A client's AI agent can negotiate terms over MCP. Discount, hold percentage and payment terms are bounded **in code** by client memory, not by a prompt, so Ledgerly counters out-of-bounds asks. Once terms are accepted, the client funds an authorization hold in the PayPal popup.
- **Client memory:** after a dispute, a client automatically flips to hold-first with shorter terms.
- **Weekly report:** money collected, actions taken, human clicks and an *estimate* of hours saved.

## How we built it
- **Front end:** React + TypeScript + Vite.
- **Back end:** Node/Express with SQLite and SSE for the live feed.
- **PayPal (sandbox):**
  - Orders v2 with intent AUTHORIZE (authorization holds, up to 29 days)
  - partial captures and voids (Payments v2)
  - Payouts for collaborator splits
  - Invoicing v2, Subscriptions, Webhooks signature verification
  - the JS SDK on the hosted hold page
  - the PayPal Agent Toolkit for tool schemas
- **Intake endpoints:** GitHub (HMAC) and email (Bearer).
- **LLM:** an OpenAI-compatible LLM classifies intake and drafts plans. A deterministic policy layer enforces every money limit. MCP endpoints use per-project client tokens.
- **Deploy:** nginx + systemd.

## Challenges we ran into
- Keeping the AI useful but never in charge of the limits: negotiation bounds and capture amounts are validated in code.
- Mapping milestones to partial captures on a single authorization.
- Wording things honestly: a hold is not escrow, and dispute evidence is prepared, not auto-filed.

## Accomplishments that we're proud of
- A live loop on the PayPal sandbox: intake → decision → approve → partial capture → payout, plus a real MCP negotiation run that ends with a funded hold.
- In the week we recorded the demo: $358 collected, 25 AI actions, 4 human clicks.

## What we learned
Trust comes from visible work: show what was noticed, what was decided and the evidence behind it, then ask for one click.

## What's next for Ledgerly
- Filing dispute evidence through the Disputes API, with approval
- More intake sources (Linear, Slack)
- Multi-tenant auth
- Accounting exports

## Built With
paypal-orders-api, paypal-payments-api, paypal-payouts-api, paypal-invoicing-api, paypal-webhooks, paypal-js-sdk, paypal-agent-toolkit, model-context-protocol, openai-compatible-llm, typescript, react, vite, node.js, express, sqlite, server-sent-events, playwright, nginx

## Testing instructions (for judges)
1. Open https://ledgerly.yufeng.fun/. No account is needed; it runs on the sandbox only, with no real money.
2. Open the Finance employee tab, review a pending card's evidence and click Approve to watch the steps run.
3. Open a project's hold page to fund a sandbox authorization with a PayPal sandbox buyer account.

For a local run, see the README Quickstart.

## AI tools used
- **In the product:**
  - an OpenAI-compatible LLM (Zhipu GLM) for intake classification, plan drafting and negotiation messages
  - PayPal Agent Toolkit
  - Model Context Protocol, for agent-to-agent negotiation
- **While building:** AI coding agents (Cursor) for code, tests, docs and the demo video pipeline.
- **Demo video:** edge-tts for the voiceover. Music and sound effects were generated procedurally by us; no third-party audio was used.
