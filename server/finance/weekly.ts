// "Zero-touch" week: what the finance employee did in the last 7 days, computed from recorded plans, steps,
// signals and log rows. Time saved uses a labelled per-action estimate (ASSUMED_MINUTES), not measurement.
import { db, invoice } from "../db.js";
import { plans } from "./plans.js";

export const ASSUMED_MINUTES: Record<string, number> = {
  signal: 2, capture_hold: 5, invoice: 10, payout: 8, request_hold: 10, evidence_pack: 5, dispute_pack: 90, submit_evidence: 15, negotiation_round: 15, human_approval: -1,
};
export function weekly(now = Date.now()) {
  const since = new Date(now - 7 * 864e5).toISOString();
  const inWeek = (t?: string) => !!t && t >= since;
  const counts: Record<string, number> = {}; const add = (k: string, n = 1) => (counts[k] = (counts[k] || 0) + n);
  const sums: Record<string, number> = {}; const sum = (cur: string, n: number) => (sums[cur] = Math.round(((sums[cur] || 0) + n) * 100) / 100);
  const paidOut: Record<string, number> = {};
  for (const p of plans()) {
    const cur = (db.prepare("SELECT currency FROM fe_projects WHERE id=?").get(p.project_id) as any)?.currency || "USD";
    if (p.status !== "pending" && p.status !== "rejected" && inWeek(p.updated_at)) add("human_approval");
    for (const s of p.steps) {
      if (s.status !== "done" || !inWeek(p.updated_at)) continue;
      add(p.kind === "dispute" && s.type === "evidence_pack" ? "dispute_pack" : s.type);
      if (s.type === "capture_hold") sum(cur, s.amount || 0);
      if (s.type === "payout") paidOut[cur] = Math.round(((paidOut[cur] || 0) + (s.amount || 0)) * 100) / 100;
      if (s.type === "invoice") { const i = s.result?.invoice_id && invoice(s.result.invoice_id); if (i?.paid_at && i.paid_at.replace(" ", "T") >= since) sum(i.currency || cur, i.paid_amount || s.amount || 0); }
    }
  }
  add("signal", (db.prepare("SELECT COUNT(*) n FROM fe_signals WHERE created_at>=?").get(since) as any).n);
  add("negotiation_round", (db.prepare("SELECT COUNT(*) n FROM fe_log WHERE kind='negotiation' AND created_at>=? AND message LIKE 'Client''s agent%'").get(since) as any).n);
  const minutes = Object.entries(counts).reduce((a, [k, n]) => a + (ASSUMED_MINUTES[k] ?? 0) * n, 0);
  const ai_actions = Object.entries(counts).filter(([k]) => k !== "human_approval").reduce((a, [, n]) => a + n, 0);
  return { since, collected: sums, paid_out: paidOut, ai_actions, human_approvals: counts.human_approval || 0, actions: counts,
    hours_saved: Math.max(0, Math.round(minutes / 6) / 10), assumption: { minutes_per_action: ASSUMED_MINUTES, note: "Estimated manual minutes per action (our assumption, not measured); each human approval is counted as 1 minute spent." } };
}
