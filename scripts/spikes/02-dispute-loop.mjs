// Spike 2: sandbox dispute loop. Card capture -> sandbox chargeback (no buyer account needed)
// or buyer dispute with PayPal-Auth-Assertion if SANDBOX_BUYER_EMAIL is set -> require-evidence
// -> provide-evidence (multipart PDF) -> settle (adjudicate).
import { api, log } from './_pp.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exp = (process.env.SANDBOX_CARD_EXP || '').trim();
const expiry = /^\d{2}\/\d{2,4}$/.test(exp) ? `${exp.split('/')[1].length === 2 ? '20' + exp.split('/')[1] : exp.split('/')[1]}-${exp.split('/')[0]}` : exp;
const o = await api('POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '120.00' }, description: 'Spike: milestone 1 design work' }], payment_source: { card: { number: process.env.SANDBOX_CARD_NUMBER, expiry, security_code: process.env.SANDBOX_CARD_CVV, name: 'Demo Client' } } });
log('card order CAPTURE', o, j => `status=${j.status}`);
const cap = o.json?.purchase_units?.[0]?.payments?.captures?.[0];
const merchantId = o.json?.purchase_units?.[0]?.payee?.merchant_id;
if (!cap) process.exit(1);
let disputeId;
if (process.env.SANDBOX_BUYER_EMAIL) {
  const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const jwt = `${b64({ alg: 'none' })}.${b64({ iss: process.env.PAYPAL_CLIENT_ID, email: process.env.SANDBOX_BUYER_EMAIL })}.`;
  const fd = new FormData();
  fd.append('input', new Blob([JSON.stringify({ disputed_transactions: [{ buyer_transaction_id: cap.id }], reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', dispute_amount: { currency_code: 'USD', value: '120.00' } })], { type: 'application/json' }));
  const d = await api('POST', '/v1/customer/disputes', fd, { 'PayPal-Auth-Assertion': jwt });
  log('create dispute (Auth-Assertion)', d); disputeId = d.json?.links?.[0]?.href?.split('/').pop();
} else {
  const now = new Date(), due = new Date(Date.now() + 10 * 864e5);
  const c = await api('POST', '/v2/customer-support/process-chargeback', { adjacency: 'PAYPAL', file_layout: 'ATCK_CB', merchant_id: merchantId, financial_institution: { processor: 'FDMS' }, transaction: { id_enc: cap.id, amount: { currency_code: 'USD', value: '120.00' } }, instrument: { instrument_type: 'CARD', card_brand: 'VISA', credit_card_transaction_id: String(Date.now()), external: false }, dispute: { id: null, stage: 'CHARGEBACK', response_date: due.toISOString(), status: '2', amount: { currency_code: 'USD', value: '120.00' }, receive_date: now.toISOString(), event_code: 'CHARGEBACK_INITIATED', money_movement_date: now.toISOString(), event_type: 'DEBIT', chargeback_type: 'REPORTED_TO_PROCESSOR', reason_code: '13.1' } });
  log('create sandbox chargeback', c, j => JSON.stringify(j).slice(0, 200));
}
for (let i = 0; !disputeId && i < 12; i++) {
  await sleep(10000);
  const l = await api('GET', `/v1/customer/disputes?disputed_transaction_id=${cap.id}`);
  disputeId = l.json?.items?.[0]?.dispute_id;
  if (i === 0 || disputeId) log(`list disputes for capture (poll ${i})`, l, j => `count=${j.items?.length || 0}`);
}
if (!disputeId) { console.log('no dispute created'); process.exit(2); }
const show = async label => { const s = await api('GET', `/v1/customer/disputes/${disputeId}`); log(label, s, j => `status=${j.status} reason=${j.reason} links=${(j.links || []).map(l => l.rel).join(',')}`); return s.json; };
let d = await show('get dispute');
const re = await api('POST', `/v1/customer/disputes/${disputeId}/require-evidence`, { action: 'SELLER_EVIDENCE' }); log('require-evidence SELLER_EVIDENCE', re);
d = await show('get dispute after require-evidence');
const evType = d?.evidences?.find(e => e.source === 'REQUESTED_FROM_SELLER')?.evidence_type || 'OTHER';
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 60>>stream\nBT /F1 12 Tf 20 100 Td (Ledgerly evidence pack: delivered) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const fd = new FormData();
fd.append('input', new Blob([JSON.stringify({ evidences: [{ evidence_type: evType, notes: 'Deliverables were shared and approved by the client in writing; see attached evidence pack.' }] })], { type: 'application/json' }));
fd.append('file1', new Blob([pdf], { type: 'application/pdf' }), 'evidence-pack.pdf');
const pe = await api('POST', `/v1/customer/disputes/${disputeId}/provide-evidence`, fd); log(`provide-evidence (${evType}, PDF)`, pe);
d = await show('get dispute after evidence');
const st = await api('POST', `/v1/customer/disputes/${disputeId}/adjudicate`, { adjudication_outcome: 'SELLER_FAVOR' }); log('settle (adjudicate SELLER_FAVOR)', st);
await show('final dispute');
