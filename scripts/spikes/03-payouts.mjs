// Spike 3: Payouts batch to a sandbox email (a fake address under example.com unless PAYOUT_RECEIVER is set), then poll status.
import { api, log } from './_pp.mjs';
const receiver = process.env.PAYOUT_RECEIVER || 'subcontractor-demo@example.com';
const b = await api('POST', '/v1/payments/payouts', { sender_batch_header: { sender_batch_id: `spike-${Date.now()}`, email_subject: 'Your share of milestone 2', email_message: 'Split from Ledgerly' }, items: [{ recipient_type: 'EMAIL', amount: { value: '24.00', currency: 'USD' }, receiver, note: '30% split, milestone 2', sender_item_id: 'split-1' }] });
log('create payout batch', b, j => `batch_status=${j.batch_header?.batch_status}`);
const id = b.json?.batch_header?.payout_batch_id; if (!id) process.exit(1);
for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const s = await api('GET', `/v1/payments/payouts/${id}`);
  log(`get batch (poll ${i})`, s, j => `batch_status=${j.batch_header?.batch_status} item_status=${j.items?.[0]?.transaction_status}`);
  if (['SUCCESS', 'DENIED'].includes(s.json?.batch_header?.batch_status)) break;
}
