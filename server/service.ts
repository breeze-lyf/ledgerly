import { randomUUID } from "node:crypto";
import { db, invoice, invoices, object, saveObject } from "./db.js";
import { paypal } from "./paypal/index.js";
export const listeners = new Set<(event: any) => void>();
export function event(id: string, type: string, data: any = {}) {
  const e = {
    id: randomUUID(),
    invoice_id: id,
    event_type: type,
    data,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    "INSERT INTO events (id,invoice_id,event_type,data,created_at) VALUES (?,?,?,?,?)",
  ).run(e.id, id, type, JSON.stringify(data), e.created_at);
  for (const fn of listeners) fn(e);
  return e;
}
export function resolve(ref: string) {
  const x =
    invoice(ref) ||
    invoices().find((i) => i.client.toLowerCase().includes(ref.toLowerCase()));
  if (!x) throw Error("Invoice not found. Choose an invoice from the panel.");
  return x;
}
export async function action(name: string, a: any): Promise<any[]> {
  if (name === "create_invoice") {
    const count = Math.min(24, Math.max(1, Number(a.recurrence?.count || 1)));
    const group = count > 1 ? randomUUID() : null;
    const result = [];
    for (let n = 0; n < count; n++) {
      const due = new Date();
      due.setDate(due.getDate() + Number(a.due_in_days ?? 14));
      due.setMonth(due.getMonth() + n);
      const amount = a.items.reduce(
        (s: number, i: any) => s + Number(i.quantity) * Number(i.unit_amount),
        0,
      );
      if (!Number.isFinite(amount) || amount <= 0)
        throw Error("Invoice amount must be positive");
      const body = {
        detail: {
          currency_code: a.currency || "USD",
          note: a.note,
          payment_term: {
            term_type: "DUE_ON_DATE",
            due_date: due.toISOString().slice(0, 10),
          },
        },
        primary_recipients: [
          {
            billing_info: {
              name: { full_name: a.client_name },
              ...(a.client_email ? { email_address: a.client_email } : {}),
            },
          },
        ],
        items: a.items.map((i: any) => ({
          name: i.name,
          quantity: String(i.quantity),
          unit_amount: {
            currency_code: a.currency || "USD",
            value: Number(i.unit_amount).toFixed(2),
          },
        })),
      };
      let p = await paypal.createDraftInvoice(body);
      if (!p.id && p.href) p = await paypal.getInvoice(p.href.split("/").pop());
      db.prepare(
        "INSERT INTO invoices (id,paypal_id,client,email,amount,currency,status,due_date,recurrence_group,data) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        p.id,
        p.id,
        a.client_name,
        a.client_email || null,
        amount,
        a.currency || "USD",
        "DRAFT",
        due.toISOString().slice(0, 10),
        group,
        JSON.stringify(p),
      );
      if (object(p.id))
        saveObject({
          ...object(p.id),
          amount: {
            value: amount.toFixed(2),
            currency_code: a.currency || "USD",
          },
        });
      event(p.id, "INVOICE.CREATED");
      if (a.send) await action("send_invoice", { invoice_id: p.id });
      result.push(invoice(p.id));
    }
    return result;
  }
  if (name === "list_invoices") {
    return invoices().filter(
      (i) =>
        (!a.status ||
          (a.status === "UNPAID"
            ? ["DRAFT", "SENT", "PARTIALLY_PAID"].includes(i.status)
            : i.status === a.status)) &&
        (!a.client ||
          i.client.toLowerCase().includes(a.client.toLowerCase())) &&
        (!a.period ||
          a.period !== "month" ||
          i.created_at.slice(0, 7) === new Date().toISOString().slice(0, 7)),
    );
  }
  if (name === "create_payment_link") {
    if (!(Number(a.amount) > 0)) throw Error("Amount must be positive");
    const o = await paypal.createOrder({
      intent: "CAPTURE",
      purchase_units: [
        {
          description: a.description,
          amount: {
            currency_code: a.currency || "USD",
            value: Number(a.amount).toFixed(2),
          },
        },
      ],
    });
    event(o.id, "ORDER.CREATED");
    return [
      {
        ...o,
        kind: "payment_link",
        approve_url: o.links?.find((l: any) => l.rel === "approve")?.href,
      },
    ];
  }
  if (name === "refund" && a.capture_id) {
    const r = await paypal.refundCapture(
      a.capture_id,
      a.amount
        ? {
            amount: {
              value: Number(a.amount).toFixed(2),
              currency_code: a.currency || "USD",
            },
          }
        : {},
    );
    event(a.capture_id, "CAPTURE.REFUNDED", r);
    return [r];
  }
  const i = resolve(a.invoice_id || a.client || "");
  let status = i.status;
  if (name === "draft_reminder")
    return [
      {
        kind: "draft",
        text: `Hi ${i.client}, a friendly reminder that your ${i.currency} ${i.amount.toFixed(2)} invoice is due ${i.due_date}. Thank you!`,
        invoice_id: i.id,
        tone: a.tone || "friendly",
      },
    ];
  if (name === "send_invoice") {
    if (i.status !== "DRAFT") throw Error("Only draft invoices can be sent");
    await paypal.sendInvoice(i.paypal_id);
    status = "SENT";
  } else if (name === "remind_invoice") {
    if (!["SENT", "PARTIALLY_PAID"].includes(i.status))
      throw Error("Send the invoice before reminding");
    await paypal.remindInvoice(i.paypal_id, {
      subject: "Payment reminder",
      note: a.message || "A friendly reminder about your invoice.",
      send_to_recipient: true,
    });
  } else if (name === "cancel_invoice") {
    if (!["DRAFT", "SENT", "PARTIALLY_PAID"].includes(i.status))
      throw Error("This invoice cannot be cancelled");
    await paypal.cancelInvoice(i.paypal_id);
    status = "CANCELLED";
  } else if (name === "record_payment") {
    await paypal.recordPayment(i.paypal_id, {
      method: "OTHER",
      payment_date: new Date().toISOString().slice(0, 10),
      amount: {
        currency_code: i.currency,
        value: Number(a.amount || i.amount).toFixed(2),
      },
    });
    status =
      Number(a.amount || i.amount) < i.amount ? "PARTIALLY_PAID" : "PAID";
  } else if (name === "refund") {
    if (!["PAID", "PARTIALLY_PAID"].includes(i.status))
      throw Error("Only paid invoices can be refunded");
    if (a.amount && (a.amount <= 0 || a.amount > i.amount))
      throw Error("Invalid refund amount");
    await paypal.recordRefund(i.paypal_id, {
      method: "OTHER",
      refund_date: new Date().toISOString().slice(0, 10),
      amount: {
        currency_code: i.currency,
        value: Number(a.amount || i.amount).toFixed(2),
      },
    });
    status = "REFUNDED";
  } else throw Error("Unknown action");
  db.prepare("UPDATE invoices SET status=? WHERE id=?").run(status, i.id);
  event(i.id, name.toUpperCase(), { amount: a.amount, message: a.message });
  return [invoice(i.id)];
}
export function simulated(type: string, id: string, amount?: number) {
  const i = invoice(id);
  return {
    id: "WH-" + randomUUID(),
    event_type: type,
    create_time: new Date().toISOString(),
    resource_type: type.startsWith("INVOICING") ? "invoices" : "capture",
    resource: type.startsWith("INVOICING")
      ? {
          id,
          invoice_id: id,
          status: type.split(".").pop(),
          amount: {
            currency_code: i?.currency || "USD",
            value: String(amount || i?.amount || 0),
          },
        }
      : {
          id,
          amount: { currency_code: "USD", value: String(amount || 0) },
          supplementary_data: {
            related_ids: { order_id: object(id)?.order_id || id },
          },
        },
  };
}
export function webhook(e: any) {
  if (!e.id || !e.event_type || !e.resource) throw Error("Invalid webhook");
  if (db.prepare("SELECT id FROM events WHERE id=?").get(e.id)) return;
  const r = e.resource;
  let id = r.invoice_id || r.id;
  const related = r.supplementary_data?.related_ids;
  if (!invoice(id) && related?.order_id) id = related.order_id;
  const statuses: Record<string, string> = {
    "INVOICING.INVOICE.PAID": "PAID",
    "INVOICING.INVOICE.CANCELLED": "CANCELLED",
    "INVOICING.INVOICE.REFUNDED": "REFUNDED",
    "PAYMENT.CAPTURE.COMPLETED": "PAID",
    "PAYMENT.CAPTURE.REFUNDED": "REFUNDED",
  };
  const status = statuses[e.event_type];
  db.transaction(() => {
    db.prepare(
      "INSERT INTO events (id,invoice_id,event_type,data) VALUES (?,?,?,?)",
    ).run(e.id, id, e.event_type, JSON.stringify(e));
    if (status)
      db.prepare("UPDATE invoices SET status=? WHERE id=? OR paypal_id=?").run(
        status,
        id,
        id,
      );
  })();
  if (status && object(id)) saveObject({ ...object(id), status });
  for (const fn of listeners) fn(e);
}
