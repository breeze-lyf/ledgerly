// Autopilot collections: an agent loop (scan → policy check → write → act → log)
// with hard guardrails. Off by default; every decision is logged.
import { randomUUID } from "node:crypto";
import { db, invoices, invoice } from "./db.js";
import { llmConfigured, mock } from "./config.js";
import { scanCollections, reminderPlan, balance } from "./collections.js";
import { action, listeners } from "./service.js";
import { payLinkFor } from "./lifecycle.js";

db.exec(`CREATE TABLE IF NOT EXISTS agent_activity (id TEXT PRIMARY KEY, run_id TEXT, invoice_id TEXT, kind TEXT, decision TEXT, detail TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);

export type Policy = {
  enabled: boolean; max_reminders_per_run: number; max_reminders_per_day: number;
  max_reminders_per_invoice: number; min_days_between: number; approval_threshold: number;
  quiet_start: number; quiet_end: number; timezone: string; interval_minutes: number;
};
export const defaults: Policy = {
  enabled: false, max_reminders_per_run: 3, max_reminders_per_day: 10, max_reminders_per_invoice: 3,
  min_days_between: 3, approval_threshold: 1000, quiet_start: 21, quiet_end: 8,
  timezone: process.env.AUTOPILOT_TZ || "America/New_York", interval_minutes: 30,
};
const clamp = (v: any, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
export function policy(): Policy {
  const r = db.prepare("SELECT value FROM settings WHERE key='autopilot'").get() as any;
  return { ...defaults, ...(r ? JSON.parse(r.value) : {}) };
}
export function setPolicy(p: Partial<Policy>) {
  const c = policy();
  let tz = typeof p.timezone === "string" ? p.timezone : c.timezone;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = c.timezone; }
  const next: Policy = {
    enabled: typeof p.enabled === "boolean" ? p.enabled : c.enabled,
    max_reminders_per_run: clamp(p.max_reminders_per_run ?? c.max_reminders_per_run, 0, 10, 3),
    max_reminders_per_day: clamp(p.max_reminders_per_day ?? c.max_reminders_per_day, 0, 50, 10),
    max_reminders_per_invoice: clamp(p.max_reminders_per_invoice ?? c.max_reminders_per_invoice, 0, 6, 3),
    min_days_between: clamp(p.min_days_between ?? c.min_days_between, 1, 30, 3),
    approval_threshold: clamp(p.approval_threshold ?? c.approval_threshold, 0, 1_000_000, 1000),
    quiet_start: clamp(p.quiet_start ?? c.quiet_start, 0, 23, 21),
    quiet_end: clamp(p.quiet_end ?? c.quiet_end, 0, 23, 8),
    timezone: tz,
    interval_minutes: clamp(p.interval_minutes ?? c.interval_minutes, 5, 1440, 30),
  };
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('autopilot',?)").run(JSON.stringify(next));
  log(null, null, "policy", next.enabled ? "autopilot enabled" : "autopilot disabled", next);
  return next;
}
function log(run: string | null, invoiceId: string | null, kind: string, decision: string, detail: any = {}) {
  const row = { id: randomUUID(), run_id: run, invoice_id: invoiceId, kind, decision, detail: JSON.stringify(detail), created_at: new Date().toISOString() };
  db.prepare("INSERT INTO agent_activity VALUES (@id,@run_id,@invoice_id,@kind,@decision,@detail,@created_at)").run(row);
  for (const fn of listeners) fn({ event_type: "AGENT.ACTIVITY", invoice_id: invoiceId, data: { kind, decision } });
}
export function activity(limit = 60) {
  return (db.prepare("SELECT * FROM agent_activity ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as any[]).map((r) => ({ ...r, detail: JSON.parse(r.detail || "{}") }));
}
export function localHour(tz: string, d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz }).format(d));
}
export function inQuietHours(p: Policy, d = new Date()) {
  const h = localHour(p.timezone, d);
  return p.quiet_start === p.quiet_end ? false : p.quiet_start < p.quiet_end ? h >= p.quiet_start && h < p.quiet_end : h >= p.quiet_start || h < p.quiet_end;
}
function autopilotRemindersSince(iso: string) {
  return (db.prepare("SELECT COUNT(*) n FROM agent_activity WHERE kind='reminder' AND decision='sent' AND created_at>=?").get(iso) as any).n as number;
}

/** LLM-written reminder grounded in real invoice + client history; template fallback. */
export async function writeReminder(i: any): Promise<{ subject: string; message: string; author: string }> {
  const plan = reminderPlan(i);
  const history = invoices().filter((x) => x.client === i.client && x.id !== i.id);
  const facts = {
    client: i.client, amount: i.outstanding ?? balance(i), currency: i.currency, due_date: i.due_date,
    overdue_days: i.overdue_days, tone: i.tone, reminders_already_sent: i.collections_state?.remind_count || 0,
    past_invoices_paid: history.filter((x) => x.status === "PAID").length,
    past_invoices_paid_late: history.filter((x) => x.paid_at && x.due_date && x.paid_at.slice(0, 10) > x.due_date).length,
    merchant: process.env.MERCHANT_NAME || "the freelancer",
  };
  if (!llmConfigured) return { ...plan, author: "template" };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 45000);
    const r = await fetch(process.env.LLM_BASE_URL!.replace(/\/$/, "") + "/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.LLM_API_KEY },
      body: JSON.stringify({ model: process.env.LLM_MODEL, temperature: 0.4, messages: [
        { role: "system", content: "You write short payment reminder notes for a freelancer's PayPal invoice. Use ONLY the facts given; never invent amounts, dates, discounts, penalties or legal threats. Match the requested tone (friendly, firm or final). 2-4 sentences, plain text, no greeting line like 'Subject:', no placeholders, no links (a PayPal pay link is appended automatically). Reply as JSON: {\"subject\": string, \"message\": string}." },
        { role: "user", content: JSON.stringify(facts) },
      ] }),
    });
    clearTimeout(t);
    const d: any = await r.json();
    let text: string = d.choices?.[0]?.message?.content || "";
    text = text.replace(/^```(json)?/m, "").replace(/```\s*$/m, "").trim();
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const amountOk = !/\d/.test(j.message) || j.message.includes(String(Math.round(Number(facts.amount)))) || j.message.includes(Number(facts.amount).toFixed(2)) || !/[$€£¥]\s?\d/.test(j.message);
    if (!j.subject || !j.message || j.message.length > 900 || !amountOk) throw Error("unsafe draft");
    return { subject: String(j.subject).slice(0, 120), message: String(j.message), author: process.env.LLM_MODEL || "llm" };
  } catch { return { ...plan, author: "template (LLM fallback)" }; }
}

let running = false;
export async function runAutopilot(opts: { force?: boolean; trigger?: string } = {}) {
  if (running) return { skipped: "already running" };
  running = true;
  const run = randomUUID().slice(0, 8);
  const p = policy();
  const out = { run_id: run, sent: 0, needs_approval: 0, skipped: 0, decisions: [] as any[] };
  try {
    if (!p.enabled && !opts.force) { return { ...out, skipped_reason: "autopilot disabled" }; }
    log(run, null, "run", "started", { trigger: opts.trigger || "schedule", policy: p });
    if (inQuietHours(p)) { log(run, null, "guardrail", "quiet hours — no reminders sent", { hour: localHour(p.timezone), timezone: p.timezone }); return { ...out, skipped_reason: "quiet hours" }; }
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    let budget = Math.min(p.max_reminders_per_run, p.max_reminders_per_day - autopilotRemindersSince(dayAgo));
    const rows = scanCollections().rows;
    if (!rows.length) log(run, null, "scan", "nothing due or overdue", {});
    for (const i of rows) {
      const count = i.collections_state?.remind_count || 0;
      const last = i.collections_state?.last_remind_at;
      const decide = (decision: string, detail: any = {}) => { out.decisions.push({ invoice_id: i.id, client: i.client, decision }); log(run, i.id, "reminder", decision, { client: i.client, amount: i.outstanding, currency: i.currency, tone: i.tone, ...detail }); };
      if (count >= p.max_reminders_per_invoice) { out.skipped++; decide("skipped: per-invoice cap reached", { remind_count: count, cap: p.max_reminders_per_invoice }); continue; }
      if (last && Date.now() - Date.parse(last) < p.min_days_between * 86400000) { out.skipped++; decide("skipped: reminded recently", { last_remind_at: last }); continue; }
      if (budget <= 0) { out.skipped++; decide("skipped: run/day cap reached", { cap_run: p.max_reminders_per_run, cap_day: p.max_reminders_per_day }); continue; }
      const draft = await writeReminder(i);
      if (i.outstanding > p.approval_threshold) {
        out.needs_approval++; decide("needs human approval: above threshold", { threshold: p.approval_threshold, subject: draft.subject, message: draft.message, author: draft.author }); continue;
      }
      try {
        await action("remind_invoice", { invoice_id: i.id, tone: i.tone, subject: draft.subject, message: draft.message, by: "autopilot" }, true, "autopilot");
        budget--; out.sent++;
        decide("sent", { subject: draft.subject, message: draft.message, author: draft.author, pay_link: payLinkFor(invoice(i.id)), via: mock ? "mock" : "PayPal Invoicing remind API" });
      } catch (e: any) { out.skipped++; decide("failed: " + String(e.message).slice(0, 160)); }
    }
    log(run, null, "run", `finished: ${out.sent} sent, ${out.needs_approval} awaiting approval, ${out.skipped} skipped`, {});
    return out;
  } finally { running = false; }
}
let timer: NodeJS.Timeout | undefined;
export function scheduleAutopilot() {
  if (timer) clearTimeout(timer);
  const tick = async () => { try { if (policy().enabled) await runAutopilot({ trigger: "schedule" }); } catch (e: any) { console.error("autopilot", e.message); } timer = setTimeout(tick, policy().interval_minutes * 60000); timer.unref(); };
  timer = setTimeout(tick, policy().interval_minutes * 60000); timer.unref();
}

/** Outcomes computed only from recorded invoices/events — no projections. */
export function outcomes() {
  const all = invoices();
  const ev = db.prepare("SELECT invoice_id, event_type, created_at, data FROM events WHERE event_type IN ('SEND_INVOICE','COLLECTIONS.REMINDED','REMIND_INVOICE')").all() as any[];
  const firstSent = new Map<string, string>(); const reminders = new Map<string, string[]>();
  for (const e of ev) {
    if (e.event_type === "SEND_INVOICE" && !firstSent.has(e.invoice_id)) firstSent.set(e.invoice_id, e.created_at);
    if (e.event_type === "COLLECTIONS.REMINDED") reminders.set(e.invoice_id, [...(reminders.get(e.invoice_id) || []), e.created_at]);
  }
  const ts = (s: string) => Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  const paid = all.filter((i) => i.status === "PAID" || i.status === "PARTIALLY_REFUNDED" || i.status === "REFUNDED").filter((i) => i.paid_at);
  const daysToPaid = paid.filter((i) => firstSent.has(i.id)).map((i) => (ts(i.paid_at) + 1000 - ts(firstSent.get(i.id)!)) / 86400000).filter((d) => d >= 0).map((d) => Math.max(0, d - 1000 / 86400000));
  const afterReminder = paid.filter((i) => (reminders.get(i.id) || []).some((r) => ts(r) <= ts(i.paid_at) + 1000));
  const remindedInvoices = [...reminders.keys()].filter((id) => all.some((i) => i.id === id));
  const onTime = paid.filter((i) => i.due_date && i.paid_at.slice(0, 10) <= i.due_date).length;
  const viaPayPal = (db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM settlements").get() as any);
  const auto = (db.prepare("SELECT COUNT(*) n FROM agent_activity WHERE kind='reminder' AND decision='sent'").get() as any).n;
  const round = (n: number) => Math.round(n * 10) / 10;
  const currencies = [...new Set(afterReminder.map((i) => i.currency))];
  return {
    paid_invoices: paid.length,
    avg_days_sent_to_paid: daysToPaid.length ? round(daysToPaid.reduce((a, b) => a + b, 0) / daysToPaid.length) : null,
    days_to_paid_sample: daysToPaid.length,
    on_time_rate: paid.length ? Math.round((onTime / paid.length) * 100) : null,
    reminded_invoices: remindedInvoices.length,
    paid_after_reminder: afterReminder.length,
    reminder_conversion: remindedInvoices.length ? Math.round((afterReminder.length / remindedInvoices.length) * 100) : null,
    recovered_after_reminder: Object.fromEntries(currencies.map((c) => [c, Math.round(afterReminder.filter((i) => i.currency === c).reduce((s, i) => s + Number(i.paid_amount || i.amount), 0) * 100) / 100])),
    paid_via_paypal_checkout: { count: viaPayPal.n, amount: Math.round(viaPayPal.s * 100) / 100 },
    autopilot_reminders_sent: auto,
    source: "Computed from Ledgerly's PayPal-synced invoice mirror and event log (no estimates).",
  };
}

/** Pending human approvals: latest above-threshold draft per still-unpaid invoice. */
export function approvals() {
  const rows = db.prepare("SELECT * FROM agent_activity WHERE kind='reminder' ORDER BY created_at DESC, rowid DESC").all() as any[];
  const seen = new Set<string>(); const out: any[] = [];
  for (const r of rows) {
    if (!r.invoice_id || seen.has(r.invoice_id)) continue;
    seen.add(r.invoice_id);
    const i = invoice(r.invoice_id);
    if (r.decision.startsWith("needs human approval") && i && balance(i) > 0 && ["SENT", "PARTIALLY_PAID", "UNPAID"].includes(i.status))
      out.push({ activity_id: r.id, invoice_id: r.invoice_id, ...JSON.parse(r.detail) });
  }
  return out;
}
export async function approve(activityId: string, decision: "approve" | "reject") {
  const r = db.prepare("SELECT * FROM agent_activity WHERE id=?").get(activityId) as any;
  if (!r || !r.decision.startsWith("needs human approval")) throw Error("Nothing to approve");
  const d = JSON.parse(r.detail);
  if (decision === "reject") { log(r.run_id, r.invoice_id, "reminder", "rejected by human", { client: d.client }); return { ok: true }; }
  await action("remind_invoice", { invoice_id: r.invoice_id, tone: d.tone, subject: d.subject, message: d.message, by: "autopilot (human-approved)" }, true, "autopilot");
  log(r.run_id, r.invoice_id, "reminder", "sent (human-approved)", { ...d, pay_link: payLinkFor(invoice(r.invoice_id)) });
  return { ok: true };
}
