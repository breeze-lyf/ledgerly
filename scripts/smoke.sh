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
const history=await request('messages?session_id='+session_id);assert.ok(history.some(m=>m.traces?.length));
console.log('PASS: toolkit health → draft series → confirm send → payment → reconciliation → partial refund → over-refund rejected → clarification → confirmed send → reminder tones → persisted history');
JS
