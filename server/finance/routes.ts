import type { Router } from "express";
import { mock } from "../config.js";
import { ingestEmail, ingestGithub, verifyGithubSignature, verifyIntakeToken } from "./intake.js";
import { createProject, feActivity, project, projects, signals } from "./store.js";
import { decide, plan, plans, scanProject } from "./plans.js";
import "./invoice-step.js";
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
  extra?.(api);
}
