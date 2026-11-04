import type { Router } from "express";
import { mock } from "../config.js";
import { ingestEmail, ingestGithub, verifyGithubSignature, verifyIntakeToken } from "./intake.js";
import { createProject, feActivity, project, projects, signals } from "./store.js";
import { decide, plan, plans, scanProject } from "./plans.js";
import "./invoice-step.js";
import { memories } from "./memory.js";
import { weekly } from "./weekly.js";
import { clientToken, negotiation } from "./negotiate.js";
import { onDispute } from "./disputes.js";
import { authorizeHold, createHoldOrder, holdInfo, reauthorizeDue, syncPayouts, voidHold } from "./money.js";
import { object } from "../db.js";

// A fresh signal for a known project wakes the detector; the human sees a plan card, nothing moves yet.
async function afterIntake(r: any) {
  if (r?.fresh && r.signal?.project_id) { try { r.plans = await scanProject(r.signal.project_id); } catch (e: any) { console.error("finance scan", e.message); } }
}
const wrap = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res)).catch(next);
const bad = (res: any, e: any) => res.status(400).json({ error: e.message });

export function mountFinance(api: Router, extra?: (api: Router) => void) {
  // GitHub webhook. Signature required whenever GITHUB_WEBHOOK_SECRET is set, and always outside mock mode.
  api.post("/intake/github", wrap(async (req: any, res: any) => {
    if ((process.env.GITHUB_WEBHOOK_SECRET || !mock) && !verifyGithubSignature(req.rawBody, req.headers["x-hub-signature-256"])) return res.status(401).json({ error: "Invalid GitHub signature" });
    const r: any = ingestGithub(String(req.headers["x-github-event"] || ""), String(req.headers["x-github-delivery"] || ""), req.body);
    await afterIntake(r); res.json(r);
  }));
  // Inbound email (from a mail-forwarding worker or a mailbox poller). Bearer INTAKE_TOKEN required outside mock mode.
  api.post("/intake/email", wrap(async (req: any, res: any) => {
    if ((process.env.INTAKE_TOKEN || !mock) && !verifyIntakeToken(req.headers.authorization)) return res.status(401).json({ error: "Invalid intake token" });
    let r: any; try { r = ingestEmail(req.body); } catch (e) { return bad(res, e); }
    await afterIntake(r); res.json(r);
  }));
  api.get("/finance/projects", (_req, res) => res.json(projects()));
  api.get("/finance/projects/:id", (req, res) => { const p = project(req.params.id); p ? res.json({ ...p, signals: signals(p.id) }) : res.sendStatus(404); });
  api.post("/finance/projects", (req, res) => { try { res.json(createProject(req.body || {})); } catch (e) { bad(res, e); } });
  api.get("/finance/signals", (req, res) => res.json(signals(req.query.project_id as string | undefined, req.query.status as string | undefined)));
  api.get("/finance/activity", (_req, res) => res.json(feActivity()));
  api.post("/finance/projects/:id/scan", wrap(async (req: any, res: any) => res.json(await scanProject(req.params.id))));
  api.get("/finance/plans", (req, res) => res.json(plans(req.query.status as string | undefined)));
  api.post("/finance/plans/:id", wrap(async (req: any, res: any) => { try { res.json(await decide(req.params.id, req.body?.decision === "reject" ? "reject" : "approve")); } catch (e) { bad(res, e); } }));
  api.get("/finance/plans/:id/evidence", (req, res) => { const e = object("evidence:" + req.params.id); e ? res.json(e) : res.sendStatus(404); });
  // Client hold page (public): PayPal JS SDK with intent=authorize.
  api.get("/hold/:id", (req, res) => { try { res.json(holdInfo(req.params.id)); } catch (e: any) { res.status(404).json({ error: e.message }); } });
  api.post("/hold/:id/order", wrap(async (req: any, res: any) => { try { res.json(await createHoldOrder(req.params.id)); } catch (e) { bad(res, e); } }));
  api.post("/hold/:id/authorize", wrap(async (req: any, res: any) => { try { res.json(await authorizeHold(req.params.id, String(req.body?.order_id || ""))); } catch (e) { bad(res, e); } }));
  api.post("/finance/projects/:id/hold/void", wrap(async (req: any, res: any) => { try { res.json(await voidHold(req.params.id)); } catch (e) { bad(res, e); } }));
  api.post("/finance/reauthorize-due", wrap(async (_req: any, res: any) => res.json(await reauthorizeDue())));
  api.post("/finance/sync-payouts", wrap(async (_req: any, res: any) => res.json(await syncPayouts())));
  if (process.env.FINANCE_SWEEP !== "0") {
    setInterval(() => reauthorizeDue().catch(e => console.error("reauth sweep", e.message)), 3600_000).unref();
    setInterval(() => syncPayouts().catch(e => console.error("payout sync", e.message)), 600_000).unref();
  }
  api.get("/finance/weekly", (_req, res) => res.json(weekly()));
  api.get("/finance/projects/:id/negotiation", (req, res) => res.json(negotiation(req.params.id)));
  // Issue (or rotate) the client-agent token. Shown once to the freelancer, who passes it to the client.
  api.post("/finance/projects/:id/client-token", (req, res) => { if (!project(req.params.id)) return res.sendStatus(404); res.json({ token: clientToken(req.params.id, !!req.body?.rotate), mcp_path: "mcp/client" }); });
  api.get("/finance/memory", (_req, res) => res.json(memories()));
  api.get("/finance/disputes/:id/evidence.pdf", (req, res) => { const f = object("fe-dispute-pdf:" + req.params.id); if (!f) return res.sendStatus(404); res.type("application/pdf").send(Buffer.from(f.b64, "base64")); });
  // Demo tool: simulate PayPal's CUSTOMER.DISPUTE.CREATED for a real capture (the sandbox needs a buyer account to open one).
  api.post("/dev/finance-dispute", wrap(async (req: any, res: any) => {
    if (!mock && process.env.DEMO_TOOLS !== "1") return res.sendStatus(404);
    const cap = String(req.body?.capture_id || ""); const id = "PP-D-SIM-" + Date.now();
    const ok = await onDispute({ id: "WH-SIM-" + id, event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: id, reason: req.body?.reason || "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", status: "OPEN", simulated: true, dispute_amount: req.body?.amount || { currency_code: "USD", value: "800.00" }, disputed_transactions: [{ seller_transaction_id: cap }] } });
    ok ? res.json({ dispute_id: id, simulated: true }) : res.status(404).json({ error: "capture not linked to a project" });
  }));
  extra?.(api);
}
