// Spike 1: Orders v2 AUTHORIZE with card -> partial capture x2 -> reauthorize -> void.
import { api, log } from './_pp.mjs';
const exp = (process.env.SANDBOX_CARD_EXP || '').trim();
const expiry = /^\d{2}\/\d{2,4}$/.test(exp) ? `${exp.split('/')[1].length === 2 ? '20' + exp.split('/')[1] : exp.split('/')[1]}-${exp.split('/')[0]}` : exp;
const card = { number: process.env.SANDBOX_CARD_NUMBER, expiry, security_code: process.env.SANDBOX_CARD_CVV, name: 'Demo Client' };
const o = await api('POST', '/v2/checkout/orders', { intent: 'AUTHORIZE', purchase_units: [{ reference_id: 'milestone-project', amount: { currency_code: 'USD', value: '2400.00' } }], payment_source: { card } });
log('create order AUTHORIZE (card)', o, j => `status=${j.status}`);
let auth = o.json?.purchase_units?.[0]?.payments?.authorizations?.[0];
if (!auth && o.json?.id) { const a = await api('POST', `/v2/checkout/orders/${o.json.id}/authorize`, {}); log('authorize order', a, j => `status=${j.status}`); auth = a.json?.purchase_units?.[0]?.payments?.authorizations?.[0]; }
if (!auth) process.exit(1);
console.log(`authorization status=${auth.status} amount=${auth.amount.value}`);
for (const [i, v] of [[1, '800.00'], [2, '800.00']]) {
  const c = await api('POST', `/v2/payments/authorizations/${auth.id}/capture`, { amount: { currency_code: 'USD', value: v }, final_capture: false, invoice_id: `SPIKE-${Date.now()}-${i}` });
  log(`partial capture ${i} ($${v}, final_capture=false)`, c, j => `status=${j.status}`);
}
const g = await api('GET', `/v2/payments/authorizations/${auth.id}`); log('get authorization', g, j => `status=${j.status}`);
const r = await api('POST', `/v2/payments/authorizations/${auth.id}/reauthorize`, { amount: { currency_code: 'USD', value: '800.00' } });
log('reauthorize ($800)', r, j => `status=${j.status} newId=${j.id !== auth.id}`);
const target = r.status < 300 ? r.json.id : auth.id;
const v = await api('POST', `/v2/payments/authorizations/${target}/void`); log(`void ${r.status < 300 ? 'reauthorization' : 'original auth'}`, v);
const g2 = await api('GET', `/v2/payments/authorizations/${auth.id}`); log('final original auth', g2, j => `status=${j.status}`);
