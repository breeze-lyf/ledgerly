# Deploy Ledgerly

Live URL: https://ledgerly.yufeng.fun/ (BASE_PATH=/).
Node runs in /opt/ledgerly under ledgerly.service, listening on 127.0.0.1:3910.
Install Node 20+, npm, Python, make, g++, nginx and certbot on <server>.

Provision /opt/ledgerly/.env privately from deploy/env.production.example, set PayPal sandbox credentials and business email, and restrict permissions to 600. Never put credentials in commands or source control. Deployment requires this file and never overwrites it. ADMIN_TOKEN is optional; the local purge route is disabled when unset.

Point DNS to <server>. Bootstrap HTTP using deploy/ledgerly.http.conf at /etc/nginx/conf.d/ledgerly.conf, create /var/www/html, run nginx -t and reload. Issue TLS before installing the HTTPS configuration:

```sh
certbot certonly --webroot -w /var/www/html --cert-name ledgerly.yufeng.fun -d ledgerly.yufeng.fun
```

Deploy from this repository:

```sh
DEPLOY_HOST='<server>' BRIDGE=/workspace/evs/s.py bash deploy/deploy.sh --yes --nginx
```

The bridge wrapper retains the existing bridge credential loader and overrides its SSH host in memory. BRIDGE defaults to /workspace/evs/s.py. Build uses BASE_PATH=/; the release contains built assets, package manifests and deploy files. Remote installation runs npm ci --omit=dev, installs the service, restarts it and checks /api/health. Without --nginx no nginx file is touched. With --nginx, /etc/nginx/conf.d/ledgerly.conf is timestamp-backed up, replaced, validated and reloaded; invalid configuration is restored. Subsequent app-only releases need only --yes.

Register the sandbox webhook using the existing secret loader:

```sh
npm run webhook:register -- https://ledgerly.yufeng.fun/api/webhooks/paypal
```

Privately set the resulting PAYPAL_WEBHOOK_ID in /opt/ledgerly/.env and restart ledgerly.service. Do not publish environment files or command output containing credentials.

## Demo data

`URL=https://ledgerly.yufeng.fun/ npm run seed:sandbox` uses only the deployed HTTP API, no LLM or local PayPal credentials. It creates six clients with two paid, one partially refunded, two sent, one draft, plus three monthly retainer drafts. All carry ledgerly-demo-seed in the note; IDs are saved incrementally in data/seed-sandbox.json. Do not run concurrent seeds. Interrupted runs retain IDs; clean and archive the manifest before reseeding.

Overdue creation tries a past explicit due date, then NET_10 with a backdated issue date, then today as the earliest attempted allowed date. Fallback results are recorded in the manifest; no remote overdue claim is made until the due date has passed.

`npm run seed:sandbox -- --clean` deletes drafts and cancels eligible sent invoices. Paid/refunded invoices remain on PayPal. Add --purge-local with ADMIN_TOKEN supplied privately through the environment to remove all manifest IDs from the local mirror as well.

To remove the three Acme test drafts from the mirror, POST /api/admin/purge-local with JSON `{"ids":["<id1>","<id2>","<id3>"]}` and header x-admin-token supplied privately. This removes only local invoice/event/cache rows, not PayPal invoices or historical chat. POST /api/invoices/:id/delete deletes only a remotely verified DRAFT on PayPal before deleting its local mirror.

`UI_READONLY=1 URL=https://ledgerly.yufeng.fun/ CHROMIUM_PATH=/opt/ungoogled-chromium/chrome npm run ui-check` captures both viewports without sending invoices or refunds. Only reconciliation chat writes history; other mutations are blocked. Existing invoices are required. Without CHROMIUM_PATH, Playwright's Chromium is used.
