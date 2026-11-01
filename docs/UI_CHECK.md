# Local UI verification

Checked on 2026-11-01 with Playwright and locally installed Chromium, using a mock PayPal client, no LLM configuration, a disposable SQLite database, and `/paypal-agent/` on port 3400. Browser requests were restricted to the target loopback origin. No deployment or remote operations were performed.

## Reproduction

```bash
BASE_PATH=/paypal-agent/ npm run build
DB_PATH=/tmp/ledgerly-ui.db npm run reset -- --seed
BASE_PATH=/paypal-agent/ PORT=3400 DB_PATH=/tmp/ledgerly-ui.db \
  PAYPAL_MODE=mock PAYPAL_ENV_FILE=/tmp/no-ledgerly-secrets \
  LLM_BASE_URL= LLM_API_KEY= LLM_MODEL= SEED_ON_START=1 npm start
# Separate terminal, with the server already running:
CHROMIUM_PATH=/opt/ungoogled-chromium/chrome npm run ui-check
BASE_PATH=/paypal-agent/ PORT=3400 npm run smoke
```

Stop the server after checking. `ui-check` starts only its own browser, closes it in `finally`, and never starts an application server. It accepts `URL` (loopback only) and defaults to `http://localhost:3400/paypal-agent/`.

## Browser installation constraint

The npm cache did not contain Playwright. To honor the no-remote requirement, Playwright was installed from the machine's existing global package files, offline, as a pinned devDependency. Existing Chromium at `/opt/ungoogled-chromium/chrome` was used. `npx --no-install playwright install chromium --dry-run` identified the managed download, but the actual download was not executed because it would contact remote servers. No `--with-deps` was needed. On a machine where network access is permitted, run `npx playwright install chromium`, or supply `CHROMIUM_PATH` to keep using an installed browser.

## Flows checked

- Real empty-state rendering with only the invoice-list response temporarily replaced by `[]`; the seeded database is preserved.
- Fresh conversation with seeded invoices, Acme suggestion creating three drafts, button confirmation, and `mode: system` / System badge.
- Invoice detail action simulating payment through the webhook pipeline; PAID status and timeline entry.
- Unpaid reconciliation table, currency totals, and draft exclusion explanation.
- Detail-panel reminder action and firm reminder draft for overdue Umbrella Design.
- A $200 partial refund proposed in chat, confirmed by button, and reflected in invoice detail.
- Chat/Invoices switching at 390×844, invoice timeline access, and long identifiers.
- Visible error recovery message from an intentionally injected local 400 payment response. This does not test a real PayPal outage.
- No unexpected console exceptions/errors, failed requests, HTTP errors, or off-origin requests. The injected error is expected; SSE aborts during page teardown are ignored.

## Bugs found and fixed

| Finding | Fix |
| --- | --- |
| Deterministic text confirmations/cancellations reported fallback mode. Button actions supplied no mode. | Both paths now return `system`; UI displays System. Smoke covers button confirmation, text confirmation, refund confirmation, and cancellation. |
| Google Fonts CSS triggered a remote request. | Removed the import; local system font fallbacks keep the UI self-contained. |
| A root-path build served under `/paypal-agent/` requested missing `/assets/` files. | Rebuilt with the matching prefix; deployment explicitly builds with `BASE_PATH=/paypal-agent/`. README documents that build/start paths must match. |
| Detail Send reminder set busy before delegating to chat, suppressing the draft. | Clear the delegated busy state and switch to chat before creating the draft. The browser flow exercises this action. |
| Mobile invoices were stacked below a long chat, leaving detail actions awkward to reach. | Added accessible Chat/Invoices tabs with pressed state; hide the inactive panel and bring the active workspace into view. Keep tabs sticky and panel height tied to the viewport. |
| Desktop panels extended below the 900px viewport, hiding the composer. | Tightened header/dashboard spacing and sized panels to the available viewport height. |
| Completed confirmation buttons stayed usable, leading to repeated “no longer pending” failures. | Disable the completed action controls and label the confirmation Completed in the current conversation. Server validation still protects persisted/replayed actions. |
| Long identifiers and summary tables could expand narrow content; muted text was faint. | Added wrapping/min-width constraints, contained table scrolling, darker muted text, and readable dark-theme bubbles. |
| Partial refunds caused received payments to disappear from the monthly dashboard. Drafts inflated outstanding balances. | Include paid/refunded states using recorded payment amounts; label the metric Received and exclude drafts from outstanding. Subtract partial payments from outstanding balances. |
| Mixed SQLite and ISO timestamps placed payment events before creation in the timeline. | Sort detail events using SQLite `datetime(created_at)` with row order as the tie-breaker. |
| Smooth scrolling made screenshots show previous messages instead of the result under test. | Use immediate conversation scrolling and wait for two animation frames before capture. Match chat responses to their message and await the detail reminder before starting the next prompt. |

## Results and artifacts

`npm run build`, fallback smoke with `BASE_PATH=/paypal-agent/`, and `npm run ui-check` passed. Seed/reset and empty-database startup seeding were exercised locally. Deployment shell syntax was checked; deployment was not executed.

Screenshots were captured and visually inspected at **1440×900** and **390×844**:

- [Desktop empty state](screenshots/desktop-empty.png)
- [Desktop draft series](screenshots/desktop-chat.png)
- [Desktop paid timeline](screenshots/desktop-invoice-detail.png)
- [Desktop reconciliation](screenshots/desktop-reconcile.png)
- [Desktop firm reminder](screenshots/desktop-dunning.png)
- [Desktop partial refund](screenshots/desktop-refund.png)
- [Mobile chat](screenshots/mobile-chat.png)
- [Mobile detail](screenshots/mobile-detail.png)
- [Mobile error state](screenshots/mobile-error.png)

The local server was stopped after verification. Sandbox, live LLM behavior, external nginx, and systemd were not exercised in this local-only round.
