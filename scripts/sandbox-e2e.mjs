import assert from 'node:assert/strict';
const url = new URL(process.env.URL || 'http://localhost:3500/paypal-agent/');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'E2E URL must be localhost');
const base = url.href.replace(/\/$/, '') + '/api/';
const session_id = 'sandbox-e2e-' + Date.now();
async function request(path, body) {
  const r = await fetch(base + path, body === undefined ? { redirect: 'error' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, session_id }), redirect: 'error',
  });
  const data = await r.json();
  assert.ok(r.ok, `${path}: ${data.error || r.status}`);
  return data;
}
const chat = message => request('chat', { message });
const health = await request('health');
assert.equal(health.paypalMode, 'sandbox');
assert.equal(health.llm, false, 'Run server with DISABLE_LLM=1');
const create = await chat('Invoice Globex $250 for logo design, billing@globex-example.com');
assert.equal(create.mode, 'fallback');
const draft = create.cards.find(c => c.status === 'DRAFT');
assert.ok(draft, create.reply);
assert.ok(create.cards.find(c => c.kind === 'pending_action'));
const id = draft.id;
assert.equal((await chat('confirm')).cards[0]?.status, 'SENT');
await request(`invoices/${id}/remind`, {});
assert.equal((await request(`invoices/${id}`)).status, 'SENT');
const paid = await chat(`Record payment $250 for ${id}`);
assert.equal(paid.cards[0]?.status, 'PAID', paid.reply);
assert.equal(JSON.parse((await request(`invoices/${id}`)).data).capture_id, undefined);
const refund = await chat(`Refund $50 to ${id}`);
assert.ok(refund.cards.find(c => c.kind === 'pending_action'), refund.reply);
const refunded = await chat('confirm');
assert.equal(refunded.cards[0]?.status, 'PARTIALLY_REFUNDED', refunded.reply);
assert.equal(refunded.cards[0].remaining_refundable, 200);
const second = await chat('Invoice CancelSandbox $25 billing@globex-example.com');
const cancelId = second.cards.find(c => c.status === 'DRAFT')?.id;
assert.ok(cancelId, second.reply);
assert.equal((await chat('confirm')).cards[0]?.status, 'SENT');
await request(`invoices/${cancelId}/cancel`, {});
assert.equal((await request(`invoices/${cancelId}`)).status, 'CANCELLED');
const reconciliation = await chat('How much did I get paid this month?');
assert.ok(reconciliation.cards[0]?.rows.some(c => c.id === id));
const order = await chat('Create payment link $10');
const link = order.cards.find(c => c.kind === 'payment_link');
assert.ok(link?.id && link.approve_url, order.reply);
assert.equal(new URL(link.approve_url).hostname, 'www.sandbox.paypal.com');
const fetched = await chat(`get order ${link.id}`);
assert.equal(fetched.cards[0]?.id, link.id, fetched.reply);
const capture = await chat(`capture order ${link.id}`);
assert.equal(capture.cards[0]?.code, 'ORDER_NOT_APPROVED', capture.reply);
const unsigned = await fetch(base + 'webhooks/paypal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'unsigned-test', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id } } }) });
assert.equal(unsigned.status, 401);
assert.equal((await request(`invoices/${id}`)).status, 'PARTIALLY_REFUNDED');
console.log(`PASS sandbox (${health.toolkit.execution}): draft → confirmed send → remind → external CASH payment → PAID → partial record-refund → PARTIALLY_REFUNDED → cancel → reconciliation → real order approval link → get order → graceful unapproved capture; unsigned webhook rejected`);
