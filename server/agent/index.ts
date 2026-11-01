import { action } from "../service.js";
import { db } from "../db.js";
import { llmConfigured } from "../config.js";
const string = { type: "string" },
  number = { type: "number" };
const definitions: Record<string, any> = {
  create_invoice: {
    client_name: string,
    client_email: string,
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { name: string, quantity: number, unit_amount: number },
        required: ["name", "quantity", "unit_amount"],
      },
    },
    currency: string,
    due_in_days: number,
    recurrence: {
      type: "object",
      properties: {
        interval: { type: "string", enum: ["month"] },
        count: number,
      },
      required: ["interval", "count"],
    },
    note: string,
    send: { type: "boolean" },
  },
  send_invoice: { invoice_id: string },
  remind_invoice: { invoice_id: string, message: string },
  cancel_invoice: { invoice_id: string },
  record_payment: { invoice_id: string, amount: number },
  refund: { invoice_id: string, capture_id: string, amount: number },
  create_payment_link: {
    amount: number,
    currency: string,
    description: string,
  },
  list_invoices: { status: string, client: string, period: string },
  draft_reminder: { invoice_id: string, tone: string },
};
const tools = Object.entries(definitions).map(([name, properties]) => ({
  type: "function",
  function: {
    name,
    description: name.replaceAll("_", " "),
    parameters: {
      type: "object",
      properties,
      required:
        name === "create_invoice"
          ? ["client_name", "items", "currency"]
          : name === "create_payment_link"
            ? ["amount", "currency", "description"]
            : [],
    },
  },
}));
function parse(s: string): [string, any] {
  let m = s.match(/invoice\s+(.+?)\s+\$([\d,.]+)(\/month)?\s*(.*)/i);
  if (m) {
    const count = m[4].match(/for\s+(\d+)\s+months?/i);
    return [
      "create_invoice",
      {
        client_name: m[1],
        items: [
          {
            name:
              m[4].replace(/for\s+\d+\s+months?.*/i, "").trim() || "Services",
            quantity: 1,
            unit_amount: Number(m[2].replaceAll(",", "")),
          },
        ],
        currency: "USD",
        ...(m[3] || count
          ? {
              recurrence: { interval: "month", count: Number(count?.[1] || 1) },
            }
          : {}),
      },
    ];
  }
  if (/who.*(hasn.?t|not).*paid|unpaid/i.test(s))
    return [
      "list_invoices",
      { status: "UNPAID", period: /month/i.test(s) ? "month" : undefined },
    ];
  if (/list|show.*invoices/i.test(s)) return ["list_invoices", {}];
  if (/payment link/i.test(s)) {
    m = s.match(/\$([\d,.]+)/);
    if (!m)
      throw Error(
        "Include an amount, for example: payment link $50 for design.",
      );
    return [
      "create_payment_link",
      {
        amount: Number(m[1].replaceAll(",", "")),
        currency: "USD",
        description: s.replace(/.*\$[\d,.]+\s*(for)?\s*/i, "") || "Payment",
      },
    ];
  }
  if (/refund/i.test(s)) {
    const amount = s.match(/\$([\d,.]+)/);
    const ref = s.match(/(?:on|to|for)\s+(.+)$/i);
    return [
      "refund",
      {
        invoice_id: ref?.[1] || s.replace(/refund|\$[\d,.]+/gi, "").trim(),
        amount: amount ? Number(amount[1].replaceAll(",", "")) : undefined,
      },
    ];
  }
  for (const [re, name] of [
    [/remind|reminder/i, "remind_invoice"],
    [/cancel/i, "cancel_invoice"],
    [/send/i, "send_invoice"],
  ] as const)
    if (re.test(s)) {
      const ref = s.match(/(?:to|for)\s+(.+)$/i);
      return [
        name,
        {
          invoice_id:
            ref?.[1] ||
            s.replace(/send|remind|cancel|invoice|a reminder/gi, "").trim(),
        },
      ];
    }
  throw Error(
    "Try “Invoice Acme $800/month maintenance for 3 months”, “Send invoice to Acme”, or “Who hasn’t paid?”",
  );
}
export async function chat(message: string) {
  db.prepare("INSERT INTO messages(role,content) VALUES (?,?)").run(
    "user",
    message,
  );
  let reply = "",
    cards: any[] = [],
    mode: "llm" | "fallback" = "fallback";
  if (llmConfigured) {
    try {
      const history = (
        db
          .prepare(
            "SELECT role,content FROM messages ORDER BY id DESC LIMIT 20",
          )
          .all() as any[]
      ).reverse();
      const messages: any[] = [
        {
          role: "system",
          content:
            "You are Ledgerly, a concise invoicing assistant. Use tools for all financial operations and look up invoice IDs with list_invoices. Monthly requests must create recurrence with the requested count. Never claim an operation succeeded without a tool result. Invoice refunds record an external refund; capture refunds actually move money.",
        },
        ...history,
      ];
      for (let round = 0; round < 5; round++) {
        const r = await fetch(
          process.env.LLM_BASE_URL!.replace(/\/$/, "") + "/chat/completions",
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
        const data = (await r.json()) as any;
        const m = data.choices?.[0]?.message;
        if (!m) throw Error("Invalid LLM response");
        messages.push(m);
        if (!m.tool_calls?.length) {
          reply = m.content || "Done.";
          mode = "llm";
          break;
        }
        for (const call of m.tool_calls) {
          let result;
          try {
            result = await action(
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
        mode = "llm";
        reply =
          "Your request has been processed. Review the cards for details.";
      }
    } catch {
      if (cards.length) {
        reply =
          "Completed the actions shown below. The AI connection was interrupted.";
        mode = "llm";
      } else mode = "fallback";
    }
  }
  if (mode === "fallback") {
    try {
      const [name, args] = parse(message);
      cards = await action(name, args);
      reply =
        name === "create_invoice"
          ? `Created ${cards.length} draft invoice${cards.length === 1 ? "" : "s"} for ${args.client_name}${cards.length > 1 ? ", one month apart" : ""}. Review and send when ready.`
          : name === "list_invoices"
            ? `${cards.length} invoice${cards.length === 1 ? "" : "s"} found.`
            : name === "refund"
              ? "Refund recorded. Invoice refunds track money returned outside Ledgerly."
              : "Done — your details are below.";
    } catch (e) {
      reply = (e as Error).message;
    }
  }
  db.prepare("INSERT INTO messages(role,content) VALUES (?,?)").run(
    "assistant",
    reply,
  );
  return { reply, cards, mode };
}
