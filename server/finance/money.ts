// Milestone money flow on PayPal: one authorization holds the unreleased project amount (up to 29 days; this is a
// card/PayPal authorization hold, not escrow). Each approved milestone is a partial capture (final_capture=false
// until the last). A single reauthorization is scheduled on day 4 (PayPal allows it once, days 4–29). Payouts split
// captured money to subcontractors. All PayPal calls carry deterministic PayPal-Request-Ids for idempotency.
import { base } from "../config.js";
import { object, saveObject } from "../db.js";
import { paypal } from "../paypal/index.js";
import { holdRemaining, plans, resume, runners, savePlan } from "./plans.js";
import { feLog, money, project, projects, saveProject, type Project } from "./store.js";

const DAY = 864e5;
const unreleased = (p: Project) => money(p.milestones.filter(m => m.status !== "released").reduce((a, m) => a + m.amount, 0));

export function holdInfo(projectId: string) {
  const p = project(projectId);
  if (!p) throw Error("project not found");
  return { project_id: p.id, title: p.title, client: p.client, currency: p.currency, amount: p.hold?.amount ?? unreleased(p),
    milestones: p.milestones.map(({ id, title, amount, status }) => ({ id, title, amount, status })), hold: p.hold || null,
    paypal: { client_id: process.env.PAYPAL_CLIENT_ID || "", mode: process.env.PAYPAL_MODE === "sandbox" ? "sandbox" : "mock" } };
}

export async function createHoldOrder(projectId: string) {
  const p = project(projectId);
  if (!p) throw Error("project not found");
  if (p.hold?.status === "active") throw Error("funds are already held for this project");
  const amount = unreleased(p);
  if (!(amount > 0)) throw Error("nothing left to hold");
  const o = await paypal.createOrder({ intent: "AUTHORIZE", purchase_units: [{ reference_id: p.id, custom_id: p.id, description: `${p.title}: held for ${p.milestones.filter(m => m.status !== "released").length} milestones`.slice(0, 127), amount: { currency_code: p.currency, value: amount.toFixed(2) } }],
    application_context: { shipping_preference: "NO_SHIPPING", user_action: "CONTINUE", return_url: absolute(`hold/${p.id}?approved=1`), cancel_url: absolute(`hold/${p.id}`) } });
  p.hold = { status: "created", order_id: o.id, amount, captured: 0, captures: [] }; saveProject(p);
  feLog(p.id, "hold", `Hold requested: ${amount.toFixed(2)} ${p.currency} (PayPal order ${o.id})`);
  return { id: o.id, approve_url: o.links?.find((l: any) => ["approve", "payer-action"].includes(l.rel))?.href };
}
const absolute = (path: string) => (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "") + base + path;

export async function authorizeHold(projectId: string, orderId: string) {
  const p = project(projectId);
  if (!p?.hold || p.hold.order_id !== orderId) throw Error("unknown hold order");
  if (p.hold.status === "active") return p.hold;
  const o = await paypal.authorizeOrder(orderId);
  const a = o.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!a || !["CREATED", "PENDING"].includes(a.status)) throw Error(`authorization not created (${a?.status || o.status})`);
  const at = a.create_time || new Date().toISOString();
  p.hold = { ...p.hold, status: "active", authorization_id: a.id, authorized_at: at, honor_until: new Date(Date.parse(at) + 3 * DAY).toISOString(),
    reauthorize_after: new Date(Date.parse(at) + 3 * DAY).toISOString(), expires_at: a.expiration_time || new Date(Date.parse(at) + 29 * DAY).toISOString(), reauthorized: false };
  saveProject(p);
  feLog(p.id, "hold", `Client authorized ${Number(a.amount?.value || p.hold.amount).toFixed(2)} ${p.currency}. Funds are held, not captured.`, { authorization_id: a.id });
  return p.hold;
}

// Approved milestone → partial capture against the hold.
runners.capture_hold = async (s, plan, proj) => {
  const remaining = holdRemaining(proj);
  if (!proj.hold?.authorization_id || proj.hold.status !== "active") throw Error("no active PayPal hold");
  if ((s.amount || 0) > remaining + 0.001) throw Error(`capture ${s.amount} exceeds the ${remaining} still held`);
  if (proj.hold.expires_at && Date.now() > Date.parse(proj.hold.expires_at)) throw Error("the authorization has expired; send an invoice instead");
  const final = !!s.final || Math.abs(remaining - (s.amount || 0)) < 0.01;
  const c = await paypal.captureAuthorization(proj.hold.authorization_id, { amount: { currency_code: proj.currency, value: s.amount!.toFixed(2) }, final_capture: final,
    invoice_id: `${proj.id}-${plan.milestone_id}`.slice(0, 127), note_to_payer: `Milestone ${plan.milestone_id} released` }, `ledgerly-cap-${plan.id}`);
  if (!["COMPLETED", "PENDING"].includes(c.status)) throw Error(`capture ${c.status}`);
  const fresh = project(proj.id)!;
  if (!fresh.hold.captures.some((x: any) => x.id === c.id)) { fresh.hold.captures.push({ id: c.id, amount: s.amount, milestone_id: plan.milestone_id, status: c.status }); fresh.hold.captured = money(fresh.hold.captured + s.amount!); }
  if (final) fresh.hold.status = "captured";
  saveProject(fresh); Object.assign(proj, fresh);
  return { status: c.status === "COMPLETED" ? "done" : "waiting", result: { capture_id: c.id, capture_status: c.status, final_capture: final } };
};

// Split → PayPal Payouts. Guardrails: recipient must be a configured split; total payouts ≤ 90% of money received.
runners.payout = async (s, plan, proj) => {
  if (s.result?.payout_batch_id) return { status: "done", result: s.result };
  if (!proj.splits.some(x => x.email === s.to)) throw Error("recipient is not a configured split");
  const received = plan.steps.filter(x => (x.type === "capture_hold" || x.type === "invoice") && x.status === "done").reduce((a, x) => a + (x.amount || 0), 0);
  const paying = plan.steps.filter(x => x.type === "payout" && (x.status === "done" || x === s)).reduce((a, x) => a + (x.amount || 0), 0);
  if (paying > received * 0.9 + 0.001) throw Error("payouts would exceed 90% of the money received");
  const senderBatchId = `${plan.id}-${s.id}`;
  const r = await paypal.createPayout({ sender_batch_header: { sender_batch_id: senderBatchId, email_subject: `Your share of ${proj.title}`, email_message: `Split for milestone ${plan.milestone_id}, sent by Ledgerly.` },
    items: [{ recipient_type: "EMAIL", receiver: s.to, amount: { value: s.amount!.toFixed(2), currency: proj.currency }, note: `${proj.title} — milestone ${plan.milestone_id}`, sender_item_id: senderBatchId }] }, "ledgerly-payout-" + senderBatchId);
  const id = r.batch_header?.payout_batch_id;
  if (!id) throw Error("payout batch not created");
  saveObject({ id: "fe-payout:" + id, plan_id: plan.id, step_id: s.id, project_id: proj.id, status: r.batch_header.batch_status });
  return { status: "done", result: { payout_batch_id: id, batch_status: r.batch_header.batch_status } };
};

// One reauthorization per hold, from day 4 (PayPal: once, days 4–29). Run by an hourly sweep.
export async function reauthorizeDue(now = Date.now()) {
  const done: string[] = [];
  for (const p of projects()) {
    const h = p.hold;
    if (h?.status !== "active" || h.reauthorized || !h.authorization_id) continue;
    if (now < Date.parse(h.reauthorize_after) || now > Date.parse(h.expires_at)) continue;
    const remaining = holdRemaining(p);
    if (!(remaining > 0)) continue;
    try {
      const a = await paypal.reauthorizeAuthorization(h.authorization_id, { amount: { currency_code: p.currency, value: remaining.toFixed(2) } }, "ledgerly-reauth-" + h.authorization_id);
      // The new authorization holds the remaining amount; captures so far stay on the original.
      p.hold = { ...h, reauthorized: true, previous_authorization_id: h.authorization_id, authorization_id: a.id, amount: money(h.captured + remaining), reauthorized_at: new Date(now).toISOString(), honor_until: new Date(now + 3 * DAY).toISOString() };
      saveProject(p); done.push(p.id);
      feLog(p.id, "hold", `Reauthorized the remaining ${remaining.toFixed(2)} ${p.currency} (day ${Math.floor((now - Date.parse(h.authorized_at)) / DAY) + 1}); new honor period started.`, { authorization_id: a.id });
    } catch (e: any) {
      p.hold = { ...h, reauthorized: true, reauth_error: String(e.message).slice(0, 200) }; saveProject(p);
      feLog(p.id, "error", `Reauthorization failed: ${String(e.message).slice(0, 160)}. Remaining milestones will be invoiced instead.`);
    }
  }
  return done;
}

export async function voidHold(projectId: string) {
  const p = project(projectId);
  if (!p?.hold?.authorization_id || p.hold.status !== "active") throw Error("no active hold");
  await paypal.voidAuthorization(p.hold.authorization_id);
  const released = holdRemaining(p);
  p.hold = { ...p.hold, status: "voided" }; saveProject(p);
  feLog(p.id, "hold", `Released the remaining ${released.toFixed(2)} ${p.currency} back to the client (authorization voided).`);
  return p.hold;
}

// PayPal webhooks for holds and payouts. Returns true when handled here.
export async function financeWebhook(e: any) {
  const t: string = e?.event_type || "", r = e?.resource || {};
  if (t === "CHECKOUT.ORDER.APPROVED" && r.intent === "AUTHORIZE") {
    const p = projects().find(x => x.hold?.order_id === r.id);
    if (p) await authorizeHold(p.id, r.id);
    return true;
  }
  if (t.startsWith("PAYMENT.AUTHORIZATION.")) {
    const p = projects().find(x => x.hold?.authorization_id === r.id);
    if (p && t === "PAYMENT.AUTHORIZATION.VOIDED" && p.hold.status === "active") { p.hold.status = "voided"; saveProject(p); feLog(p.id, "hold", "PayPal reports the hold was voided."); }
    return !!p;
  }
  if (t.startsWith("PAYMENT.CAPTURE.")) {
    const p = projects().find(x => x.hold?.captures?.some((c: any) => c.id === r.id));
    if (!p) return false;
    const c = p.hold.captures.find((x: any) => x.id === r.id); c.status = r.status || c.status; saveProject(p);
    if (t === "PAYMENT.CAPTURE.COMPLETED") {
      for (const pl of plans("approved").filter(x => x.project_id === p.id)) {
        const s = pl.steps.find(x => x.type === "capture_hold" && x.result?.capture_id === r.id);
        if (s && s.status !== "done") { s.status = "done"; savePlan(pl); await resume(p.id, pl.milestone_id); }
      }
    }
    return true;
  }
  if (t.startsWith("PAYMENT.PAYOUTSBATCH.") || t.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const batchId = r.batch_header?.payout_batch_id || r.payout_batch_id;
    const rec = batchId && object("fe-payout:" + batchId);
    if (!rec) return false;
    const status = r.batch_header?.batch_status || r.transaction_status;
    saveObject({ ...rec, status, last_event: t });
    feLog(rec.project_id, "payout", `Payout ${batchId}: ${t.replace("PAYMENT.", "").toLowerCase()} (${status})`);
    return true;
  }
  return false;
}
