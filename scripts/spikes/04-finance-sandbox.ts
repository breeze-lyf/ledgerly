// Day 4 sandbox check: drives the finance-employee server code against the real PayPal sandbox.
// Card-funded AUTHORIZE order (stands in for the client's approval on the hold page) -> plan approve ->
// partial capture (final_capture=false) + Payouts split + evidence -> void remainder. Never prints secrets.
import { readFileSync } from "node:fs";
for (const l of readFileSync("/home/box/.secrets/paypal_sandbox_card.env", "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }
const { paypal } = await import("../../server/paypal/index.js");
const { createProject, project, saveProject } = await import("../../server/finance/store.js");
const { savePlan, buildSteps, decide } = await import("../../server/finance/plans.js");
const { voidHold } = await import("../../server/finance/money.js");
const exp = process.env.SANDBOX_CARD_EXP || ""; const [mm, yy] = exp.split("/");
const expiry = yy ? `${yy.length === 2 ? "20" + yy : yy}-${mm}` : exp;
const p = createProject({ id: "prj_sbx_" + Date.now(), client: "Demo Client", client_email: "ap@client.example", title: "Sandbox milestone check", sow: "",
  milestones: [{ id: "m1", title: "Phase 1", amount: 100 }, { id: "m2", title: "Phase 2", amount: 100 }], splits: [{ name: "Sub (demo)", email: "subcontractor-demo@example.com", percent: 30 }] });
const o = await paypal.createOrder({ intent: "AUTHORIZE", purchase_units: [{ custom_id: p.id, amount: { currency_code: "USD", value: "200.00" } }], payment_source: { card: { number: process.env.SANDBOX_CARD_NUMBER, expiry, security_code: process.env.SANDBOX_CARD_CVV, name: "Demo Client" } } });
const a = o.purchase_units[0].payments.authorizations[0];
console.log("authorize order:", o.status, "authorization:", a.status, a.amount.value);
const proj = project(p.id)!; proj.hold = { status: "active", order_id: o.id, authorization_id: a.id, amount: 200, captured: 0, captures: [], authorized_at: a.create_time, reauthorize_after: new Date(Date.parse(a.create_time) + 3 * 864e5).toISOString(), expires_at: a.expiration_time, reauthorized: false }; saveProject(proj);
const pl = savePlan({ id: "plan_sbx_" + Date.now(), project_id: p.id, milestone_id: "m1", status: "pending", headline: "sandbox check", detection: { milestone_id: "m1", delivery: [], approval: [], confidence: 1, rationale: "sandbox check", method: "rules" }, evidence: [], steps: buildSteps(project(p.id)!, "m1"), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
const r = await decide(pl.id, "approve");
for (const s of r.steps) console.log(`step ${s.type}: ${s.status}`, s.error || JSON.stringify({ final: s.result?.final_capture, capture: s.result?.capture_status, batch: s.result?.batch_status }));
console.log("plan:", r.status, "auth after capture:", (await paypal.getAuthorization(a.id)).status);
await voidHold(p.id);
console.log("after void:", (await paypal.getAuthorization(a.id)).status, "hold:", project(p.id)!.hold.status);
