// Agent-to-agent terms. The client's own AI agent talks to Ledgerly over MCP; Ledgerly negotiates for the
// freelancer inside bounds that live in code (derived from client memory), never in the prompt. Whatever either
// LLM says, a term outside the bounds is countered, and money only moves after the client approves in PayPal.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { object, saveObject } from "../db.js";
import { feLog, money, project, projects, saveProject, type Project } from "./store.js";
import { base } from "../config.js";
import { publicUrl } from "../lifecycle.js";
import { learn, type ClientMemory } from "./memory.js";
import { createHoldOrder } from "./money.js";

export const MAX_ROUNDS = 4;
export type Terms = { discount_pct: number; deposit_pct: number; net_days: number };
export function bounds(m: ClientMemory) {
  return { max_discount_pct: m.max_discount_pct, discount_requires_full_hold: true, min_deposit_pct: m.min_deposit_pct, max_net_days: m.terms_days };
}
export function clientToken(projectId: string, rotate = false) {
  const o = object("fe-ctoken:" + projectId);
  if (o && !rotate) return o.token as string;
  const token = "lc_" + randomBytes(18).toString("hex");
  saveObject({ id: "fe-ctoken:" + projectId, token }); return token;
}
export function projectForClientToken(given: string): Project | undefined {
  if (!/^lc_[0-9a-f]{36}$/.test(given)) return;
  for (const p of projects()) {
    const t = object("fe-ctoken:" + p.id)?.token; if (!t) continue;
    if (timingSafeEqual(Buffer.from(t), Buffer.from(given))) return p;
  }
}

const state = (p: Project) => object("fe-nego:" + p.id) || { id: "fe-nego:" + p.id, project_id: p.id, rounds: [], status: "open" };
const total = (p: Project) => money(p.milestones.filter(m => m.status === "open").reduce((a, m) => a + m.amount, 0));

export function quote(p: Project) {
  const m = learn(p.client_email), s = state(p);
  return { project: p.title, freelancer_currency: p.currency, open_total: total(p), milestones: p.milestones.map(({ id, title, amount, status, criteria }: any) => ({ id, title, amount, status, criteria })),
    standard_terms: { discount_pct: 0, deposit_pct: Math.max(m.min_deposit_pct, 0), net_days: m.terms_days },
    negotiable: ["discount_pct (only when the whole remaining amount is held at PayPal up front)", "deposit_pct", "net_days"],
    how_funds_work: "Funds are authorized (held) at PayPal, not captured. Each milestone is captured only after you approve it in writing. This is a PayPal authorization hold, not escrow.",
    negotiation: { status: s.status, rounds_used: s.rounds.length, max_rounds: MAX_ROUNDS, agreed: s.agreed || null } };
}

/** Pure decision: accept if within bounds, else counter with the nearest in-bounds terms. */
export function evaluate(ask: Terms, b: ReturnType<typeof bounds>) {
  const reasons: string[] = [];
  const t = { discount_pct: Math.max(0, +ask.discount_pct || 0), deposit_pct: Math.min(100, Math.max(0, +ask.deposit_pct || 0)), net_days: Math.max(0, Math.round(+ask.net_days || 0)) };
  if (t.deposit_pct < b.min_deposit_pct) { reasons.push(`deposit must be at least ${b.min_deposit_pct}% for this client`); t.deposit_pct = b.min_deposit_pct; }
  if (t.discount_pct > 0 && t.deposit_pct < 100) { reasons.push("a discount is only offered when the full remaining amount is held up front"); }
  const cap = t.deposit_pct === 100 ? b.max_discount_pct : 0;
  if (t.discount_pct > cap) { if (t.deposit_pct === 100) reasons.push(`maximum discount for this client is ${cap}%`); t.discount_pct = cap; }
  if (t.net_days > b.max_net_days) { reasons.push(`payment terms are at most net-${b.max_net_days}`); t.net_days = b.max_net_days; }
  t.discount_pct = Math.round(t.discount_pct * 10) / 10;
  return { decision: reasons.length ? "counter" as const : "accepted" as const, terms: t, reasons };
}

export function proposeTerms(p: Project, ask: Terms & { note?: string }) {
  const s = state(p);
  if (s.status === "agreed") return { decision: "already_agreed", terms: s.agreed };
  if (s.rounds.length >= MAX_ROUNDS) return { decision: "final", terms: s.rounds.at(-1)?.reply.terms, reasons: ["round limit reached; accept the last terms or talk to the freelancer"] };
  const m = learn(p.client_email);
  const reply = evaluate(ask, bounds(m));
  const offer_id = `off_${p.id}_${s.rounds.length + 1}`;
  s.rounds.push({ offer_id, ask: { discount_pct: ask.discount_pct, deposit_pct: ask.deposit_pct, net_days: ask.net_days }, note: String(ask.note || "").slice(0, 300), reply, at: new Date().toISOString() });
  saveObject(s);
  feLog(p.id, "negotiation", reply.decision === "accepted"
    ? `Client's agent proposed ${fmt(reply.terms)}: within my bounds, accepted pending their confirmation.`
    : `Client's agent asked for ${fmt(ask)}. I countered with ${fmt(reply.terms)} (${reply.reasons.join("; ")}).`, { offer_id, strategy: m.strategy });
  return { offer_id, ...reply, saving: money(total(p) * reply.terms.discount_pct / 100), rounds_left: MAX_ROUNDS - s.rounds.length };
}
const fmt = (t: Terms) => `${t.discount_pct || 0}% off, ${t.deposit_pct}% held up front, net-${t.net_days}`;

export async function acceptTerms(p: Project, offerId: string) {
  const s = state(p);
  if (s.status === "agreed") return { status: "agreed", terms: s.agreed, funding: fundingFor(p) };
  const r = s.rounds.find((x: any) => x.offer_id === offerId);
  if (!r) throw Error("unknown offer_id");
  if (r !== s.rounds.at(-1)) throw Error("only the latest offer can be accepted");
  const t: Terms = evaluate(r.reply.terms, bounds(learn(p.client_email))).terms; // re-check against current bounds
  if (p.hold?.status === "active") throw Error("funds are already held for this project");
  const fresh = project(p.id)!;
  if (t.discount_pct > 0) fresh.milestones = fresh.milestones.map(m => m.status === "open" ? { ...m, amount: money(m.amount * (1 - t.discount_pct / 100)) } : m);
  (fresh as any).terms = t; delete fresh.hold; saveProject(fresh);
  s.status = "agreed"; s.agreed = t; s.agreed_at = new Date().toISOString(); saveObject(s);
  feLog(p.id, "negotiation", `Agreed with the client's agent: ${fmt(t)}. Sent them a PayPal link to hold the funds.`, { offer_id: offerId });
  const o = t.deposit_pct > 0 ? await createHoldOrder(p.id) : null;
  return { status: "agreed", terms: t, funding: fundingFor(project(p.id)!), order_id: o?.id };
}
const fundingFor = (p: Project) => p.hold ? { amount: p.hold.amount, currency: p.currency, status: p.hold.status, link: publicUrl() + base + `hold/${p.id}`, note: "A person at the client approves this in PayPal; agents cannot move the money." } : null;
export const negotiation = (projectId: string) => object("fe-nego:" + projectId) || null;
