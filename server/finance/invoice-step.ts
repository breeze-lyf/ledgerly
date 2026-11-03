// Invoice path for milestones without a PayPal hold: create + send a PayPal invoice; the step completes when it is paid.
import { action } from "../service.js";
import { invoice } from "../db.js";
import { runners, resume, plans, savePlan } from "./plans.js";

runners.invoice = async (s, p, proj) => {
  if (s.result?.invoice_id) { const i = invoice(s.result.invoice_id); return { status: i?.status === "PAID" ? "done" : "waiting", result: s.result }; }
  const m = proj.milestones.find(x => x.id === p.milestone_id)!;
  const [draft] = await action("create_invoice", { client_name: proj.client, client_email: proj.client_email, due_in_days: 7, currency: proj.currency,
    note: `Milestone "${m.title}" for ${proj.title}. Evidence on file: ${p.evidence.map((e: any) => e.title).join("; ").slice(0, 400)}`,
    items: [{ name: `${proj.title}: ${m.title}`, quantity: 1, unit_amount: s.amount }] }, false, "finance-" + p.id);
  await action("send_invoice", { invoice_id: draft.id }, true, "finance-" + p.id);
  return { status: "waiting", result: { invoice_id: draft.id } };
};

// Invoice paid → mark the step done and release waiting payouts.
export async function onInvoicePaid(invoiceId: string) {
  for (const p of plans("approved")) {
    const s = p.steps.find(x => x.type === "invoice" && x.result?.invoice_id === invoiceId);
    if (!s || s.status === "done") continue;
    s.status = "done"; savePlan(p);
    await resume(p.project_id, p.milestone_id);
  }
}
import { listeners } from "../service.js";
listeners.add((e: any) => {
  if (e?.invoice_id && invoice(e.invoice_id)?.status === "PAID") onInvoicePaid(e.invoice_id).catch(err => console.error("finance resume", err.message));
});
