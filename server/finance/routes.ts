import type { Router } from "express";
import { mock } from "../config.js";
import { ingestEmail, ingestGithub, verifyGithubSignature, verifyIntakeToken } from "./intake.js";
import { createProject, feActivity, project, projects, signals } from "./store.js";

const wrap = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res)).catch(next);
const bad = (res: any, e: any) => res.status(400).json({ error: e.message });

export function mountFinance(api: Router, extra?: (api: Router) => void) {
  // GitHub webhook. Signature required whenever GITHUB_WEBHOOK_SECRET is set, and always outside mock mode.
  api.post("/intake/github", (req: any, res) => {
    if ((process.env.GITHUB_WEBHOOK_SECRET || !mock) && !verifyGithubSignature(req.rawBody, req.headers["x-hub-signature-256"])) return res.status(401).json({ error: "Invalid GitHub signature" });
    res.json(ingestGithub(String(req.headers["x-github-event"] || ""), String(req.headers["x-github-delivery"] || ""), req.body));
  });
  // Inbound email (from a mail-forwarding worker or a mailbox poller). Bearer INTAKE_TOKEN required outside mock mode.
  api.post("/intake/email", (req: any, res) => {
    if ((process.env.INTAKE_TOKEN || !mock) && !verifyIntakeToken(req.headers.authorization)) return res.status(401).json({ error: "Invalid intake token" });
    try { res.json(ingestEmail(req.body)); } catch (e) { bad(res, e); }
  });
  api.get("/finance/projects", (_req, res) => res.json(projects()));
  api.get("/finance/projects/:id", (req, res) => { const p = project(req.params.id); p ? res.json({ ...p, signals: signals(p.id) }) : res.sendStatus(404); });
  api.post("/finance/projects", (req, res) => { try { res.json(createProject(req.body || {})); } catch (e) { bad(res, e); } });
  api.get("/finance/signals", (req, res) => res.json(signals(req.query.project_id as string | undefined, req.query.status as string | undefined)));
  api.get("/finance/activity", (_req, res) => res.json(feActivity()));
  extra?.(api);
}
export { wrap };
