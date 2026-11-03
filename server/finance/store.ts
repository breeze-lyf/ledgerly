// Finance-employee storage: projects (with milestones and splits), work signals, plans, holds, payouts.
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { listeners } from "../service.js";

db.exec(`CREATE TABLE IF NOT EXISTS fe_projects (id TEXT PRIMARY KEY, client TEXT, client_email TEXT, repo TEXT, currency TEXT, data TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS fe_signals (id TEXT PRIMARY KEY, source TEXT, source_key TEXT UNIQUE, project_id TEXT, kind TEXT, actor TEXT, title TEXT, body TEXT, url TEXT, occurred_at TEXT, status TEXT, data TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS fe_plans (id TEXT PRIMARY KEY, project_id TEXT, milestone_id TEXT, status TEXT, data TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS fe_log (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, message TEXT, data TEXT, created_at TEXT);`);

export type Milestone = { id: string; title: string; amount: number; criteria: string; keywords?: string[]; status: "open" | "proposed" | "released" };
export type Split = { name: string; email: string; percent: number };
export type Project = { id: string; client: string; client_email: string; repo?: string; currency: string; title: string; sow: string; milestones: Milestone[]; splits: Split[]; hold?: any };

const now = () => new Date().toISOString();
export const money = (n: number) => Math.round(n * 100) / 100;

export function feLog(projectId: string | null, kind: string, message: string, data: any = {}) {
  db.prepare("INSERT INTO fe_log VALUES (?,?,?,?,?,?)").run(randomUUID(), projectId, kind, message, JSON.stringify(data), now());
  for (const fn of listeners) fn({ event_type: "FINANCE.ACTIVITY", invoice_id: null, data: { kind, message, project_id: projectId } });
}
export function feActivity(limit = 80) {
  return (db.prepare("SELECT * FROM fe_log ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as any[]).map(r => ({ ...r, data: JSON.parse(r.data) }));
}
const row2project = (r: any): Project | undefined => r && { ...JSON.parse(r.data), id: r.id, client: r.client, client_email: r.client_email, repo: r.repo || undefined, currency: r.currency };
export function project(id: string) { return row2project(db.prepare("SELECT * FROM fe_projects WHERE id=?").get(id)); }
export function projects(): Project[] { return (db.prepare("SELECT * FROM fe_projects ORDER BY created_at DESC, rowid DESC").all() as any[]).map(r => row2project(r)!); }

export function saveProject(p: Project) {
  const { id, client, client_email, repo, currency, ...rest } = p;
  db.prepare("INSERT INTO fe_projects VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET client=excluded.client, client_email=excluded.client_email, repo=excluded.repo, currency=excluded.currency, data=excluded.data")
    .run(id, client, client_email.toLowerCase(), repo?.toLowerCase() || null, currency, JSON.stringify(rest), now());
  return project(id)!;
}

// Validates human input for a project; guardrails live here, not in prompts.
export function createProject(input: any): Project {
  const str = (v: any, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const client = str(input.client), email = str(input.client_email).toLowerCase();
  if (!client || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Error("client and a valid client_email are required");
  const milestones = (Array.isArray(input.milestones) ? input.milestones : []).slice(0, 12).map((m: any, i: number) => {
    const amount = money(Number(m.amount));
    if (!str(m.title) || !(amount > 0)) throw Error(`milestone ${i + 1} needs a title and a positive amount`);
    return { id: str(m.id, 40) || `m${i + 1}`, title: str(m.title), amount, criteria: str(m.criteria, 1000), keywords: (Array.isArray(m.keywords) ? m.keywords : []).map((k: any) => str(k, 40).toLowerCase()).filter(Boolean), status: "open" as const };
  });
  if (!milestones.length) throw Error("at least one milestone is required");
  const splits = (Array.isArray(input.splits) ? input.splits : []).slice(0, 5).map((s: any) => ({ name: str(s.name, 80), email: str(s.email).toLowerCase(), percent: Number(s.percent) }));
  if (splits.some((s: Split) => !s.name || !/^[^@\s]+@[^@\s]+$/.test(s.email) || !(s.percent > 0))) throw Error("each split needs name, email and a positive percent");
  if (splits.reduce((a: number, s: Split) => a + s.percent, 0) > 90) throw Error("splits may total at most 90%");
  const repo = str(input.repo, 120).toLowerCase() || undefined;
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error("repo must look like owner/name");
  const p = saveProject({ id: str(input.id, 40) || "prj_" + randomUUID().slice(0, 8), client, client_email: email, repo, currency: str(input.currency, 3).toUpperCase() || "USD", title: str(input.title) || client + " project", sow: str(input.sow, 6000), milestones, splits });
  feLog(p.id, "project", `Project "${p.title}" set up with ${milestones.length} milestones`);
  return p;
}
export function projectForRepo(repo: string) { return row2project(db.prepare("SELECT * FROM fe_projects WHERE repo=? ORDER BY created_at DESC LIMIT 1").get(repo.toLowerCase())); }
export function projectForEmail(address: string) {
  const a = address.toLowerCase();
  return row2project(db.prepare("SELECT * FROM fe_projects WHERE client_email=? ORDER BY created_at DESC LIMIT 1").get(a))
    ?? row2project(db.prepare("SELECT * FROM fe_projects WHERE substr(client_email, instr(client_email,'@'))=? ORDER BY created_at DESC LIMIT 1").get(a.slice(a.indexOf("@"))));
}

export type Signal = { id: string; source: "github" | "email"; source_key: string; project_id: string | null; kind: string; actor: string; title: string; body: string; url: string; occurred_at: string; status: string; data: any };
export function addSignal(s: Omit<Signal, "id" | "status">): { signal: Signal; fresh: boolean } {
  const id = "sig_" + randomUUID().slice(0, 10);
  const r = db.prepare("INSERT OR IGNORE INTO fe_signals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.source, s.source_key, s.project_id, s.kind, s.actor.slice(0, 200), s.title.slice(0, 300), s.body.slice(0, 4000), s.url.slice(0, 500), s.occurred_at, s.project_id ? "new" : "unmatched", JSON.stringify(s.data || {}), now());
  const signal = signalBy("source_key", s.source_key)!;
  if (r.changes) feLog(s.project_id, "signal", `${s.source === "github" ? "GitHub" : "Email"}: ${s.kind} — ${s.title}`, { signal_id: signal.id });
  return { signal, fresh: !!r.changes };
}
function signalBy(col: "id" | "source_key", v: string) { const r = db.prepare(`SELECT * FROM fe_signals WHERE ${col}=?`).get(v) as any; return r && { ...r, data: JSON.parse(r.data) } as Signal; }
export const signal = (id: string) => signalBy("id", id);
export function signals(projectId?: string, status?: string): Signal[] {
  const where = [projectId ? "project_id=@p" : "", status ? "status=@s" : ""].filter(Boolean).join(" AND ");
  return (db.prepare(`SELECT * FROM fe_signals ${where ? "WHERE " + where : ""} ORDER BY occurred_at, rowid`).all({ p: projectId, s: status }) as any[]).map(r => ({ ...r, data: JSON.parse(r.data) }));
}
export function markSignals(ids: string[], status: string) { const st = db.prepare("UPDATE fe_signals SET status=? WHERE id=?"); for (const id of ids) st.run(status, id); }
