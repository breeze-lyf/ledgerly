// Client pay page + PayPal payment lifecycle: orders tied to invoices, idempotent
// settlement from captures/webhooks, and a periodic status sync fallback.
import { base, mock } from "./config.js";
import { db, invoice, invoices, saveObject, order, object } from "./db.js";
import { paypal } from "./paypal/index.js";
import { event, captureApproved } from "./service.js";
import { balance } from "./collections.js";

for (const [table, column, type] of [["orders", "invoice_id", "TEXT"]]) {
  if (!(db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS settlements (capture_id TEXT PRIMARY KEY, invoice_id TEXT, amount REAL, currency TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

export const publicUrl = () => (process.env.PUBLIC_URL || "https://ledgerly.yufeng.fun").replace(/\/$/, "");
export function payLink(ref: string) { return `${publicUrl()}${base}pay/${encodeURIComponent(ref)}`; }
export function invoiceNumber(i: any) {
  try { return JSON.parse(i.data || "{}").detail?.invoice_number; } catch { return undefined; }
}
export function payRef(i: any) { return invoiceNumber(i) || i.id; }
export function payLinkFor(i: any) { return payLink(payRef(i)); }
export function invoiceByRef(ref: string) {
  return invoice(ref) || (db.prepare("SELECT * FROM invoices WHERE json_extract(data,'$.detail.invoice_number')=?").get(ref) as any);
}
const PAYABLE = ["SENT", "PARTIALLY_PAID", "UNPAID", "PAYMENT_PENDING"];

export function payInfo(ref: string) {
  const i = invoiceByRef(ref);
  if (!i) throw Error("Invoice not found");
  const data = JSON.parse(i.data || "{}");
  return {
    invoice_id: i.id, invoice_number: invoiceNumber(i), client: i.client, amount: i.amount,
    balance: balance(i), currency: i.currency, status: i.status, due_date: i.due_date,
    items: (data.items || []).map((x: any) => ({ name: x.name, quantity: x.quantity, unit_amount: x.unit_amount?.value })),
    merchant: process.env.MERCHANT_NAME || "Ledgerly freelancer",
    payable: PAYABLE.includes(i.status) && balance(i) > 0,
    paypal: { mode: mock ? "mock" : "sandbox", client_id: mock ? null : process.env.PAYPAL_CLIENT_ID },
  };
}

export async function createPayOrder(ref: string) {
  const i = invoiceByRef(ref);
  if (!i) throw Error("Invoice not found");
  if (!PAYABLE.includes(i.status) || balance(i) <= 0) throw Error(`Invoice is ${i.status}; nothing to pay`);
  const value = balance(i).toFixed(2);
  const o = await paypal.createOrder({
    intent: "CAPTURE",
    purchase_units: [{ reference_id: i.id, custom_id: i.id, description: `Invoice ${invoiceNumber(i) || i.id}`.slice(0, 127),
      amount: { currency_code: i.currency, value } }],
    application_context: { brand_name: "Ledgerly", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" },
  });
  const approve = o.links?.find((l: any) => ["approve", "payer-action"].includes(l.rel))?.href || null;
  db.prepare("INSERT OR IGNORE INTO orders(id,description,amount,currency,status,approve_url,data,invoice_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(o.id, `Pay page · ${i.client}`, Number(value), i.currency, o.status, approve, JSON.stringify(o), i.id);
  event(i.id, "PAYPAGE.ORDER_CREATED", { order_id: o.id, amount: Number(value) });
  return { id: o.id, approve_url: approve };
}

export async function capturePayOrder(ref: string, orderId: string) {
  const i = invoiceByRef(ref);
  const o = order(orderId);
  if (!i || !o || o.invoice_id !== i.id) throw Error("Order does not belong to this invoice");
  await captureApproved(orderId);
  return payInfo(ref);
}

/** Idempotently apply a completed capture to its invoice (pay page, webhook, or sync). */
export async function settleInvoiceCapture(invoiceId: string, capture: any, source: string) {
  const i = invoice(invoiceId);
  if (!i || !capture?.id) return false;
  if (capture.status && !["COMPLETED"].includes(capture.status)) return false;
  const inserted = db.prepare("INSERT OR IGNORE INTO settlements(capture_id,invoice_id,amount,currency,status) VALUES (?,?,?,?,?)")
    .run(capture.id, i.id, Number(capture.amount?.value), capture.amount?.currency_code, "COMPLETED");
  if (!inserted.changes) return false;
  const amount = Number(capture.amount?.value || 0);
  const paid = Math.round((Number(i.paid_amount || 0) + amount) * 100) / 100;
  // Mirror the PayPal capture onto the PayPal invoice so PayPal's invoice state is PAID too.
  let remote: any;
  if (["SENT", "PARTIALLY_PAID", "UNPAID", "PAYMENT_PENDING"].includes(i.status)) {
    try {
      remote = await paypal.recordPayment(i.paypal_id, { method: "PAYPAL", payment_date: new Date().toISOString().slice(0, 10),
        note: `PayPal capture ${capture.id}`, amount: { currency_code: i.currency, value: amount.toFixed(2) } });
      if (!mock) remote = await paypal.getInvoice(i.paypal_id);
    } catch (e: any) { event(i.id, "PAYPAL.INVOICE_RECORD_FAILED", { capture_id: capture.id, error: String(e.message).slice(0, 200) }); }
  }
  const status = paid + 0.001 >= i.amount ? "PAID" : "PARTIALLY_PAID";
  const data = { ...JSON.parse(i.data || "{}"), ...(remote?.id ? remote : {}), capture_id: capture.id, payment_id: capture.id };
  db.prepare("UPDATE invoices SET status=?, paid_amount=?, data=? WHERE id=?").run(status, paid, JSON.stringify(data), i.id);
  saveObject({ ...capture, invoice_id: i.id });
  event(i.id, "INVOICE.PAID_VIA_PAYPAL", { capture_id: capture.id, amount, currency: capture.amount?.currency_code, source, status });
  return true;
}

export function invoiceForCapture(captureOrRefund: any): string | undefined {
  const r = captureOrRefund || {};
  if (r.custom_id && invoice(r.custom_id)) return invoice(r.custom_id).id;
  const capId = r.links?.find((l: any) => l.rel === "up" && /captures\//.test(l.href))?.href.split("/").pop() || r.capture_id || r.id;
  const s = db.prepare("SELECT invoice_id FROM settlements WHERE capture_id=?").get(capId) as any;
  if (s) return s.invoice_id;
  const orderId = r.supplementary_data?.related_ids?.order_id;
  return orderId ? order(orderId)?.invoice_id || undefined : undefined;
}

const remoteMap: Record<string, string> = { MARKED_AS_PAID: "PAID", MARKED_AS_REFUNDED: "REFUNDED" };
/** Pull canonical status from PayPal for open invoices; fallback when a webhook is missed. */
export async function syncInvoices(limit = 40) {
  if (mock) return { checked: 0, changed: [] as any[], skipped: "mock" };
  const open = invoices().filter((i) => i.paypal_id && ["SENT", "PARTIALLY_PAID", "UNPAID", "PAYMENT_PENDING", "PAID", "PARTIALLY_REFUNDED"].includes(i.status)).slice(0, limit);
  const changed: any[] = [];
  for (const i of open) {
    try {
      const remote = await paypal.getInvoice(i.paypal_id);
      const status = remoteMap[remote.status] || remote.status;
      // Local refund states are derived locally; PayPal may keep reporting PAID.
      if (["PARTIALLY_REFUNDED", "REFUNDED"].includes(i.status) && ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(status)) continue;
      if (status && status !== i.status) {
        const paid = Number(remote.payments?.paid_amount?.value ?? i.paid_amount ?? 0);
        db.prepare("UPDATE invoices SET status=?, paid_amount=?, data=? WHERE id=?").run(status, paid, JSON.stringify({ ...JSON.parse(i.data || "{}"), ...remote }), i.id);
        saveObject(remote);
        event(i.id, status === "PAID" ? "SYNC.PAID" : "SYNC.STATUS_CHANGED", { from: i.status, to: status, source: "PayPal invoice API" });
        changed.push({ id: i.id, from: i.status, to: status });
      }
    } catch (e: any) { /* one bad invoice must not stop the sweep */ }
  }
  // Pay-page orders approved but never captured (missed CHECKOUT.ORDER.APPROVED webhook).
  for (const o of db.prepare("SELECT * FROM orders WHERE invoice_id IS NOT NULL AND capture_id IS NULL AND created_at >= datetime('now','-2 days')").all() as any[]) {
    try { const r = await paypal.getOrder(o.id); if (r.status === "APPROVED") { await captureApproved(o.id); changed.push({ id: o.invoice_id, order: o.id, to: "CAPTURED" }); } } catch { /* ignore */ }
  }
  db.prepare("INSERT OR REPLACE INTO paypal_objects VALUES ('ledgerly:last_sync',?)").run(JSON.stringify({ at: new Date().toISOString(), checked: open.length, changed: changed.length }));
  return { checked: open.length, changed };
}
export function lastSync() { return object("ledgerly:last_sync") || null; }
