import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const target = new URL(process.env.URL || 'http://localhost:3400/paypal-agent/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
  throw Error('ui-check only targets loopback URLs; it never starts a server.');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync'],
});
const problems = [];
await mkdir('docs/screenshots', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== target.origin) {
      problems.push('Remote request blocked: ' + u);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  let expectedError = false;
  page.on('pageerror', e => problems.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !expectedError) problems.push(m.text()); });
  page.on('requestfailed', r => { if (!expectedError && r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(r.url() + ': ' + r.failure()?.errorText); });
  page.on('response', r => { if (r.status() >= 400 && !expectedError) problems.push(`${r.status()} ${r.url()}`); });
  const visible = async locator => locator.waitFor({ state: 'visible', timeout: 10000 });
  const shot = async name => {
    await page.evaluate(() => {
      const chat = document.querySelector('.conversation');
      if (chat) chat.scrollTop = chat.scrollHeight;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: `docs/screenshots/${name}.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page must not overflow horizontally');
  };
  const ask = async text => {
    const response = page.waitForResponse(r => r.url().endsWith('/api/chat') && r.request().method() === 'POST' && r.request().postDataJSON()?.message === text);
    await page.getByLabel('Message Ledgerly').fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const r = await response; assert.equal(r.status(), 200);
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('aria-busy') === 'false');
    return r.json();
  };
  // Render the real invoice empty state without deleting the seeded database.
  await page.route('**/api/invoices', r => r.fulfill({ json: [] }));
  await page.goto(target.href);
  await visible(page.getByText('A fresh start.'));
  await shot('desktop-empty');
  await page.unroute('**/api/invoices');
  await page.reload();
  await visible(page.locator('.invoice-row').first());
  await visible(page.getByText('Less chasing. More creating.'));
  await page.getByRole('button', { name: '＋ Invoice Acme', exact: true }).click();
  await visible(page.getByRole('button', { name: 'Confirm', exact: true }).last());
  await shot('desktop-chat');
  const confirmation = page.waitForResponse(r => /\/actions\/[^/]+\/confirm$/.test(r.url()));
  await page.getByRole('button', { name: 'Confirm', exact: true }).last().click();
  assert.equal((await (await confirmation).json()).mode, 'system');
  await visible(page.getByText('✦ AI: System'));
  await page.locator('.chat-card').filter({ hasText: 'SENT · Due' }).first().click();
  await visible(page.getByRole('button', { name: 'Simulate paid', exact: true }));
  await page.getByRole('button', { name: 'Simulate paid', exact: true }).click();
  await visible(page.locator('.detail-top .badge').filter({ hasText: /^PAID$/ }));
  await visible(page.locator('.timeline').getByText('INVOICING · INVOICE · PAID'));
  const invoiceId = await page.locator('.detail-top code').innerText();
  await shot('desktop-invoice-detail');
  const reconciliation = await ask("Who hasn't paid this month?");
  assert.equal(reconciliation.cards[0].kind, 'summary');
  await visible(page.locator('.summary'));
  await shot('desktop-reconcile');
  await page.getByRole('button', { name: '← All invoices' }).click();
  await page.locator('.invoice-row').filter({ hasText: 'Umbrella Design' }).click();
  // Detail reminder action must actually create a chat draft.
  const detailReminder = page.waitForResponse(r => r.url().endsWith('/api/chat') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send reminder', exact: true }).click();
  assert.equal((await (await detailReminder).json()).cards[0].tone, 'friendly');
  await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('aria-busy') === 'false');
  const draft = await ask('Draft a firm reminder for Umbrella Design');
  assert.equal(draft.cards[0].tone, 'firm');
  await shot('desktop-dunning');
  const refund = await ask(`Refund $200 to ${invoiceId}`);
  assert.equal(refund.cards.find(c => c.kind === 'pending_action').args.amount, 200);
  await page.getByRole('button', { name: 'Confirm', exact: true }).last().click();
  await visible(page.getByText('✦ AI: System'));
  await page.locator('.chat-card').filter({ hasText: 'PARTIALLY_REFUNDED · Due' }).last().click();
  await visible(page.locator('.detail-top .badge').filter({ hasText: 'PARTIALLY REFUNDED' }));
  await shot('desktop-refund');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await shot('mobile-chat');
  assert.equal(await page.locator('aside').isVisible(), false);
  await page.getByRole('button', { name: 'Invoices', exact: true }).click();
  assert.equal(await page.locator('.chat.panel').isVisible(), false);
  await page.locator('.details').scrollIntoViewIfNeeded();
  await shot('mobile-detail');
  await page.getByRole('button', { name: '← All invoices' }).click();
  await page.locator('.invoice-row').filter({ hasText: 'Umbrella Design' }).click();
  await page.route('**/api/dev/simulate-webhook', r => r.fulfill({ status: 400, json: { error: 'Demo payment unavailable. Please try again.' } }));
  expectedError = true;
  await page.getByRole('button', { name: 'Simulate paid' }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await visible(page.getByRole('alert'));
  assert.match(await page.getByRole('alert').innerText(), /Demo payment unavailable/);
  await page.getByRole('alert').scrollIntoViewIfNeeded();
  await shot('mobile-error');
  await page.unroute('**/api/dev/simulate-webhook');
  expectedError = false;
  await context.close();
  assert.deepEqual(problems, [], 'No unexpected console errors, failed requests, HTTP errors, or remote requests');
  console.log('PASS: empty state, series, button confirmation/System badge, paid webhook, timeline, reconciliation, detail reminder, firm dunning, partial refund, mobile tabs, error state; screenshots saved.');
} finally { await browser.close(); }
