// Retainers: true recurring billing via PayPal Catalog Products, Billing Plans and Subscriptions (v1).
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { mock, base } from "./config.js";
import { directPayPal } from "./paypal/index.js";
import { event, listeners } from "./service.js";
import { publicUrl } from "./lifecycle.js";

db.exec(`CREATE TABLE IF NOT EXISTS retainers (
  id TEXT PRIMARY KEY, client TEXT NOT NULL, email TEXT, amount REAL NOT NULL, currency TEXT NOT NULL,
  months INTEGER NOT NULL, product_id TEXT, plan_id TEXT, subscription_id TEXT UNIQUE, status TEXT NOT NULL,
  approve_url TEXT, cycles_paid INTEGER NOT NULL DEFAULT 0, collected REAL NOT NULL DEFAULT 0,
  last_payment_at TEXT, failed_payments INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

const mockStore = new Map<string, any>();
async function pp(path: string, method = "GET", body?: any): Promise<any> {
  if (!mock) return (directPayPal as any).request(path, method, body);
  const id = (p: string) => p + "-" + randomUUID().slice(0, 8).toUpperCase();
  if (path === "/v1/catalogs/products") return { id: id("PROD"), ...body };
  if (path === "/v1/billing/plans") return { id: id("P"), status: "ACTIVE", ...body };
  if (path === "/v1/billing/subscriptions") {
    const s = { id: id("I"), status: "APPROVAL_PENDING", plan_id: body.plan_id, custom_id: body.custom_id,
      links: [{ rel: "approve", href: `${publicUrl()}${base}?retainer=${body.custom_id}&mock=approve` }] };
    mockStore.set(s.id, s); return s;
  }
  const m = path.match(/^\/v1\/billing\/subscriptions\/([^/]+)(\/cancel)?$/);
  if (m) { const s = mockStore.get(m[1]) || { id: m[1], status: "ACTIVE" }; if (m[2]) s.status = "CANCELLED"; return s; }
  throw Error("mock: unsupported " + path);
}

export function retainers() { return db.prepare("SELECT * FROM retainers ORDER BY created_at DESC, rowid DESC").all() as any[]; }
export function retainer(ref: string) {
  return db.prepare("SELECT * FROM retainers WHERE id=? OR subscription_id=?").get(ref, ref) as any;
}
export function retainerArgs(a: any) {
  const amount = Number(a.amount ?? a.monthly_amount);
  const months = Math.round(Number(a.months ?? a.count ?? 0));
  const client = String(a.client_name || a.client || "").trim();
  if (!client) throw Error("Who is the client?");
  if (!(amount > 0) || amount > 100000) throw Error("Monthly amount must be between 0 and 100,000.");
  if (!(months >= 1 && months <= 36)) throw Error("Months must be between 1 and 36.");
  const email = a.client_email || a.email || undefined;
  if (email && !/^[\w.+-]+@[\w.-]+\.[a-z]+$/i.test(email)) throw Error("Invalid client email.");
  return { client_name: client, client_email: email, amount: Math.round(amount * 100) / 100, months, currency: String(a.currency || "USD").toUpperCase() };
}

/** Creates Product → Plan (N monthly cycles) → Subscription, and returns the client approval link. */
export async function createRetainer(input: any, by = "user") {
  const a = retainerArgs(input);
  const id = "RET-" + randomUUID().slice(0, 8).toUpperCase();
  const product = await pp("/v1/catalogs/products", "POST", { name: `${a.client_name} retainer`.slice(0, 127), type: "SERVICE", category: "SOFTWARE" });
  const plan = await pp("/v1/billing/plans", "POST", {
    product_id: product.id, name: `${a.client_name} — ${a.currency} ${a.amount}/month × ${a.months}`.slice(0, 127), status: "ACTIVE",
    billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1,
      total_cycles: a.months, pricing_scheme: { fixed_price: { value: a.amount.toFixed(2), currency_code: a.currency } } }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: "CONTINUE", payment_failure_threshold: 2 },
  });
  const sub = await pp("/v1/billing/subscriptions", "POST", {
    plan_id: plan.id, custom_id: id,
    subscriber: { ...(a.client_email ? { email_address: a.client_email } : {}), name: { given_name: a.client_name.slice(0, 140) } },
    application_context: { brand_name: "Ledgerly", user_action: "SUBSCRIBE_NOW", shipping_preference: "NO_SHIPPING",
      return_url: `${publicUrl()}${base}?retainer=${id}&status=approved`, cancel_url: `${publicUrl()}${base}?retainer=${id}&status=cancelled` },
  });
  const approve = sub.links?.find((l: any) => l.rel === "approve")?.href || null;
  db.prepare("INSERT INTO retainers (id,client,email,amount,currency,months,product_id,plan_id,subscription_id,status,approve_url) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, a.client_name, a.client_email || null, a.amount, a.currency, a.months, product.id, plan.id, sub.id, sub.status || "APPROVAL_PENDING", approve);
  event(id, "RETAINER.CREATED", { by, subscription_id: sub.id, plan_id: plan.id, product_id: product.id, amount: a.amount, months: a.months });
  return { kind: "retainer", ...retainer(id) };
}

export async function cancelRetainer(ref: string, reason = "Cancelled from Ledgerly") {
  const r = retainer(ref);
  if (!r) throw Error("Retainer not found");
  if (["CANCELLED", "EXPIRED"].includes(r.status)) return { kind: "retainer", ...r };
  await pp(`/v1/billing/subscriptions/${r.subscription_id}/cancel`, "POST", { reason });
  db.prepare("UPDATE retainers SET status='CANCELLED' WHERE id=?").run(r.id);
  event(r.id, "RETAINER.CANCELLED", { by: "user" });
  return { kind: "retainer", ...retainer(r.id) };
}

/** Pulls the subscription status from PayPal (fallback when webhooks are late). */
export async function syncRetainer(ref: string) {
  const r = retainer(ref);
  if (!r) throw Error("Retainer not found");
  const s = await pp(`/v1/billing/subscriptions/${r.subscription_id}`);
  const paid = Number(s.billing_info?.cycle_executions?.find((c: any) => c.tenure_type === "REGULAR")?.cycles_completed ?? r.cycles_paid);
  if (s.status && (s.status !== r.status || paid !== r.cycles_paid)) {
    db.prepare("UPDATE retainers SET status=?, cycles_paid=MAX(cycles_paid,?) WHERE id=?").run(s.status, paid, r.id);
    event(r.id, "RETAINER.SYNCED", { status: s.status, cycles_paid: paid });
  }
  return { kind: "retainer", ...retainer(r.id) };
}

const statusFor: Record<string, string> = {
  "BILLING.SUBSCRIPTION.ACTIVATED": "ACTIVE", "BILLING.SUBSCRIPTION.CANCELLED": "CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED": "SUSPENDED", "BILLING.SUBSCRIPTION.EXPIRED": "EXPIRED",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED": "ACTIVE",
};
/** Returns true when the webhook belonged to a retainer (applied at most once per event id). */
export function retainerWebhook(e: any): boolean {
  const t = e.event_type, r = e.resource || {};
  if (!t.startsWith("BILLING.SUBSCRIPTION.") && t !== "PAYMENT.SALE.COMPLETED") return false;
  const sid = t === "PAYMENT.SALE.COMPLETED" ? r.billing_agreement_id : r.id;
  const row = sid && (retainer(sid) || (r.custom_id && retainer(r.custom_id)));
  if (!row) return t.startsWith("BILLING.SUBSCRIPTION.");
  const fresh = db.prepare("INSERT OR IGNORE INTO events (id,invoice_id,event_type,data) VALUES (?,?,?,?)").run(e.id, row.id, t, JSON.stringify(e));
  if (!fresh.changes) return true;
  if (statusFor[t]) {
    db.prepare("UPDATE retainers SET status=? WHERE id=?").run(statusFor[t], row.id);
    event(row.id, "RETAINER." + statusFor[t], { subscription_id: row.subscription_id });
  } else if (t === "PAYMENT.SALE.COMPLETED") {
    const amt = Number(r.amount?.total ?? r.amount?.value ?? row.amount);
    db.prepare("UPDATE retainers SET cycles_paid=cycles_paid+1, collected=ROUND(collected+?,2), last_payment_at=?, status=CASE WHEN status='APPROVAL_PENDING' THEN 'ACTIVE' ELSE status END WHERE id=?")
      .run(amt, new Date().toISOString(), row.id);
    event(row.id, "RETAINER.PAYMENT_RECEIVED", { sale_id: r.id, amount: amt });
  } else if (t === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") {
    db.prepare("UPDATE retainers SET failed_payments=failed_payments+1 WHERE id=?").run(row.id);
    event(row.id, "RETAINER.PAYMENT_FAILED", { subscription_id: row.subscription_id });
  }
  for (const fn of listeners) fn({ ...e, invoice_id: row.id });
  return true;
}

/** Mock-mode helper for tests and the local demo: simulate a subscription webhook. */
export function simulatedRetainerEvent(type: string, ref: string, amount?: number) {
  const r = retainer(ref);
  if (!r) throw Error("Retainer not found");
  const resource = type === "PAYMENT.SALE.COMPLETED"
    ? { id: "SALE-" + randomUUID().slice(0, 8), billing_agreement_id: r.subscription_id, amount: { total: String(amount ?? r.amount), currency: r.currency } }
    : { id: r.subscription_id, custom_id: r.id, status: statusFor[type] };
  return { id: "WH-" + randomUUID(), event_type: type, resource };
}
export const retainerEventTypes = ["BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED", "BILLING.SUBSCRIPTION.PAYMENT.FAILED", "PAYMENT.SALE.COMPLETED"];
