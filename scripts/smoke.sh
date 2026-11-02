#!/usr/bin/env bash
set -euo pipefail
export BASE_URL="${BASE_URL:-http://localhost:${PORT:-3000}${BASE_PATH:-/}}"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base=process.env.BASE_URL.replace(/\/$/,'')+'/api/';
const session_id='smoke-'+Date.now();
async function request(path,body){const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,session_id})});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
const chat=message=>request('chat',{message});
const health=await request('health');assert.equal(health.paypalMode,'mock');assert.equal(health.toolkit.version,'1.11.0');assert.ok(health.toolkit.toolCount>=12);
const created=await chat('Invoice Acme smoke@example.com $800/month maintenance for 3 months');assert.equal(created.mode,'fallback');
const drafts=created.cards.filter(c=>c.status==='DRAFT');assert.equal(drafts.length,3);assert.ok(drafts.every(c=>c.amount===800));
const pending=created.cards.find(c=>c.kind==='pending_action');assert.ok(pending);assert.ok(created.traces.length);
const reused=await chat('Invoice Acme smoke@example.com $800/month maintenance for 3 months');
assert.deepEqual(reused.cards.filter(c=>c.status==='DRAFT').map(c=>c.id),drafts.map(c=>c.id));
assert.equal(reused.cards.find(c=>c.kind==='pending_action').id,pending.id);
const confirmed=await request(`actions/${pending.id}/confirm`,{});assert.equal(confirmed.mode,'system');assert.equal(confirmed.cards.length,3);assert.ok(confirmed.cards.every(c=>c.status==='SENT'));
await assert.rejects(()=>request(`actions/${pending.id}/confirm`,{}),/no longer pending/);
const id=drafts[0].id;
await request('dev/simulate-webhook',{event_type:'INVOICING.INVOICE.PAID',resource_id:id});
const paid=await request('invoices/'+id);assert.equal(paid.status,'PAID');assert.ok(paid.timeline.length);assert.ok(JSON.parse(paid.data).capture_id);
const summary=await chat('How much did I get paid this month?');assert.ok(summary.cards[0].rows.some(i=>i.id===id));assert.ok(summary.cards[0].totals.USD>=800);
const unpaid=await chat("Who hasn't paid this month?");assert.ok(unpaid.cards[0].rows.every(i=>i.status!=='DRAFT'));
const refund=await chat('Refund $200 to Acme');const refundAction=refund.cards.find(c=>c.kind==='pending_action');assert.ok(refundAction);assert.equal((await request('invoices/'+id)).status,'PAID');
assert.equal(refundAction.args.invoice_id,id);assert.ok(refundAction.args.capture_id);
const refunded=await chat('yes');assert.equal(refunded.mode,'system');assert.equal(refunded.cards[0].status,'PARTIALLY_REFUNDED');assert.equal(refunded.cards[0].remaining_refundable,600);
const excessive=await chat(`Refund $700 to ${id}`);assert.match(excessive.reply,/remaining refundable.*600/);assert.equal(excessive.cards.length,0);
const clarification=await chat('Invoice Clarify');assert.match(clarification.reply,/amount/i);
const completed=await chat('$125');assert.ok(completed.cards.some(c=>c.client==='Clarify'&&c.amount===125&&c.status==='DRAFT'));
const send=await chat('Send invoice to Clarify');assert.match(send.reply,/email/i);
const email=await chat('clarify@example.com');assert.ok(email.cards.some(c=>c.kind==='pending_action'));
const yes=await chat('yes, send it');assert.equal(yes.mode,'system');assert.ok(yes.cards.some(c=>c.status==='SENT'));
for(const tone of ['friendly','firm','final']){const d=await chat(`Draft a ${tone} reminder for ${drafts[1].id}`);assert.equal(d.cards[0].tone,tone);assert.ok(d.cards[0].subject&&d.cards[0].body.includes('days overdue'));}
await chat("Invoice CancelTest cancel@example.com $50");const cancelled=await chat("no thanks");assert.equal(cancelled.mode,"system");assert.equal(cancelled.reply,"Action cancelled.");
const link = await chat('Create payment link $25 for Logo revision');
const order = link.cards.find(c => c.kind === 'payment_link'); assert.ok(order?.approve_url);
let stored = (await request('orders')).find(o => o.id === order.id); assert.equal(stored.status, 'CREATED');
await request('mock-pay/'+order.id, {});
stored = (await request('orders')).find(o => o.id === order.id);
assert.equal(stored.status, 'COMPLETED'); assert.ok(stored.capture_id); assert.equal(stored.payment.status, 'PAID');
assert.ok(stored.timeline.some(e => e.event_type === 'CHECKOUT.ORDER.APPROVED'));
assert.ok(stored.timeline.some(e => e.event_type === 'PAYMENT.CAPTURE.COMPLETED'));
const approved = { id: 'duplicate-approved-'+order.id, event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: order.id } };
await Promise.all([request('webhooks/paypal', approved), request('webhooks/paypal', approved)]);
assert.equal((await request('orders')).find(o => o.id === order.id).capture_id, stored.capture_id);
const partial = await chat(`refund $5 on order ${order.id}`);
const proposal = partial.cards.find(c => c.kind === 'pending_action'); assert.ok(proposal); assert.equal(proposal.args.capture_id, stored.capture_id);
assert.equal((await request('orders')).find(o => o.id === order.id).refunded, 0);
await request(`actions/${proposal.id}/confirm`, {});
stored = (await request('orders')).find(o => o.id === order.id);
assert.equal(stored.refunded, 5); assert.equal(stored.status, 'COMPLETED'); assert.equal(stored.payment.status, 'PARTIALLY_REFUNDED');
const over = await chat(`refund $21 on order ${order.id}`); assert.equal(over.cards.length, 0); assert.match(over.reply, /remaining refundable/);
const button = await request(`orders/${order.id}/refund`, { amount: 20 }); assert.equal(button[0].kind, 'pending_action');
await request(`actions/${button[0].id}/confirm`, {});
assert.equal((await request('orders')).find(o => o.id === order.id).status, 'REFUNDED');
console.log('PASS: payment link → approved webhook → idempotent auto-capture → paid payment → confirmed partial refund → button refund → fully refunded');
const overdueCards=await request('invoices',{client_name:'Collections Smoke',client_email:'collections@example.com',due_date:'2020-01-01',items:[{name:'Services',quantity:1,unit_amount:175}]});
const overdueInvoice=overdueCards.find(c=>c.status==='DRAFT');
await request(`actions/${overdueCards.find(c=>c.kind==='pending_action').id}/confirm`,{});
const collecting=await chat('what needs collecting?');
assert.ok(collecting.cards.find(c=>c.kind==='collections').rows.some(i=>i.id===overdueInvoice.id && i.tone==='friendly'));
const plan=await chat('run collections');
const remind=plan.cards.find(c=>c.kind==='pending_action' && c.args.invoice_id===overdueInvoice.id);
assert.ok(remind);assert.equal(remind.name,'remind_invoice');
assert.ok(!(await request('invoices/'+overdueInvoice.id)).timeline.some(e=>e.event_type==='COLLECTIONS.REMINDED'));
await request(`actions/${remind.id}/confirm`,{});
const reminded=await request('invoices/'+overdueInvoice.id);
assert.ok(reminded.timeline.some(e=>e.event_type==='COLLECTIONS.REMINDED'));
assert.ok(reminded.timeline.some(e=>e.event_type==='PAYPAL.EXECUTED' && JSON.parse(e.data).operation==='remindInvoice'));
const rescanned=(await request('collections')).rows.find(i=>i.id===overdueInvoice.id);
assert.equal(rescanned.collections_state.remind_count,1);assert.equal(rescanned.collections_state.last_tone,'friendly');assert.equal(rescanned.eligible,false);
assert.ok(rescanned.collections_state.last_remind_at && rescanned.collections_state.next_action_at);
const cash=await request('cashflow');assert.ok(cash.overdue_amount>=175);assert.ok(cash.by_client.some(c=>c.client==='Collections Smoke' && c.risk==='high'));
assert.ok((await chat('Cashflow this month')).cards.some(c=>c.kind==='cashflow'));
console.log('PASS: overdue candidate → collections proposal → explicit confirmation → mock PayPal reminder → persisted history and cooldown → cashflow risk');
const history=await request('messages?session_id='+session_id);assert.ok(history.some(m=>m.traces?.length));
console.log('PASS: toolkit health → draft series → confirm send → payment → reconciliation → partial refund → over-refund rejected → clarification → confirmed send → reminder tones → persisted history');
JS
