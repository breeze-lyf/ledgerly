import {
  PayPalAgentToolkit,
  ALL_TOOLS_ENABLED,
} from "@paypal/agent-toolkit/openai";
import { mock } from "../config.js";
import { action, pendingAction, event, localDate } from "../service.js";
import { paypal } from "../paypal/index.js";
import { db, invoice, object, saveObject } from "../db.js";
const actions = Object.fromEntries(
  ["invoices", "orders", "payments", "refunds"].map((k) => [
    k,
    ALL_TOOLS_ENABLED[k] || {},
  ]),
);
export const toolkit = new PayPalAgentToolkit({
  clientId: mock ? "mock" : process.env.PAYPAL_CLIENT_ID!,
  clientSecret: mock ? "mock" : process.env.PAYPAL_CLIENT_SECRET!,
  configuration: { actions, context: { sandbox: true } },
});
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
      : "sandbox",
};
export async function execute(
  name: string,
  a: any,
  session = "default",
  confirmed = false,
): Promise<any[]> {
  const result = await executeTool(name, a, session, confirmed);
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
  if (name === "refund" && a.invoice_id && a.capture_id)
    return action(name, a, confirmed, session);
  let originalArgs = structuredClone(a);
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
  const toolkitName =
    name === "refund"
      ? a.capture_id
        ? "create_refund"
        : "record_refund_for_invoice"
      : name;
  if (
    !mock &&
    process.env.PAYPAL_TOOLKIT_EXECUTION === "toolkit" &&
    names.includes(toolkitName)
  ) {
    if (name === "create_invoice" && !originalArgs.primary_recipients)
      originalArgs = {
        currency_code: a.currency || "USD",
        invoice_date: localDate(),
        primary_recipients: [
          {
            billing_info: {
              business_name: a.client_name,
              ...(a.client_email ? { email_address: a.client_email } : {}),
            },
          },
        ],
        items: a.items.map((i: any) => ({
          ...i,
          quantity: String(i.quantity),
          unit_amount: {
            currency_code: a.currency || "USD",
            value: Number(i.unit_amount).toFixed(2),
          },
        })),
        note: a.note,
      };
    if (toolkitName === "record_refund_for_invoice") {
      originalArgs.method = originalArgs.method || "OTHER";
      originalArgs.refund_date = originalArgs.refund_date || localDate();
      if (!originalArgs.amount) {
        const i = invoice(a.invoice_id);
        originalArgs.amount = {
          currency_code: i.currency,
          value: (
            (Number(i.paid_amount) || i.amount) - Number(i.refunded || 0)
          ).toFixed(2),
        };
      }
    }
    if (name === "refund" && typeof originalArgs.amount === "number")
      originalArgs.amount = {
        value: originalArgs.amount.toFixed(2),
        currency_code: a.currency || invoice(a.invoice_id)?.currency || "USD",
      };
    const r = await toolkit.handleToolCall({
      id: "ledgerly",
      type: "function",
      function: { name: toolkitName, arguments: JSON.stringify(originalArgs) },
    });
    let value: any;
    try {
      value = JSON.parse(String(r.content));
    } catch {
      value = { text: r.content };
    }
    if (value?.error || (value?.code && value?.message))
      throw Error(JSON.stringify(value.error || value));
    if (name === "create_invoice") {
      const p = value.id
        ? value
        : await paypal.getInvoice(value.href?.split("/").pop());
      const amount = a.items.reduce(
        (s: number, i: any) => s + Number(i.quantity) * Number(i.unit_amount),
        0,
      );
      db.prepare(
        "INSERT INTO invoices(id,paypal_id,client,email,amount,currency,status,due_date,data) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        p.id,
        p.id,
        a.client_name,
        a.client_email || null,
        amount,
        a.currency || "USD",
        "DRAFT",
        p.detail?.payment_term?.due_date ||
          new Date().toISOString().slice(0, 10),
        JSON.stringify(p),
      );
      event(p.id, "INVOICE.CREATED", { executor: "toolkit" });
      return [
        invoice(p.id),
        pendingAction("send_invoice", { invoice_id: p.id }, session),
      ];
    }
    if (name === "send_invoice") {
      event(a.invoice_id, "SEND_INVOICE", { executor: "toolkit" });
      db.prepare("UPDATE invoices SET status='SENT' WHERE id=?").run(
        a.invoice_id,
      );
      return [invoice(a.invoice_id)];
    }
    if (toolkitName === "record_refund_for_invoice") {
      const i = invoice(a.invoice_id);
      const refunded =
        Number(i.refunded || 0) +
        Number(
          a.amount ||
            (Number(i.paid_amount) || i.amount) - Number(i.refunded || 0),
        );
      db.prepare("UPDATE invoices SET refunded=?,status=? WHERE id=?").run(
        refunded,
        refunded >= (Number(i.paid_amount) || i.amount)
          ? "REFUNDED"
          : "PARTIALLY_REFUNDED",
        i.id,
      );
      event(i.id, "REFUND", { amount: a.amount, executor: "toolkit" });
      return [
        {
          ...invoice(i.id),
          remaining_refundable: (Number(i.paid_amount) || i.amount) - refunded,
        },
      ];
    }
    if (toolkitName === "create_refund" && a.capture_id) {
      const capture = object(a.capture_id);
      if (capture) {
        const refunded =
          Number(capture.refunded || 0) +
          Number(
            a.amount ||
              Number(capture.amount.value) - Number(capture.refunded || 0),
          );
        saveObject({
          ...capture,
          refunded,
          status:
            refunded >= Number(capture.amount.value)
              ? "REFUNDED"
              : "PARTIALLY_REFUNDED",
        });
      }
      event(a.capture_id, "CAPTURE.REFUNDED", value);
    }
    if (name === "cancel_sent_invoice")
      db.prepare("UPDATE invoices SET status='CANCELLED' WHERE id=?").run(
        a.invoice_id,
      );
    if (name === "record_payment_for_invoice") {
      const i = invoice(a.invoice_id);
      const paid = Number(i.paid_amount || 0) + Number(a.amount || i.amount);
      db.prepare("UPDATE invoices SET paid_amount=?,status=? WHERE id=?").run(
        paid,
        paid >= i.amount ? "PAID" : "PARTIALLY_PAID",
        i.id,
      );
      event(i.id, "RECORD_PAYMENT", { amount: a.amount });
    }
    return [value];
  }
  if (name === "get_invoice") return [await paypal.getInvoice(a.invoice_id)];
  if (name === "get_order") return [await paypal.getOrder(a.id)];
  if (name === "pay_order") return [await paypal.captureOrder(a.id)];
  if (name === "get_refund") return [await paypal.getRefund(a.refund_id)];
  if (name === "create_order")
    return action(
      "create_payment_link",
      {
        currency: a.currencyCode,
        description: a.notes || a.items?.[0]?.name,
        amount:
          a.items?.reduce((s: number, i: any) => s + Number(i.itemTotal), 0) +
          Number(a.shippingCost || 0) -
          Number(a.discount || 0),
      },
      false,
      session,
    );
  return action(mapped, a, confirmed, session);
}
export function trace(tool: string) {
  if (tool === "refund") tool = "record_refund_for_invoice";
  const official = paypalTools.some((t: any) => t.function.name === tool);
  return {
    tool,
    source: official ? "paypal-agent-toolkit" : "ledgerly",
    executor: official ? toolkitHealth.execution : mock ? "mock" : "sandbox",
  };
}
