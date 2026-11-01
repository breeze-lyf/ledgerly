# Deploying Ledgerly

Deployment files are preparation only. No deployment is required to use the local mock demo. The upload script contacts the server only when invoked with an explicit `--yes` flag.

## Target layout and prerequisites

Use `/opt/ledgerly` with Node.js 20+ at `/usr/local/bin/node`, npm, Python 3, make, and g++ available on the server. `better-sqlite3` is a native dependency; `npm_config_build_from_source=true npm ci --omit=dev --foreground-scripts` builds its production binary on the target. The unit runs as root for compatibility with the supplied target; a dedicated service user is preferable when ownership of `/opt/ledgerly/data` and the environment file is configured accordingly.

The bundle includes `dist`, `web/dist`, package files, and deployment templates. It excludes local `.env`, database files, and credentials. Back up production SQLite data separately before upgrading.

## Environment

`deploy/env.production.example` uses port 3910, `/paypal-agent/`, PayPal sandbox, the requested LLM endpoint and model, empty credential placeholders, and `/opt/ledgerly/data/app.db`. The script creates `/opt/ledgerly/.env` with mode 600 only if it does not exist; it never replaces an existing file or supplies keys. Populate the sandbox and LLM credentials on the server through your normal secret-management process. An empty LLM key selects fallback mode.

`SEED_ON_START=1` seeds only an empty **mock** database. It is deliberately ignored in sandbox mode: demo fixtures must never issue sandbox financial operations on startup. To explore fixtures, run the app locally in mock mode. Never mix a mock database with sandbox records.

## nginx and systemd

Include `/etc/nginx/ledgerly-paypal-agent.locations` **inside the existing `demo.yufeng.fun` 443 server block**. Do not create a competing TLS server. The snippet redirects `/paypal-agent` to `/paypal-agent/` and proxies to `http://127.0.0.1:3910` without a URI suffix or rewrite. The app must receive the prefix and keep `BASE_PATH=/paypal-agent/`.

The demo nginx configuration uses `auth_request` for some applications. Ledgerly's location explicitly uses `auth_request off`: **paypal-agent must be public**, so PayPal can reach its webhook. Do not place a login redirect or authentication gate in front of that route. This demo is not a tenant-isolated production application.

SSE needs HTTP/1.1, an empty upstream Connection header, buffering/cache disabled, and a long read timeout. Both the app stream response and nginx emit `X-Accel-Buffering: no`.

The deployment script takes `NGINX_CONF` as the path to the existing remote nginx file, verifies a unique matching TLS block, and saves a timestamped backup before inserting the include. If it cannot find a safe insertion point, it stops for manual configuration. `nginx -t` must pass before reload. The script installs/enables/restarts only the `ledgerly` systemd unit, reloads nginx, and checks local and public health endpoints. It never restarts Docker.

## Explicit deployment command

Review the files and configure `/workspace/evs/s.py` first. Then, when intentionally deploying:

```bash
NGINX_CONF=/etc/nginx/sites-available/demo.yufeng.fun \
  bash deploy/deploy.sh --yes
```

The script builds locally, archives the release, uploads using `python3 /workspace/evs/s.py put <local> <remote>`, and executes remote commands using `python3 /workspace/evs/s.py '<cmd>'`. It then runs the production dependency installation on the target. The nginx path above is an example; use the actual existing configuration path. Review a failed nginx test and restore the timestamped backup if necessary; never force a reload of an invalid configuration.

## PayPal webhook configuration

Register this URL in the PayPal sandbox app:

`https://demo.yufeng.fun/paypal-agent/api/webhooks/paypal`

Subscribe to the handled events:

- `INVOICING.INVOICE.PAID`
- `INVOICING.INVOICE.CANCELLED`
- `INVOICING.INVOICE.REFUNDED`
- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.REFUNDED`

Save the returned webhook ID as `PAYPAL_WEBHOOK_ID`. Sandbox requests are verified with PayPal's webhook signature verification API before processing. Mock mode skips remote verification and exposes simulation controls; it is for local demonstrations. Validate real event payloads and capture-to-invoice relationships in your sandbox before relying on reconciliation for live operations.

Check `/paypal-agent/api/health`, an invoice detail, and the SSE stream after configuration. Health reports configuration presence and execution mode; it does not prove credentials are valid.
