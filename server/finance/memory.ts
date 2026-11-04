// Per-client payment-behaviour memory. Learned from recorded PayPal history only (invoices, payments, reminders,
// disputes), keyed by the client's email domain. The strategy it picks changes what the agent proposes:
// invoice terms, whether funds must be held up front, and the negotiation bounds offered to the client's agent.
import { db, invoices } from "../db.js";
import { object, saveObject } from "../db.js";
import { feLog } from "./store.js";

export type Strategy = "trusted" | "standard" | "hold_first";
export type ClientMemory = { domain: string; invoices: number; paid: number; avg_days_to_pay: number | null; late: number; reminders: number; disputes: number; strategy: Strategy; terms_days: number; require_hold: boolean; max_discount_pct: number; min_deposit_pct: number; why: string; updated_at: string };

const domainOf = (email: string) => (email.split("@")[1] || email).toLowerCase();
const days = (a: string, b: string) => (Date.parse(b.includes("T") ? b : b.replace(" ", "T") + "Z") - Date.parse(a.includes("T") ? a : a.replace(" ", "T") + "Z")) / 864e5;

export function learn(email: string): ClientMemory {
  const domain = domainOf(email);
  const mine = (invoices() as any[]).filter(i => domainOf(String(i.email || "")) === domain);
  const paid = mine.filter(i => i.paid_at);
  const waits = paid.map(i => Math.max(0, days(i.created_at, i.paid_at)));
  const avg = waits.length ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10 : null;
  const late = paid.filter(i => i.due_date && Date.parse(i.paid_at.replace(" ", "T") + (i.paid_at.includes("T") ? "" : "Z")) > Date.parse(i.due_date + "T23:59:59Z")).length
    + mine.filter(i => !i.paid_at && ["SENT", "PARTIALLY_PAID"].includes(i.status) && i.due_date && Date.parse(i.due_date + "T23:59:59Z") < Date.now()).length;
  const reminders = mine.length ? (db.prepare(`SELECT COUNT(*) n FROM events WHERE event_type='COLLECTIONS.REMINDED' AND invoice_id IN (${mine.map(() => "?").join(",")})`).get(...mine.map(i => i.id)) as any).n : 0;
  const disputes = (db.prepare("SELECT COUNT(*) n FROM paypal_objects WHERE id LIKE 'fe-dispute:%' AND json_extract(data,'$.domain')=?").get(domain) as any).n;
  let strategy: Strategy = "standard", why = "Not enough history yet; standard terms.";
  if (disputes > 0 || late >= 2 || (avg !== null && avg > 21)) { strategy = "hold_first"; why = disputes ? `Opened ${disputes} dispute(s) before` : late >= 2 ? `Paid late ${late} times` : `Takes ${avg} days to pay on average`; why += "; funds are held at PayPal before work starts, and every release needs a written approval."; }
  else if (paid.length >= 2 && avg !== null && avg <= 5 && late === 0) { strategy = "trusted"; why = `Paid ${paid.length} of ${mine.length} invoices in ${avg} days on average, never late; invoice on delivery, no hold needed.`; }
  const m: ClientMemory = { domain, invoices: mine.length, paid: paid.length, avg_days_to_pay: avg, late, reminders, disputes, strategy,
    terms_days: strategy === "trusted" ? 15 : strategy === "hold_first" ? 3 : 7, require_hold: strategy === "hold_first",
    max_discount_pct: strategy === "trusted" ? 3 : strategy === "standard" ? 2 : 0, min_deposit_pct: strategy === "hold_first" ? 100 : strategy === "standard" ? 30 : 0, why, updated_at: new Date().toISOString() };
  const prev = object("fe-memory:" + domain);
  if (!prev || prev.strategy !== m.strategy) feLog(null, "memory", prev ? `Learned about ${domain}: strategy ${prev.strategy} → ${m.strategy}. ${why}` : `Client profile for ${domain}: ${m.strategy}. ${why}`, { domain });
  saveObject({ id: "fe-memory:" + domain, ...m });
  return m;
}
export const memories = () => (db.prepare("SELECT data FROM paypal_objects WHERE id LIKE 'fe-memory:%'").all() as any[]).map(r => JSON.parse(r.data));
