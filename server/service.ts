import { mock } from "./config.js";
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
  if (!ref?.trim()) throw Error("Specify an invoice or client.");
  const x =
    invoice(ref) ||
    invoices().find((i) => i.client.toLowerCase().includes(ref.toLowerCase()));
  if (!x) throw Error("Invoice not found. Choose an invoice from the panel.");
  return x;
}
export function pendingAction(name: string, args: any, session = "default") {
  const existing = (db.prepare(
    "SELECT * FROM actions WHERE session_id=? AND name=? AND status='pending' ORDER BY rowid DESC",
  ).all(session, name) as any[]).find((row) => {
    const previous = JSON.parse(row.args);
    const ids = args.invoice_ids || [args.invoice_id];
    const previousIds = previous.invoice_ids || [previous.invoice_id];
    return name === "send_invoice" && ids.length === previousIds.length &&
      ids.every((id: string) => previousIds.includes(id));
  });
  if (existing) return {
    kind: "pending_action", id: existing.id, name,
    label: "Confirm send", args: JSON.parse(existing.args),
  };
  const id = randomUUID();
  db.prepare(
    "INSERT INTO actions(id,session_id,name,args) VALUES (?,?,?,?)",
  ).run(id, session, name, JSON.stringify(args));
  return {
    kind: "pending_action",
    id,
    name,
    label: name === "refund" ? "Confirm refund" : "Confirm send",
    args,
  };
}
export async function confirmAction(
  id: string,
  session = "default",
  cancel = false,
) {
  const row = db
    .prepare("SELECT * FROM actions WHERE id=? AND session_id=?")
    .get(id, session) as any;
  if (!row || row.status !== "pending")
    throw Error("Action is no longer pending");
  if (cancel) {
    db.prepare("UPDATE actions SET status='cancelled' WHERE id=?").run(id);
    return [];
  }
  const args = JSON.parse(row.args);
  const ids = args.invoice_ids || [args.invoice_id];
  if (row.name === "send_invoice")
    for (const id of ids)
      if (!resolve(id).email) {
        db.prepare("INSERT OR REPLACE INTO sessions VALUES (?,?)").run(
          session,
          JSON.stringify({
            name: "send_invoice",
            args: { ...args, invoice_id: id },
            missing: "email",
          }),
        );
        throw Error(
          "What is the client email? Provide it in chat before confirming.",
        );
      }
  db.prepare("UPDATE actions SET status='executing' WHERE id=?").run(id);
  try {
    if (row.name === "send_invoice")
      for (const id of ids)
        if (resolve(id).status !== "DRAFT")
          throw Error("Only draft invoices can be sent");
    if (row.name === "refund") {
      if (args.invoice_id) validateRefund(resolve(args.invoice_id), args.amount);
      if (!args.capture_id)
        validateRefund(resolve(args.invoice_id), args.amount);
      else {
        const c =
          object(args.capture_id) || (await paypal.getCapture(args.capture_id));
        const remaining = Number(c.amount.value) - Number(c.refunded || 0);
        if (
          remaining <= 0 ||
          (args.amount !== undefined &&
            (!(args.amount > 0) || args.amount > remaining))
        )
          throw Error(
            `Refund exceeds remaining refundable ${remaining.toFixed(2)}`,
          );
      }
    }
    const results = [];
    for (const id of ids)
      results.push(
        ...(await (
          await import("./agent/toolkit.js")
        ).execute(row.name, { ...args, invoice_id: id }, session, true)),
      );
    db.prepare("UPDATE actions SET status='confirmed' WHERE id=?").run(row.id);
    return results;
  } catch (e) {
    db.prepare("UPDATE actions SET status='pending' WHERE id=?").run(row.id);
    throw e;
  }
}
export async function action(
  name: string,
  a: any,
  confirmed = false,
  session = "default",
): Promise<any[]> {
  if (name === "refund_invoice") {
    const ref = a.invoice_id || a.client || "";
    const i = invoice(ref) || invoices().find((i) =>
      ["PAID", "PARTIALLY_REFUNDED"].includes(i.status) && ref &&
      i.client.toLowerCase().includes(ref.toLowerCase()));
    if (!i) throw Error("No paid invoice found for this client or invoice.");
    const amount = validateRefund(i, a.amount);
    const data = JSON.parse(i.data);
    const capture_id = data.capture_id || data.payments?.transactions?.find(
      (p: any) => p.capture_id)?.capture_id;
    return action("refund", { invoice_id: i.id, amount, currency: i.currency,
      ...(capture_id ? { capture_id } : {}) }, false, session);
  }
  if (name === "create_invoice_series") name = "create_invoice";
  if (name === "reconcile") {
    const today = localDate(),
      month = today.slice(0, 7);
    const all = invoices(),
      scoped = all.filter(
        (i) =>
          a.period !== "month" ||
          i.due_date?.startsWith(month) ||
          (JSON.parse(i.data).detail?.invoice_date || i.created_at).startsWith(
            month,
          ),
      );
    const drafts = scoped.filter((i) => i.status === "DRAFT").length;
    const rows = scoped
      .filter((i) => i.status !== "DRAFT")
      .filter((i) =>
        a.query === "paid"
          ? Number(i.paid_amount) > 0 ||
            ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(i.status)
          : a.query === "overdue"
            ? i.due_date < today &&
              !["PAID", "CANCELLED", "REFUNDED"].includes(i.status)
            : ["SENT", "PARTIALLY_PAID"].includes(i.status) ||
              (i.due_date < today &&
                !["PAID", "CANCELLED", "REFUNDED"].includes(i.status)),
      );
    const totals: Record<string, number> = {};
    for (const i of rows)
      totals[i.currency] =
        (totals[i.currency] || 0) +
        (a.query === "paid"
          ? Number(i.paid_amount) || i.amount
          : i.amount - Number(i.paid_amount));
    return [
      {
        kind: "summary",
        query: a.query,
        rows,
        totals,
        drafts,
        description: `${drafts} drafts excluded. Month uses due date OR issue date in server local time.`,
      },
    ];
  }
  if (name === "send_invoice" && !confirmed) {
    const ids = a.invoice_ids || [a.invoice_id];
    for (const id of ids)
      if (resolve(id).status !== "DRAFT")
        throw Error("Only draft invoices can be sent");
    return [pendingAction(name, a, session)];
  }
  if (name === "refund" && !confirmed) {
    if (a.capture_id) {
      if (a.invoice_id) validateRefund(resolve(a.invoice_id), a.amount);
      const capture =
        object(a.capture_id) ||
        saveObject(await paypal.getCapture(a.capture_id));
      if (!capture) throw Error("Capture not found");
      const remaining =
        Number(capture.amount.value) - Number(capture.refunded || 0);
      if (
        remaining <= 0 ||
        (a.amount !== undefined &&
          (!(Number(a.amount) > 0) || Number(a.amount) > remaining))
      )
        throw Error(
          `Refund exceeds remaining refundable ${remaining.toFixed(2)}`,
        );
      return [pendingAction(name, a, session)];
    }
    const ref = a.invoice_id || "";
    const i =
      invoice(ref) ||
      invoices().find(
        (i) =>
          ["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"].includes(i.status) &&
          ref &&
          i.client.toLowerCase().includes(ref.toLowerCase()),
      ) ||
      resolve(ref);
    validateRefund(i, a.amount);
    return [pendingAction(name, { ...a, invoice_id: i.id }, session)];
  }

  if (name === "create_invoice") {
    const count = Math.min(24, Math.max(1, Number(a.recurrence?.count || 1)));
    const group = a.recurrence_group || (count > 1 ? randomUUID() : null);
    const result = [];
    for (let n = 0; n < count; n++) {
      const due = a.due_date ? new Date(a.due_date + "T12:00:00Z") : new Date();
      if (!a.due_date) due.setDate(due.getDate() + Number(a.due_in_days ?? 14));
      due.setMonth(due.getMonth() + n);
      const amount = a.items.reduce(
        (s: number, i: any) => s + Number(i.quantity) * Number(i.unit_amount),
        0,
      );
      if (!Number.isFinite(amount) || amount <= 0)
        throw Error("Invoice amount must be positive");
      const body = await invoicePayload(a, due.toISOString().slice(0, 10));
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

      result.push(invoice(p.id));
    }
    return [
      ...result,
      pendingAction(
        "send_invoice",
        { invoice_ids: result.map((i) => i.id) },
        session,
      ),
    ];
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
        approve_url: o.links?.find((l: any) => ["approve", "payer-action"].includes(l.rel))?.href,
      },
    ];
  }
  if (name === "refund" && a.capture_id) {
    if (a.invoice_id) validateRefund(resolve(a.invoice_id), a.amount);
    const capture = object(a.capture_id);
    const remaining = capture
      ? Number(capture.amount.value) - Number(capture.refunded || 0)
      : undefined;
    if (
      remaining !== undefined &&
      (remaining <= 0 ||
        (a.amount !== undefined &&
          (!(Number(a.amount) > 0) || Number(a.amount) > remaining)))
    )
      throw Error(
        `Refund exceeds remaining refundable ${remaining.toFixed(2)}`,
      );

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
    if (capture)
      saveObject({
        ...capture,
        refunded: Number(capture.refunded || 0) + Number(a.amount || remaining),
        status:
          Number(a.amount || remaining) < remaining!
            ? "PARTIALLY_REFUNDED"
            : "REFUNDED",
      });
    event(a.capture_id, "CAPTURE.REFUNDED", r);
    if (a.invoice_id) {
      const i = resolve(a.invoice_id);
      const refunded = Number(i.refunded || 0) + Number(a.amount || remaining);
      const status = refunded >= (Number(i.paid_amount) || i.amount)
        ? "REFUNDED" : "PARTIALLY_REFUNDED";
      db.prepare("UPDATE invoices SET refunded=?,status=? WHERE id=?").run(refunded, status, i.id);
      if (object(i.id)) saveObject({ ...object(i.id), status });
      event(i.id, "REFUND", { amount: a.amount, capture_id: a.capture_id });
      return [{ ...invoice(i.id), remaining_refundable:
        (Number(i.paid_amount) || i.amount) - refunded }];
    }
    return [r];
  }
  const i = resolve(a.invoice_id || a.client || "");
  let status = i.status;
  if (name === "draft_reminder") {
    const tone = ["friendly", "firm", "final"].includes(a.tone)
      ? a.tone
      : "friendly";
    const days = Math.max(
      0,
      Math.floor(
        (new Date(localDate()).getTime() - new Date(i.due_date).getTime()) /
          86400000,
      ),
    );
    const subject = `${tone === "final" ? "Final notice" : tone === "firm" ? "Payment overdue" : "Friendly payment reminder"} · ${i.id}`;
    const body = `${tone === "friendly" ? "Hi" : "Dear"} ${i.client}, your ${i.currency} ${i.amount.toFixed(2)} invoice is ${days} days overdue (due ${i.due_date}). ${tone === "final" ? "Please arrange immediate payment or contact us today to resolve this balance." : tone === "firm" ? "Please pay the outstanding balance promptly and confirm your payment date." : "When you have a moment, please arrange payment. Thank you!"}`;
    return [
      { kind: "draft", subject, body, text: body, invoice_id: i.id, tone },
    ];
  }
  if (name === "send_invoice") {
    if (i.status !== "DRAFT") throw Error("Only draft invoices can be sent");
    if (!i.email) throw Error("Client email required before sending");
    await paypal.sendInvoice(i.paypal_id);
    status = "SENT";
  } else if (name === "remind_invoice") {
    if (!["SENT", "PARTIALLY_PAID"].includes(i.status))
      throw Error("Send the invoice before reminding");
    await paypal.remindInvoice(i.paypal_id, {
      subject: a.subject || "Payment reminder",
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
      method: "CASH",
      type: "EXTERNAL",
      payment_date: new Date().toISOString().slice(0, 10),
      amount: {
        currency_code: i.currency,
        value: Number(a.amount || i.amount).toFixed(2),
      },
    });
    db.prepare("UPDATE invoices SET paid_amount=? WHERE id=?").run(
      Number(i.paid_amount || 0) + Number(a.amount || i.amount),
      i.id,
    );
    status =
      Number(a.amount || i.amount) < i.amount ? "PARTIALLY_PAID" : "PAID";
  } else if (name === "refund") {
    if (!["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"].includes(i.status))
      throw Error("Only paid invoices can be refunded");
    const refundAmount = validateRefund(i, a.amount);
    await paypal.recordRefund(i.paypal_id, {
      method: "CASH",
      type: "EXTERNAL",
      refund_date: new Date().toISOString().slice(0, 10),
      amount: {
        currency_code: i.currency,
        value: refundAmount.toFixed(2),
      },
    });
    const refunded = Number(i.refunded || 0) + refundAmount;
    db.prepare("UPDATE invoices SET refunded=? WHERE id=?").run(refunded, i.id);
    status =
      refunded >= (Number(i.paid_amount) || i.amount)
        ? "REFUNDED"
        : "PARTIALLY_REFUNDED";
  } else throw Error("Unknown action");
  db.prepare("UPDATE invoices SET status=? WHERE id=?").run(status, i.id);
  if (!mock) {
    const remote = await paypal.getInvoice(i.paypal_id);
    const map: Record<string, string> = { MARKED_AS_PAID: "PAID", MARKED_AS_REFUNDED: "REFUNDED" };
    const remoteStatus = map[remote.status] || remote.status;
    // Keep locally derived refund states; PayPal may still report the invoice as paid.
    if (!(["PARTIALLY_REFUNDED", "REFUNDED"].includes(status) && ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(remoteStatus)))
      status = remoteStatus;
    db.prepare("UPDATE invoices SET status=?,data=? WHERE id=?").run(status, JSON.stringify(remote), i.id);
    saveObject(remote);
  } else if (object(i.id)) saveObject({ ...object(i.id), status });
  event(i.id, name.toUpperCase(), { amount: a.amount, message: a.message });
  return [
    {
      ...invoice(i.id),
      remaining_refundable:
        (Number(invoice(i.id).paid_amount) || i.amount) -
        Number(invoice(i.id).refunded || 0),
    },
  ];
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
  let id = r.invoice?.id || r.invoice_id || r.id;
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
  if (status === "PAID") {
    db.prepare("UPDATE invoices SET paid_amount=amount WHERE id=?").run(id);
    const i = invoice(id);
    if (i) {
      const data = JSON.parse(i.data);
      const payment = r.payments?.transactions?.find((p: any) => p.capture_id || p.payment_id);
      const capture_id = r.capture_id || payment?.capture_id ||
        (e.event_type === "PAYMENT.CAPTURE.COMPLETED" ? r.id : undefined) ||
        data.capture_id || (mock ? "CAP-" + randomUUID().slice(0, 12) : undefined);
      const payment_id = payment?.payment_id || r.payment_id || capture_id;
      if (capture_id && mock && !object(capture_id)) saveObject({
        id: capture_id, status: "COMPLETED", invoice_id: i.id,
        amount: { currency_code: i.currency, value: Number(i.amount).toFixed(2) },
      });
      db.prepare("UPDATE invoices SET data=? WHERE id=?").run(
        JSON.stringify({ ...data, ...(capture_id ? { capture_id } : {}),
          ...(payment_id ? { payment_id } : {}) }), i.id);
    }
  }
  if (status && object(id)) saveObject({ ...object(id), status });
  for (const fn of listeners) fn(e);
}

export function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function validateRefund(i: any, amount: any) {
  if (!["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"].includes(i.status))
    throw Error("Only paid invoices can be refunded");
  const remaining =
    Math.round(
      ((Number(i.paid_amount) || i.amount) - Number(i.refunded || 0)) * 100,
    ) / 100;
  const value = amount === undefined ? remaining : Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > remaining)
    throw Error(
      `Refund exceeds remaining refundable ${i.currency} ${remaining.toFixed(2)} (or amount is invalid)`,
    );
  return value;
}

export async function invoicePayload(a: any, dueDate: string) {
  const currency = a.currency || "USD";
  const generated = await paypal.generateInvoiceNumber();
  return {
    detail: {
      invoice_number: generated.invoice_number,
      currency_code: currency,
      invoice_date: a.invoice_date || localDate(),
      ...(a.note ? { note: a.note } : {}),
      payment_term: a.payment_term === "NET_10" ? { term_type: "NET_10" } : { term_type: "DUE_ON_DATE_SPECIFIED", due_date: dueDate },
    },
    invoicer: { email_address: process.env.PAYPAL_SANDBOX_BUSINESS_EMAIL || (mock ? "merchant@example.com" : undefined) },
    primary_recipients: [{ billing_info: {
      business_name: a.client_name,
      ...(a.client_email ? { email_address: a.client_email } : {}),
    } }],
    items: a.items.map((i: any) => ({ name: i.name, quantity: String(i.quantity),
      unit_amount: { currency_code: currency, value: Number(i.unit_amount).toFixed(2) } })),
  };
}
