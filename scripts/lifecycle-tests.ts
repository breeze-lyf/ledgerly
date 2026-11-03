// Mock-mode tests for the pay-page lifecycle, webhook idempotency, and autopilot guardrails.
import assert from "node:assert/strict";
import { action, webhook } from "../server/service.js";
import { db, invoice, object, saveObject, order } from "../server/db.js";
import { payInfo, createPayOrder, capturePayOrder, payLinkFor, invoiceForCapture } from "../server/lifecycle.js";
import { setPolicy, runAutopilot, outcomes, approvals, approve, inQuietHours, defaults } from "../server/autopilot.js";

async function newInvoice(client: string, amount: number, dueInDays = -5) {
  const [i] = await action("create_invoice", { client_name: client, client_email: "ap@example.com", due_in_days: dueInDays,
    items: [{ name: "Work", quantity: 1, unit_amount: amount }] }, false, "t");
  await action("send_invoice", { invoice_id: i.id }, true, "t");
  return invoice(i.id);
}
// 1. Pay link is embedded in the PayPal invoice note and resolvable by invoice number.
const a = await newInvoice("Acme Pay", 250, 7);
const data = JSON.parse(a.data);
assert.match(data.detail.note, /Pay online with PayPal: https?:\/\/.+\/pay\/LL-/);
assert.equal(payInfo(data.detail.invoice_number).invoice_id, a.id);
assert.equal(payInfo(a.id).payable, true);
assert.match(payLinkFor(a), /\/pay\/LL-/);
// 2. Pay page order → (buyer approves) → capture → invoice PAID, once.
const o = await createPayOrder(a.id);
assert.equal(order(o.id).invoice_id, a.id);
saveObject({ ...object(o.id), status: "APPROVED" });
const after = await capturePayOrder(a.id, o.id);
assert.equal(after.status, "PAID");
assert.equal(invoice(a.id).paid_amount, 250);
const capId = order(o.id).capture_id;
assert.equal(invoiceForCapture({ id: capId }), a.id);
// 3. Webhook replay + redelivery are idempotent (no double payment).
const completed = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: capId, status: "COMPLETED", custom_id: a.id, amount: { currency_code: "USD", value: "250.00" } } };
await webhook(completed); await webhook(completed); await webhook({ ...completed, id: "WH-2" });
assert.equal(invoice(a.id).paid_amount, 250);
assert.equal((db.prepare("SELECT COUNT(*) n FROM settlements WHERE invoice_id=?").get(a.id) as any).n, 1);
// 4. Capture refunded webhook (refund made in PayPal) updates the invoice once.
const refund = { id: "WH-3", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF-X", amount: { currency_code: "USD", value: "50.00" }, links: [{ rel: "up", href: "https://api/v2/payments/captures/" + capId }] } };
await webhook(refund); await webhook({ ...refund, id: "WH-4" });
assert.equal(invoice(a.id).refunded, 50);
assert.equal(invoice(a.id).status, "PARTIALLY_REFUNDED");
await assert.rejects(createPayOrder(a.id), /nothing to pay/);
// 5. Denied capture keeps invoice payable.
const b = await newInvoice("Denied Co", 80, 3);
const ob = await createPayOrder(b.id);
await webhook({ id: "WH-5", event_type: "PAYMENT.CAPTURE.DENIED", resource: { id: "CAP-DENIED", status: "DECLINED", custom_id: b.id, supplementary_data: { related_ids: { order_id: ob.id } } } });
assert.equal(invoice(b.id).status, "SENT");
assert.ok(db.prepare("SELECT 1 FROM events WHERE invoice_id=? AND event_type='PAYMENT.DENIED'").get(b.id));
// 6. Invoice-level webhooks.
const c = await newInvoice("Cancel Co", 40, 3);
await webhook({ id: "WH-6", event_type: "INVOICING.INVOICE.CANCELLED", resource: { id: c.id, status: "CANCELLED" } });
assert.equal(invoice(c.id).status, "CANCELLED");
// 7. Autopilot guardrails.
assert.equal(defaults.enabled, false);
assert.equal((await runAutopilot({ trigger: "test" }) as any).skipped_reason, "autopilot disabled");
const small = await newInvoice("Small Late", 120, -10);
const big = await newInvoice("Big Late", 5000, -10);
setPolicy({ enabled: true, quiet_start: 0, quiet_end: 0, approval_threshold: 1000, max_reminders_per_run: 5, max_reminders_per_invoice: 2 });
assert.equal(inQuietHours({ ...defaults, quiet_start: 0, quiet_end: 0 }), false);
const run1: any = await runAutopilot({ trigger: "test" });
assert.ok(run1.decisions.some((d: any) => d.invoice_id === small.id && d.decision === "sent"));
assert.ok(run1.decisions.some((d: any) => d.invoice_id === big.id && d.decision.startsWith("needs human approval")));
assert.ok(db.prepare("SELECT 1 FROM events WHERE invoice_id=? AND event_type='COLLECTIONS.REMINDED'").get(small.id));
assert.ok(!db.prepare("SELECT 1 FROM events WHERE invoice_id=? AND event_type='COLLECTIONS.REMINDED'").get(big.id));
// Recently reminded → skipped on the next run.
const run2: any = await runAutopilot({ trigger: "test" });
assert.ok(run2.decisions.some((d: any) => d.invoice_id === small.id && /reminded recently/.test(d.decision)));
// Human approval sends the held reminder.
const pend = approvals().find((p: any) => p.invoice_id === big.id);
assert.ok(pend);
await approve(pend.activity_id, "approve");
assert.ok(db.prepare("SELECT 1 FROM events WHERE invoice_id=? AND event_type='COLLECTIONS.REMINDED'").get(big.id));
assert.ok(!approvals().some((p: any) => p.invoice_id === big.id));
// Quiet hours block everything.
setPolicy({ quiet_start: 0, quiet_end: 23 });
const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "America/New_York" }).format(new Date()));
if (h < 23) assert.equal((await runAutopilot({ trigger: "test" }) as any).skipped_reason, "quiet hours");
// 8. Outcomes come from real rows only.
await webhook({ id: "WH-7", event_type: "INVOICING.INVOICE.PAID", resource: { id: small.id, status: "PAID" } });
const out = outcomes();
assert.ok(out.paid_invoices >= 2);
assert.ok(out.paid_after_reminder >= 1);
assert.equal(out.recovered_after_reminder.USD, 120);
assert.equal(out.paid_via_paypal_checkout.count, 1);
assert.ok(out.avg_days_sent_to_paid !== null);
console.log("lifecycle tests passed");
