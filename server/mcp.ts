// Ledgerly as an MCP server: outside agents (Claude Desktop, Cursor, any MCP client) can read receivables
// and PROPOSE money moves. Sends, reminders, refunds and subscriptions still need a human confirm in Ledgerly.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, invoice, invoices } from "./db.js";
import { execute } from "./agent/toolkit.js";
import { payLinkFor } from "./lifecycle.js";
import { outcomes, policy, activity } from "./autopilot.js";
import { retainers } from "./subscriptions.js";
import { publicUrl } from "./lifecycle.js";
import { base } from "./config.js";

export const MCP_SESSION = "mcp";
const text = (value: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const confirmHint = () => `Proposals wait for a human: open ${publicUrl()}${base} → Autopilot tab → "External agent approvals".`;
const propose = async (name: string, args: any) => {
  const cards = await execute(name, args, MCP_SESSION);
  return text({ result: cards, needs_human_confirmation: cards.some((c: any) => c.kind === "pending_action"), note: confirmHint() });
};
export function pendingMcpActions() {
  return (db.prepare("SELECT id,name,args FROM actions WHERE session_id=? AND status='pending' ORDER BY rowid DESC").all(MCP_SESSION) as any[])
    .map((a) => ({ ...a, args: JSON.parse(a.args) }));
}

/** Tool names, kept in one place so docs and tests can count them. */
export const mcpToolNames = [
  "what_needs_collecting", "cashflow", "reconcile", "list_invoices", "get_invoice", "get_pay_link", "outcomes",
  "autopilot_status", "list_retainers", "list_pending_approvals",
  "create_invoice_series", "draft_reminder", "propose_collections_run", "propose_refund", "propose_retainer",
];

export function createMcpServer() {
  const s = new McpServer({ name: "ledgerly", version: "0.2.0" }, {
    instructions: "Ledgerly runs a freelancer's PayPal receivables. Read tools are safe. Tools named propose_* / create_* only create drafts or pending actions; a human confirms in the Ledgerly UI before anything is sent, charged or refunded.",
  });
  const ro = { readOnlyHint: true, openWorldHint: false };
  s.registerTool("what_needs_collecting", { description: "Collections scan: overdue / soon-due invoices with proposed reminder tone and eligibility.", annotations: ro }, async () => text((await execute("what_needs_collecting", {}, MCP_SESSION))[0]));
  s.registerTool("cashflow", { description: "This month's receivables, received, overdue and expected next 7 days, per currency.", annotations: ro }, async () => text((await execute("cashflow", {}, MCP_SESSION))[0]));
  s.registerTool("reconcile", { description: "Paid / unpaid / overdue invoices with totals.", inputSchema: { query: z.enum(["paid", "unpaid", "overdue"]), period: z.string().optional().describe("e.g. 'month'") }, annotations: ro },
    async (a) => text((await execute("reconcile", a, MCP_SESSION))[0]));
  s.registerTool("list_invoices", { description: "All invoices in Ledgerly's PayPal mirror (id, client, amount, status, due date, pay link).", annotations: ro },
    async () => text(invoices().map((i: any) => ({ id: i.id, number: i.invoice_number, client: i.client, amount: i.amount, currency: i.currency, status: i.status, due_date: i.due_date, pay_link: payLinkFor(i) }))));
  s.registerTool("get_invoice", { description: "One invoice with its timeline.", inputSchema: { invoice_id: z.string() }, annotations: ro }, async ({ invoice_id }) => {
    const i = invoice(invoice_id);
    if (!i) return { ...text({ error: "Invoice not found" }), isError: true };
    const { data: _raw, ...rest } = i as any;
    return text({ ...rest, pay_link: payLinkFor(i), timeline: db.prepare("SELECT event_type,data,created_at FROM events WHERE invoice_id=? ORDER BY rowid").all(i.id) });
  });
  s.registerTool("get_pay_link", { description: "Client-facing PayPal pay page link for an invoice.", inputSchema: { invoice_id: z.string() }, annotations: ro }, async ({ invoice_id }) => {
    const i = invoice(invoice_id);
    return i ? text({ invoice_id: i.id, pay_link: payLinkFor(i) }) : { ...text({ error: "Invoice not found" }), isError: true };
  });
  s.registerTool("outcomes", { description: "Collection outcomes computed from recorded events only (days to pay, reminder conversion, PayPal checkout share).", annotations: ro }, async () => text(outcomes()));
  s.registerTool("autopilot_status", { description: "Autopilot guardrails and the latest agent activity.", annotations: ro }, async () => text({ policy: policy(), activity: activity().slice(0, 20) }));
  s.registerTool("list_retainers", { description: "PayPal subscription retainers and their billing status.", annotations: ro }, async () => text(retainers()));
  s.registerTool("list_pending_approvals", { description: "Actions proposed by external agents that are waiting for a human.", annotations: ro }, async () => text(pendingMcpActions()));
  s.registerTool("create_invoice_series", {
    description: "Create PayPal DRAFT invoice(s), one per month. Sending is proposed for human confirmation.",
    inputSchema: { client_name: z.string(), client_email: z.string().email().optional(), amount: z.number().positive(), description: z.string().optional(), months: z.number().int().min(1).max(24).default(1) },
  }, async (a) => propose(a.months > 1 ? "create_invoice_series" : "create_invoice", { client_name: a.client_name, client_email: a.client_email, currency: "USD",
    items: [{ name: a.description || "Services", quantity: 1, unit_amount: a.amount }], recurrence: { count: a.months } }));
  s.registerTool("draft_reminder", { description: "Draft (not send) a payment reminder for an invoice.", inputSchema: { invoice_id: z.string(), tone: z.enum(["friendly", "firm", "final"]).optional() } },
    async (a) => text(await execute("draft_reminder", a, MCP_SESSION)));
  s.registerTool("propose_collections_run", { description: "Propose reminders for every eligible invoice; each waits for human confirmation." }, async () => propose("run_collections", {}));
  s.registerTool("propose_refund", { description: "Propose a refund for a paid invoice (by invoice id or client). Validated against the refundable balance; a human confirms.",
    inputSchema: { invoice_id: z.string().optional(), client: z.string().optional(), amount: z.number().positive().optional() } }, async (a) => propose("refund_invoice", a));
  s.registerTool("propose_retainer", { description: "Propose a monthly PayPal subscription (retainer). On confirmation Ledgerly creates the Product, Plan and Subscription and returns the client approval link.",
    inputSchema: { client_name: z.string(), client_email: z.string().email().optional(), amount: z.number().positive().describe("monthly amount"), months: z.number().int().min(1).max(36), currency: z.string().length(3).default("USD") } },
    async (a) => propose("create_retainer", a));
  return s;
}
