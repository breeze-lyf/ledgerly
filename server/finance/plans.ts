// Planner + executor: one multi-step approval card per detected milestone. Nothing moves money until a human approves.
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { detect, type Detection } from "./detector.js";
import { feLog, markSignals, money, project, saveProject, signal, signals, type Project } from "./store.js";

export type Step = { id: string; type: "capture_hold" | "invoice" | "payout" | "evidence_pack"; label: string; amount?: number; to?: string; final?: boolean; status: "pending" | "done" | "failed" | "waiting" | "skipped"; result?: any; error?: string };
export type Plan = { id: string; project_id: string; milestone_id: string; status: "pending" | "approved" | "executed" | "failed" | "rejected"; headline: string; detection: Detection; evidence: any[]; steps: Step[]; created_at: string; updated_at: string };

const now = () => new Date().toISOString();
const row2plan = (r: any): Plan | undefined => r && { ...JSON.parse(r.data), id: r.id, project_id: r.project_id, milestone_id: r.milestone_id, status: r.status, created_at: r.created_at, updated_at: r.updated_at };
export const plan = (id: string) => row2plan(db.prepare("SELECT * FROM fe_plans WHERE id=?").get(id));
export const plans = (status?: string) => (db.prepare(`SELECT * FROM fe_plans ${status ? "WHERE status=?" : ""} ORDER BY created_at DESC, rowid DESC`).all(...(status ? [status] : [])) as any[]).map(r => row2plan(r)!);
export function savePlan(p: Plan) {
  const { id, project_id, milestone_id, status, created_at, ...rest } = p;
  db.prepare("INSERT INTO fe_plans VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data, updated_at=excluded.updated_at").run(id, project_id, milestone_id, status, JSON.stringify(rest), created_at, now());
  return plan(id)!;
}

// Money steps are registered by the money module (day 4); others run here.
type Runner = (s: Step, p: Plan, proj: Project) => Promise<{ status: Step["status"]; result?: any }>;
export const runners: Partial<Record<Step["type"], Runner>> = {};
export function holdRemaining(proj: Project) { return proj.hold?.status === "active" ? money(proj.hold.amount - proj.hold.captured) : 0; }

export function buildSteps(proj: Project, milestoneId: string): Step[] {
  const m = proj.milestones.find(x => x.id === milestoneId)!;
  const steps: Step[] = [];
  const remaining = holdRemaining(proj);
  const lastOpen = proj.milestones.filter(x => x.status !== "released" && x.id !== m.id).length === 0;
  if (remaining + 0.001 >= m.amount) steps.push({ id: "s1", type: "capture_hold", amount: m.amount, final: lastOpen || remaining - m.amount < 0.01, label: `Capture ${m.amount.toFixed(2)} ${proj.currency} of the ${remaining.toFixed(2)} held at PayPal`, status: "pending" });
  else steps.push({ id: "s1", type: "invoice", amount: m.amount, label: `Send a PayPal invoice for ${m.amount.toFixed(2)} ${proj.currency} to ${proj.client_email}`, status: "pending" });
  proj.splits.forEach((s, i) => {
    const amt = money(m.amount * s.percent / 100);
    steps.push({ id: `p${i + 1}`, type: "payout", amount: amt, to: s.email, label: `Pay ${s.name} ${s.percent}% (${amt.toFixed(2)} ${proj.currency}) via PayPal Payouts${steps[0].type === "invoice" ? " once the invoice is paid" : ""}`, status: "pending" });
  });
  steps.push({ id: "e1", type: "evidence_pack", label: "File the evidence pack (delivery + client approval) for dispute defense", status: "pending" });
  return steps;
}

export async function scanProject(projectId: string) {
  const proj = project(projectId);
  if (!proj) return [];
  const sigs = signals(projectId).filter(s => s.status === "new" || s.status === "matched");
  if (!sigs.length) return [];
  const created: Plan[] = [];
  for (const d of await detect(proj, sigs)) {
    const m = proj.milestones.find(x => x.id === d.milestone_id)!;
    if (db.prepare("SELECT 1 FROM fe_plans WHERE project_id=? AND milestone_id=? AND status IN ('pending','approved','executed')").get(projectId, m.id)) continue;
    const evidence = [...d.delivery, ...d.approval].map(id => signal(id)).filter(Boolean).map(s => ({ id: s!.id, source: s!.source, kind: s!.kind, title: s!.title, actor: s!.actor, at: s!.occurred_at, url: s!.url, excerpt: s!.body.slice(0, 280) }));
    const p = savePlan({ id: "plan_" + randomUUID().slice(0, 8), project_id: projectId, milestone_id: m.id, status: "pending", headline: `Milestone "${m.title}" looks delivered and approved`, detection: d, evidence, steps: buildSteps(proj, m.id), created_at: now(), updated_at: now() });
    m.status = "proposed"; saveProject(proj);
    markSignals([...d.delivery, ...d.approval], "used");
    feLog(projectId, "plan", `Proposed: ${p.headline} (${Math.round(d.confidence * 100)}% confident, ${d.method})`, { plan_id: p.id });
    created.push(p);
  }
  return created;
}

export async function runSteps(p: Plan) {
  const proj = project(p.project_id)!;
  for (const s of p.steps) {
    if (s.status === "done" || s.status === "skipped") continue;
    if (s.type === "payout" && p.steps.some(x => (x.type === "capture_hold" || x.type === "invoice") && x.status !== "done")) { s.status = "waiting"; continue; }
    try {
      const run = s.type === "evidence_pack" ? evidencePack : runners[s.type];
      if (!run) throw Error(`${s.type} is not available`);
      const r = await run(s, p, proj);
      s.status = r.status; s.result = r.result; s.error = undefined;
      feLog(p.project_id, "step", `${s.status === "done" ? "Done" : s.status === "waiting" ? "Waiting" : s.status}: ${s.label}`, { plan_id: p.id, step: s.id });
    } catch (e: any) {
      s.status = "failed"; s.error = String(e.message).slice(0, 300);
      feLog(p.project_id, "error", `Failed: ${s.label} — ${s.error}`, { plan_id: p.id, step: s.id });
      break; // stop the plan: later steps depend on earlier ones
    }
  }
  p.status = p.steps.some(s => s.status === "failed") ? "failed" : p.steps.every(s => s.status === "done" || s.status === "skipped") ? "executed" : "approved";
  if (p.status === "executed") { const m = proj.milestones.find(x => x.id === p.milestone_id); const fresh = project(p.project_id)!; const fm = fresh.milestones.find(x => x.id === p.milestone_id); if (m && fm) { fm.status = "released"; saveProject(fresh); } }
  return savePlan(p);
}

export async function decide(id: string, decision: "approve" | "reject") {
  const p = plan(id);
  if (!p) throw Error("plan not found");
  if (decision === "reject") {
    if (p.status !== "pending") throw Error("only pending plans can be rejected");
    p.status = "rejected";
    const proj = project(p.project_id)!; const m = proj.milestones.find(x => x.id === p.milestone_id); if (m && m.status === "proposed") { m.status = "open"; saveProject(proj); }
    feLog(p.project_id, "decision", `Rejected: ${p.headline}`, { plan_id: id });
    return savePlan(p);
  }
  if (p.status !== "pending" && p.status !== "failed") throw Error(`plan is ${p.status}`);
  p.status = "approved"; savePlan(p);
  feLog(p.project_id, "decision", `Approved: ${p.headline}`, { plan_id: id });
  return runSteps(p);
}

// Called by the money module when an invoice is paid or a capture settles, to release waiting payouts.
export async function resume(projectId: string, milestoneId: string) {
  const p = plans().find(x => x.project_id === projectId && x.milestone_id === milestoneId && x.status === "approved");
  return p ? runSteps(p) : undefined;
}

async function evidencePack(_s: Step, p: Plan, proj: Project) {
  const m = proj.milestones.find(x => x.id === p.milestone_id)!;
  const pack = { project: proj.title, client: proj.client, milestone: { id: m.id, title: m.title, criteria: m.criteria, amount: m.amount, currency: proj.currency }, sow_excerpt: proj.sow.slice(0, 600),
    timeline: p.evidence.slice().sort((a, b) => a.at.localeCompare(b.at)), rationale: p.detection.rationale, money: p.steps.filter(s => s.status === "done" && s.type !== "evidence_pack").map(s => ({ step: s.type, amount: s.amount, result: s.result })), generated_at: now() };
  db.prepare("INSERT OR REPLACE INTO paypal_objects VALUES (?,?)").run("evidence:" + p.id, JSON.stringify(pack));
  return { status: "done" as const, result: { evidence_id: "evidence:" + p.id, items: pack.timeline.length } };
}
