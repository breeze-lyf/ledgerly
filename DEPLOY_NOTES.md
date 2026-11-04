# Deploy notes: `feat/finance-employee`

Not deployed yet. Main stays deployable until this branch is merged.

## New environment variables (add to /opt/ledgerly/.env, mode 600)

| Variable | Required | Value | Purpose |
|---|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | yes, for GitHub intake | random 32+ chars, same as the GitHub repo webhook secret | HMAC check on `POST /api/intake/github` |
| `INTAKE_TOKEN` | yes, for email intake | random 32+ chars | Bearer token for `POST /api/intake/email` (mail forwarder / Zapier / Gmail script) |
| `DEMO_TOOLS` | demo only | `1` for the judged demo, unset otherwise | Enables `POST /api/dev/finance-dispute` (simulated dispute, labelled "simulated") in sandbox mode |
| `DISPUTE_SUBMIT` | no | leave unset | `1` sends evidence to PayPal `provide-evidence`; not verified in sandbox (needs a buyer-opened dispute) |
| `FINANCE_SWEEP` | no | unset (on) | Hourly day-4 reauthorization sweep + 10-minute payout status poll; `0` disables |
| `PUBLIC_URL` | already present | `https://ledgerly.yufeng.fun` | Used in hold/funding links sent to the client's agent |

Existing variables are unchanged (`PAYPAL_*`, `LLM_*`, `MCP_TOKEN`, `PAYPAL_WEBHOOK_ID`, …). The client-agent MCP endpoint
`/mcp/client` needs no env var: it authenticates with per-project tokens issued from the Finance employee tab.

## Steps

1. Merge `feat/finance-employee` into `main` (after review), then locally: `npm ci && npm test && npm run build`.
2. On the server, add the variables above to `/opt/ledgerly/.env` (never on the command line), `chmod 600`.
3. nginx: no change. `deploy/ledgerly.conf` proxies `location /` to the app, which already covers `/mcp/client` and `/hold/*`.
4. Deploy: `DEPLOY_HOST='<server>' BRIDGE=/workspace/evs/s.py bash deploy/deploy.sh --yes`. The script runs `npm ci --omit=dev`, restarts the service and checks `/api/health`. SQLite tables `fe_*` are created on start; no migration step.
5. Re-register PayPal webhooks (adds authorization, payout and `CUSTOMER.DISPUTE.*` events):
   `npm run webhook:register -- https://ledgerly.yufeng.fun/api/webhooks/paypal`
6. GitHub: on each demo repo add a webhook → `https://ledgerly.yufeng.fun/api/intake/github`, content type JSON, secret = `GITHUB_WEBHOOK_SECRET`, events: Pull requests, Issues, Releases.
7. Demo data (from the box, card stays local):
   `URL=https://ledgerly.yufeng.fun/ GITHUB_WEBHOOK_SECRET=… INTAKE_TOKEN=… FUND=browser npm run seed:finance`
   (`FUND=api` uses confirm-payment-source instead of the JS SDK popup; `FUND=skip` leaves holds unfunded.) Values come from the private env, not typed inline in shared shells.
8. Smoke: open `/` (Finance employee tab is default), `/hold/prj_fabrikam`, `curl -XPOST /mcp/client` → 401 without token.

## Known risks before going live
- Finance routes (`/api/finance/*`, plan approval, client-token issuance) follow the app's existing demo model and have no user auth. Fine for the sandbox demo; add auth before any real use.
- Without a public webhook, payout statuses come from the 10-minute poll; dispute events only arrive via webhook (or the simulated route).
