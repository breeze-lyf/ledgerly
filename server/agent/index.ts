import { confirmAction, resolve } from "../service.js";
import { db } from "../db.js";
import { llmConfigured } from "../config.js";
import { execute, paypalTools, trace, executionTrace } from "./toolkit.js";
const own = (name: string, properties: any) => ({
  type: "function",
  function: {
    name,
    description: name.replaceAll("_", " "),
    parameters: { type: "object", properties },
  },
});
const str = { type: "string" };
const tools = [
  ...paypalTools,
  own("refund_order", { order_id: str, amount: { type: "number" } }),
  own("refund_invoice", { client: str, invoice_id: str, amount: { type: "number" } }),
  own("create_invoice_series", {
    client_name: str,
    client_email: str,
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: str,
          quantity: { type: "number" },
          unit_amount: { type: "number" },
        },
      },
    },
    recurrence: { type: "object", properties: { count: { type: "number" } } },
  }),
  own("draft_reminder", {
    invoice_id: str,
    tone: { type: "string", enum: ["friendly", "firm", "final"] },
  }),
  own("reconcile", {
    query: { type: "string", enum: ["paid", "unpaid", "overdue"] },
    period: str,
  }),
  own("ask_clarification", { question: str }),
];
function state(session: string) {
  return JSON.parse(
    (db.prepare("SELECT pending FROM sessions WHERE id=?").get(session) as any)
      ?.pending || "null",
  );
}
function save(session: string, pending: any) {
  db.prepare("INSERT OR REPLACE INTO sessions VALUES (?,?)").run(
    session,
    JSON.stringify(pending),
  );
}
function parse(s: string): [string, any] {
  if (/who.*(hasn.?t|not).*paid|unpaid|how much.*paid|overdue/i.test(s))
    return [
      "reconcile",
      {
        query: /how much.*paid/i.test(s)
          ? "paid"
          : /overdue/i.test(s)
            ? "overdue"
            : "unpaid",
        period: /month/i.test(s) ? "month" : undefined,
      },
    ];
  if (/^(?:please )?(?:create )?invoice\b/i.test(s)) {
    const amount = s.match(/\$([\d,.]+)/),
      email = s.match(/[\w.+-]+@[\w.-]+\.[a-z]+/i)?.[0];
    const client = s
      .replace(/^(?:please )?(?:create )?invoice\s*/i, "")
      .split(/\$|for\s+\d+\s+months/i)[0]
      .replace(email || "\0", "")
      .trim();
    const count = Number(s.match(/for\s+(\d+)\s+months?/i)?.[1] || 1);
    return [
      count > 1 ? "create_invoice_series" : "create_invoice",
      {
        client_name: client,
        client_email: email,
        items: amount
          ? [
              {
                name: "Services",
                quantity: 1,
                unit_amount: Number(amount[1].replaceAll(",", "")),
              },
            ]
          : undefined,
        currency: "USD",
        recurrence: { count },
      },
    ];
  }
  const orderId = s.match(/(?:get|capture) order\s+(\S+)/i);
  if (orderId) return [/^capture/i.test(s) ? "pay_order" : "get_order", { id: orderId[1] }];
  const payment = s.match(/record payment(?: of)?\s+\$([\d,.]+)\s+(?:for|to)\s+(\S+)/i);
  if (payment) return ["record_payment_for_invoice", { invoice_id: payment[2], amount: Number(payment[1].replaceAll(",", "")) }];
  const reminder = s.match(/^send reminder (?:for|to)\s+(\S+)/i);
  if (reminder) return ["send_invoice_reminder", { invoice_id: reminder[1] }];
  if (/list|show.*invoices/i.test(s)) return ["list_invoices", {}];
  if (/payment link/i.test(s))
    return [
      "create_order",
      {
        currencyCode: "USD",
        items: [
          {
            name: s.match(/\bfor\s+(.+)$/i)?.[1] || "Payment",
            itemCost: Number(s.match(/\$([\d,.]+)/)?.[1]?.replaceAll(",", "")),
            itemTotal: Number(s.match(/\$([\d,.]+)/)?.[1]?.replaceAll(",", "")),
          },
        ],
      },
    ];
  const refundOrder = s.match(/refund(?:\s+\$([\d,.]+))?\s+(?:on|for)\s+order\s+(\S+)/i);
  if (refundOrder) return ["refund_order", { order_id: refundOrder[2], amount: refundOrder[1] ? Number(refundOrder[1].replaceAll(",", "")) : undefined }];
  if (/refund/i.test(s))
    return [
      "refund_invoice",
      {
        invoice_id:
          s.match(/(?:to|for|on)\s+(.+)$/i)?.[1] ||
          s.replace(/refund|\$[\d,.]+/gi, "").trim(),
        amount: s.match(/\$([\d,.]+)/)
          ? Number(s.match(/\$([\d,.]+)/)![1].replaceAll(",", ""))
          : undefined,
      },
    ];
  for (const [re, name] of [
    [/remind|reminder/i, "draft_reminder"],
    [/cancel/i, "cancel_sent_invoice"],
    [/send/i, "send_invoice"],
  ] as const)
    if (re.test(s))
      return [
        name,
        {
          invoice_id:
            s.match(/(?:to|for)\s+(.+)$/i)?.[1] ||
            s.replace(/send|remind|cancel|invoice|a reminder/gi, "").trim(),
          tone: s.match(/friendly|firm|final/i)?.[0]?.toLowerCase(),
        },
      ];
  throw Error(
    "Try “Invoice Acme $800”, “Who hasn’t paid this month?” or “Refund $200 to Acme”.",
  );
}
export async function chat(message: string, session = "default") {
  db.prepare(
    "INSERT INTO messages(role,content,session_id) VALUES (?,?,?)",
  ).run("user", message, session);
  let reply = "",
    cards: any[] = [],
    traces: any[] = [],
    mode = "fallback",
    notice = "";
  const run = async (name: string, args: any) => {
    if (name === "ask_clarification") {
      save(session, { question: args.question });
      return [{ kind: "clarification", text: args.question }];
    }
    if (["create_invoice", "create_invoice_series"].includes(name)) {
      const b = args.primary_recipients?.[0]?.billing_info;
      if (
        !args.client_name &&
        !b?.business_name &&
        !b?.name?.given_name &&
        !b?.name?.surname
      ) {
        save(session, { name, args, missing: "client_name" });
        return [{ kind: "clarification", text: "Who is the client?" }];
      }
      if (!args.items?.length) {
        save(session, { name, args, missing: "amount" });
        return [
          { kind: "clarification", text: "What amount should I invoice?" },
        ];
      }
    }
    if (name === "send_invoice") {
      const i = resolve(args.invoice_id);
      args.invoice_id = i.id;
      if (!i.email) {
        save(session, {
          name,
          args: { ...args, invoice_id: i.id },
          missing: "email",
        });
        return [
          { kind: "clarification", text: "What is the client email address?" },
        ];
      }
    }
    traces.push(trace(name));
    const result = await execute(name, args, session);
    if (executionTrace.has(session)) traces[traces.length - 1].executor = executionTrace.get(session);
    return result;
  };
  try {
    const pending = state(session);
    const latest = db
      .prepare(
        "SELECT * FROM actions WHERE session_id=? AND status='pending' ORDER BY rowid DESC LIMIT 1",
      )
      .get(session) as any;
    const decision = message.trim().toLowerCase()
      .replace(/[’]/g, "'").replace(/[,.!?]+/g, " ").replace(/\s+/g, " ").trim();
    const confirms = /^(?:yes(?: please)?(?: send(?: it)?)?|go ahead(?: and send(?: it)?)?|ok(?:ay)?(?: please)?(?: send(?: it)?)?|confirm|sure(?: please)?|(?:please )?send(?: it)?(?: please)?)$/;
    const cancels = /^(?:no(?: thanks| please)?|don'?t send(?: it)?|do not send(?: it)?|cancel(?: it)?)(?: please)?$/;
    if (latest && confirms.test(decision)) {
      mode = "system";
      cards = await confirmAction(latest.id, session);
      traces.push(trace(latest.name));
    } else if (latest && cancels.test(decision)) {
      mode = "system";
      cards = await confirmAction(latest.id, session, true);
      reply = "Action cancelled.";
    } else if (pending?.missing) {
      const { name, args, missing } = pending;
      if (missing === "amount") {
        const n = Number(message.match(/[\d,.]+/)?.[0]?.replaceAll(",", ""));
        if (!(n > 0)) throw Error("Please provide a positive amount.");
        args.items = [{ name: "Services", quantity: 1, unit_amount: n }];
      }
      if (missing === "client_name") args.client_name = message.trim();
      if (missing === "email") {
        const email = message.match(/[\w.+-]+@[\w.-]+\.[a-z]+/i)?.[0];
        if (!email) throw Error("Please provide a valid email address.");
        for (const id of args.invoice_ids || [args.invoice_id]) {
          const i = resolve(id);
          const data = JSON.parse(i.data);
          data.primary_recipients[0].billing_info.email_address = email;
          // Sandbox invoices need their recipient updated remotely before sending.
          await (
            await import("../paypal/index.js")
          ).paypal.updateInvoice(i.paypal_id, data);
          db.prepare("UPDATE invoices SET email=?,data=? WHERE id=?").run(
            email,
            JSON.stringify(data),
            i.id,
          );
        }
      }
      save(session, null);
      cards = await run(name, args);
    } else {
      let used = false;
      if (llmConfigured) {
        try {
          const history = (
            db
              .prepare(
                "SELECT role,content FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 20",
              )
              .all(session) as any[]
          ).reverse();
          const messages: any[] = [
            {
              role: "system",
              content:
                "You are Ledgerly. Use tools for financial operations. Never send or refund without user confirmation: tool calls only propose pending actions. Use create_invoice_series for N months. Ask clarification for missing client, amount or email before sending. Use reconcile for paid/unpaid/overdue questions. Use draft_reminder for reminders. For refunds on an order use refund_order with order_id and optional amount. For refunds by client or invoice ALWAYS use refund_invoice with client or invoice_id and optional amount. Never ask the user for capture IDs; refund_invoice resolves stored payment details and proposes a pending refund for confirmation. Never claim success without tool results. Creating a draft automatically proposes sending it; do not call send_invoice again for that draft. Never create an invoice that duplicates an existing DRAFT for the same client and amount in this session; reuse the existing draft and its pending send action.",
            },
            ...history,
          ];
          for (let n = 0; n < 5; n++) {
            const r = await fetch(
              process.env.LLM_BASE_URL!.replace(/\/$/, "") +
                "/chat/completions",
              {
                method: "POST",
                headers: {
                  Authorization: "Bearer " + process.env.LLM_API_KEY,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: process.env.LLM_MODEL,
                  messages,
                  tools,
                }),
                signal: AbortSignal.timeout(30000),
              },
            );
            if (!r.ok) throw Error("LLM unavailable");
            const m = ((await r.json()) as any).choices?.[0]?.message;
            if (!m) throw Error("Invalid LLM response");
            messages.push(m);
            if (!m.tool_calls?.length) {
              reply = m.content || "Review the details below.";
              used = true;
              break;
            }
            for (const call of m.tool_calls) {
              let result;
              try {
                result = await run(
                  call.function.name,
                  JSON.parse(call.function.arguments),
                );
                cards.push(...result);
              } catch (e) {
                result = { error: (e as Error).message };
              }
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify(result),
              });
            }
            used = true;
          }
          mode = "llm";
        } catch {
          notice =
            "AI connection unavailable. Ledgerly is using its built-in assistant.";
          used = cards.length > 0;
        }
      }
      if (!used) {
        const [name, args] = parse(message);
        cards = await run(name, args);
        mode = "fallback";
      }
    }
    if (!reply)
      reply =
        cards.find((c) => c.kind === "clarification")?.text ||
        (cards.some((c) => c.kind === "pending_action")
          ? "Review the details, then confirm or cancel. Nothing has been sent or refunded yet."
          : cards.some((c) => c.kind === "summary")
            ? "Here is your reconciliation summary."
            : "Done — review the details below.");
  } catch (e) {
    reply = (e as Error).message;
  }
  const payload = { cards, traces, mode, notice };
  db.prepare(
    "INSERT INTO messages(role,content,session_id,payload) VALUES (?,?,?,?)",
  ).run("assistant", reply, session, JSON.stringify(payload));
  return { reply, ...payload };
}
