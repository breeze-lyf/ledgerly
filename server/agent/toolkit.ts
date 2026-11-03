import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { AxiosStatic } from "axios";
import {
  PayPalAgentToolkit,
  ALL_TOOLS_ENABLED,
} from "@paypal/agent-toolkit/openai";
import { mock } from "../config.js";
import { action, pendingAction, event } from "../service.js";
import { paypal, directPayPal, withPayPalExecution, type PayPalClient } from "../paypal/index.js";
import { normalizeOrder } from "./order-arguments.js";
import { db } from "../db.js";
// The SDK uses CommonJS axios and replaces API errors with an LLM-safe error.
// Preserve only allowlisted diagnostics before that replacement, per invocation.
const axios = createRequire(import.meta.url)("axios") as AxiosStatic;
const diagnostics = new AsyncLocalStorage<{ error?: ReturnType<typeof safePayPalError> }>();
function safePayPalError(raw: any) {
  return { name: typeof raw?.name === "string" ? raw.name : "TOOLKIT_ERROR",
    details: Array.isArray(raw?.details) ? raw.details.map((d: any) => ({ issue: d.issue, field: d.field, description: d.description })) : undefined,
    debug_id: typeof raw?.debug_id === "string" ? raw.debug_id : undefined };
}
axios.interceptors.response.use(response => response, error => {
  const context = diagnostics.getStore();
  if (context && error?.response?.data) context.error = safePayPalError(error.response.data);
  return Promise.reject(error);
});
const actions = Object.fromEntries(
  ["invoices", "orders", "payments", "refunds", "disputes", "transactions", "subscriptions"].map((k) => [
    k,
    ALL_TOOLS_ENABLED[k] || {},
  ]),
);
export const toolkit = new PayPalAgentToolkit({
  clientId: mock ? "mock" : process.env.PAYPAL_CLIENT_ID!,
  clientSecret: mock ? "mock" : process.env.PAYPAL_CLIENT_SECRET!,
  configuration: { actions, context: { sandbox: true } },
});
export const readOnlyToolkit = ["list_disputes", "get_dispute", "list_transactions", "show_subscription_details"];
const names = [
  "create_invoice",
  "send_invoice",
  "send_invoice_reminder",
  "cancel_sent_invoice",
  "list_invoices",
  "get_invoice",
  "record_payment_for_invoice",
  "record_refund_for_invoice",
  "create_order",
  "get_order",
  "pay_order",
  "create_refund",
  "get_refund",
  // Read-only groups: disputes, transaction search, subscription details.
  ...readOnlyToolkit,
];
export const paypalTools = toolkit
  .getTools()
  .filter((t: any) => names.includes(t.function.name));
export const toolkitHealth = {
  version: "1.11.0",
  toolCount: paypalTools.length,
  execution: mock
    ? "mock"
    : process.env.PAYPAL_TOOLKIT_EXECUTION === "toolkit"
      ? "toolkit"
      : "ours",
};
export const executionTrace = new Map<string, string>();
export async function execute(
  name: string,
  a: any,
  session = "default",
  confirmed = false,
): Promise<any[]> {
  executionTrace.delete(session);
  const result = await withPayPalExecution((method, args) => invokePayPal(method, args, session), () => executeTool(name, a, session, confirmed));
  if (["create_invoice", "create_invoice_series"].includes(name)) {
    const drafts = result.filter((card) => card.status === "DRAFT");
    if (drafts.length && !result.some((card) => card.kind === "pending_action"))
      result.push(pendingAction("send_invoice", {
        invoice_ids: drafts.map((draft) => draft.id),
      }, session));
  }
  return result;
}
async function executeTool(
  name: string, a: any, session: string, confirmed: boolean,
): Promise<any[]> {
  if (name === "refund_invoice") return action(name, a, false, session);
  if (readOnlyToolkit.includes(name)) return [await readToolkit(name, a)];
  if (name === "refund" && a.invoice_id && a.capture_id)
    return action(name, a, confirmed, session);
  
  if (name === "create_invoice") {
    const b = a.primary_recipients?.[0]?.billing_info;
    a = {
      ...a,
      client_name:
        a.client_name ||
        b?.business_name ||
        [b?.name?.given_name, b?.name?.surname].filter(Boolean).join(" "),
      client_email: a.client_email || b?.email_address,
      currency: a.currency_code || a.currency,
      items: a.items?.map((i: any) => ({
        ...i,
        unit_amount:
          typeof i.unit_amount === "object"
            ? Number(i.unit_amount.value)
            : i.unit_amount,
      })),
    };
  }
  // Scope duplicate protection to drafts already proposed in this session. Series
  // are reused as a whole so equal monthly amounts remain separate invoices.
  if (["create_invoice", "create_invoice_series"].includes(name)) {
    const amount = a.items?.reduce(
      (sum: number, item: any) => sum + Number(item.quantity) * Number(item.unit_amount), 0,
    );
    const count = Math.min(24, Math.max(1, Number(a.recurrence?.count || 1)));
    const proposals = db.prepare(
      "SELECT args FROM actions WHERE session_id=? AND name='send_invoice' ORDER BY rowid DESC",
    ).all(session) as any[];
    for (const proposal of proposals) {
      const args = JSON.parse(proposal.args);
      const ids: string[] = args.invoice_ids || [args.invoice_id];
      if (ids.length !== count) continue;
      const drafts = ids.map((id) => db.prepare(
        "SELECT * FROM invoices WHERE id=? AND status='DRAFT' AND created_at >= datetime('now', '-10 minutes')",
      ).get(id) as any);
      if (drafts.every((i) => i &&
        i.client.trim().toLowerCase() === a.client_name?.trim().toLowerCase() &&
        i.amount === amount && i.currency === (a.currency || "USD") &&
        (i.email || "").toLowerCase() === (a.client_email || "").toLowerCase())) {
        return [...drafts, pendingAction("send_invoice", args, session)];
      }
    }
  }
  const aliases: Record<string, string> = {
    send_invoice_reminder: "remind_invoice",
    cancel_sent_invoice: "cancel_invoice",
    record_payment_for_invoice: "record_payment",
    record_refund_for_invoice: "refund",
    create_refund: "refund",
  };
  const mapped = aliases[name] || name;
  if (a.amount?.value)
    a = {
      ...a,
      currency: a.amount.currency_code,
      amount: Number(a.amount.value),
    };
  if (mapped === "remind_invoice") a = { ...a, message: a.note || a.message };
  // A tool request can only propose a send/refund. Confirmation comes from the user endpoint.
  if (["send_invoice", "refund"].includes(mapped) && !confirmed)
    return action(mapped, a, false, session);
  if (name === "get_invoice") return [await paypal.getInvoice(a.invoice_id)];
  if (name === "get_order") return [await paypal.getOrder(a.id || a.order_id)];
  if (name === "pay_order") {
    try { return [await paypal.captureOrder(a.id || a.order_id)]; }
    catch (e) {
      const status = await paypal.getOrder(a.id || a.order_id).then((o: any) => o.status).catch(() => "");
      if (/ORDER_NOT_APPROVED|PAYER_ACTION_REQUIRED/.test((e as Error).message) || ["CREATED", "PAYER_ACTION_REQUIRED"].includes(status))
        return [{ kind: "notice", code: "ORDER_NOT_APPROVED", message: "Approve the order using its PayPal approval link before capturing payment." }];
      throw e;
    }
  }
  if (name === "get_refund") return [await paypal.getRefund(a.refund_id)];
  if (name === "create_order") {
    const order = normalizeOrder(a);
    return action("create_payment_link", { currency: order.currencyCode,
      description: order.notes, amount: order.amount }, false, session);
  }
  return action(mapped, a, confirmed, session);
}
function mockRead(name: string, a: any) {
  if (name === "list_disputes") return { items: [], total_items: 0 };
  if (name === "get_dispute") return { dispute_id: a.dispute_id, status: "UNKNOWN_IN_MOCK" };
  if (name === "show_subscription_details") return db.prepare("SELECT * FROM retainers WHERE subscription_id=?").get(a.subscription_id || a.id) || { id: a.subscription_id, status: "UNKNOWN_IN_MOCK" };
  return { transaction_details: [], total_items: 0 };
}
/** Read-only Agent Toolkit tools executed by the toolkit itself (no money moves). */
async function readToolkit(name: string, a: any) {
  let result: any;
  if (mock) result = mockRead(name, a || {});
  else {
    const r = await toolkit.handleToolCall({ id: "ledgerly-" + name, type: "function", function: { name, arguments: JSON.stringify(a || {}) } } as any);
    try { result = typeof r.content === "string" ? JSON.parse(r.content) : r.content; } catch { result = { text: String(r.content) }; }
  }
  let text = JSON.stringify(result);
  if (text.length > 6000) result = { truncated: true, preview: text.slice(0, 6000) };
  event(name, "TOOLKIT.READ", { tool: name, executor: mock ? "mock" : "toolkit" });
  return { kind: "toolkit_result", tool: name, result };
}
export function trace(tool: string) {
  if (readOnlyToolkit.includes(tool)) return { tool, source: "paypal-agent-toolkit", executor: mock ? "mock" : "toolkit" };
  const methods: Record<string, keyof PayPalClient> = {
    create_invoice: "createDraftInvoice", create_invoice_series: "createDraftInvoice",
    send_invoice: "sendInvoice", send_invoice_reminder: "remindInvoice", remind_invoice: "remindInvoice",
    cancel_sent_invoice: "cancelInvoice", record_payment_for_invoice: "recordPayment", record_payment: "recordPayment",
    refund: "recordRefund", refund_invoice: "recordRefund", record_refund_for_invoice: "recordRefund",
    create_order: "createOrder", get_order: "getOrder", pay_order: "captureOrder", get_invoice: "getInvoice",
  };
  const official = methods[tool] && toolForMethod[methods[tool]];
  return { tool, source: official ? "paypal-agent-toolkit" : "ledgerly",
    executor: mock ? "mock" : process.env.PAYPAL_TOOLKIT_EXECUTION === "toolkit" && official &&
      paypalTools.some((t: any) => t.function.name === official) ? "toolkit" : "ours" };
}

const toolForMethod: Partial<Record<keyof PayPalClient, string>> = {
  createDraftInvoice: "create_invoice", sendInvoice: "send_invoice",
  remindInvoice: "send_invoice_reminder", cancelInvoice: "cancel_sent_invoice",
  recordPayment: "record_payment_for_invoice", recordRefund: "record_refund_for_invoice",
  createOrder: "create_order", getOrder: "get_order", captureOrder: "pay_order",
  getInvoice: "get_invoice", listInvoices: "list_invoices", refundCapture: "create_refund", getRefund: "get_refund",
};
export async function invokePayPal(method: keyof PayPalClient, args: any[], session = "default", handler = toolkit.handleToolCall.bind(toolkit), force = false) {
  const name = toolForMethod[method];
  const enabled = force || !mock && process.env.PAYPAL_TOOLKIT_EXECUTION === "toolkit" && name &&
    paypalTools.some((t: any) => t.function.name === name);
  if (!enabled) {
    const value = await (directPayPal[method] as any).apply(directPayPal, args);
    if (method !== "getAccessToken") event(typeof args[0] === "string" ? args[0] : value?.id || "paypal", "PAYPAL.EXECUTED", {
      operation: method, executor: mock ? "mock" : "ours",
      ...(!mock && process.env.PAYPAL_TOOLKIT_EXECUTION === "toolkit" ? { fallback: "tool unavailable in toolkit" } : {}),
    });
    return value;
  }
  const a = toolkitArguments(method, args);
  const diagnostic: { error?: ReturnType<typeof safePayPalError> } = {};
  try {
  const result = await diagnostics.run(diagnostic, () => handler({ id: "ledgerly", type: "function",
    function: { name: name!, arguments: JSON.stringify(a) } }));
  let value: any = result.content;
  if (Array.isArray(value)) value = value.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw Error("PayPal toolkit returned an invalid response"); }
  }
  if (value?.error || value?.name === "INVALID_REQUEST" || value?.name === "UNPROCESSABLE_ENTITY" || /ERROR$/.test(String(value?.name || value?.code || "")) || value?.error_details)
    throw value;
  event(args[0]?.id || (typeof args[0] === "string" ? args[0] : "toolkit"), "PAYPAL.EXECUTED", { tool: name, executor: "toolkit" });
  // Toolkit mutation responses may be empty; always fetch canonical state with our client.
  if (method === "createDraftInvoice") {
    const id = value?.id || value?.href?.split("/").pop();
    if (!id) throw Error("PayPal toolkit did not return an invoice id");
    return directPayPal.getInvoice(id);
  }
  if (["sendInvoice", "remindInvoice", "cancelInvoice", "recordPayment", "recordRefund"].includes(method))
    return directPayPal.getInvoice(args[0]);
  if (method === "createOrder") {
    if (!value?.id) throw Error("PayPal toolkit did not return an order id");
    return directPayPal.getOrder(value.id);
  }
  return value;
  } catch (error: any) {
    const raw = error?.response?.data || error?.error || error;
    const safe = diagnostic.error || safePayPalError(raw);
    console.error("PayPal toolkit error", JSON.stringify(safe));
    if (method === "captureOrder" && safe.details?.some((d: any) => /ORDER_NOT_APPROVED|PAYER_ACTION_REQUIRED/.test(d.issue))) throw Error("ORDER_NOT_APPROVED: Order needs payer approval");
    if (method !== "createOrder") throw Error("PayPal toolkit request failed: " + safe.name);
    executionTrace.set(session, "ours (fallback)");
    const value = await directPayPal.createOrder(args[0]);
    event(value.id, "PAYPAL.EXECUTED", { operation: method, executor: "ours (fallback)" });
    return value;
  }
}
function toolkitArguments(method: keyof PayPalClient, args: any[]): any {
  if (method === "createDraftInvoice") {
    const b = args[0];
    return { ...b.detail, invoicer: b.invoicer, primary_recipients: b.primary_recipients, items: b.items };
  }
  if (method === "createOrder") {
    const b = args[0], unit = b.purchase_units[0];
    return { currencyCode: unit.amount.currency_code, intent: b.intent,
      items: [{ name: unit.description || "Payment", itemCost: Number(unit.amount.value), itemTotal: Number(unit.amount.value), quantity: 1, taxPercent: 0 }] };
  }
  if (["getOrder", "captureOrder"].includes(method)) return { id: args[0] };
  if (method === "getRefund") return { refund_id: args[0] };
  if (method === "refundCapture") return { capture_id: args[0], ...args[1] };
  return { invoice_id: args[0], ...(args[1] || {}) };
}
