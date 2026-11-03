import { scanCollections, reminderPlan, recordReminder, cashflow, unpaid } from "./collections.js";
import { mock } from "./config.js";
import { randomUUID } from "node:crypto";
import { db, invoice, invoices, object, saveObject, order } from "./db.js";
import { paypal } from "./paypal/index.js";
import { createRetainer, cancelRetainer, retainerArgs, retainers, retainer, retainerWebhook } from "./subscriptions.js";
import { settleInvoiceCapture, invoiceForCapture, payLinkFor, payLink } from "./lifecycle.js";
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
    return ["send_invoice", "remind_invoice"].includes(name) && ids.length === previousIds.length &&
      ids.every((id: string) => previousIds.includes(id));
  });
  if (existing) return {
    kind: "pending_action", id: existing.id, name,
    label: name === "remind_invoice" ? "Confirm reminder" : "Confirm send", args: JSON.parse(existing.args),
  };
  const id = randomUUID();
  db.prepare(
    "INSERT INTO actions(id,session_id,name,args) VALUES (?,?,?,?)",
  ).run(id, session, name, JSON.stringify(args));
  return {
    kind: "pending_action",
    id,
    name,
    label: name === "refund" ? "Confirm refund" : name === "remind_invoice" ? "Confirm reminder"
      : name === "create_retainer" ? "Confirm retainer subscription" : name === "cancel_retainer" ? "Confirm cancellation" : "Confirm send",
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
  // Invoices paid through the pay page refund real money via the PayPal capture.
  if (name === "refund" && a.invoice_id && !a.capture_id) {
    const s = db.prepare("SELECT capture_id FROM settlements WHERE invoice_id=(SELECT id FROM invoices WHERE id=? OR paypal_id=?) ORDER BY rowid DESC").get(a.invoice_id, a.invoice_id) as any;
    if (s) a = { ...a, capture_id: s.capture_id };
  }
  if (name === "refund_order" || (name === "refund" && a.order_id && !a.capture_id)) {
    const o = order(a.order_id);
    if (!o?.capture_id) throw Error("Order has no captured payment");
    return action("refund", { ...a, order_id: o.id, capture_id: o.capture_id, currency: o.currency }, confirmed, session);
  }
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
  // Retainers (PayPal Subscriptions): creating or cancelling is always proposed first, then confirmed by a human.
  if (name === "create_retainer")
    return confirmed ? [await createRetainer(a, session)] : [pendingAction("create_retainer", retainerArgs(a), session)];
  if (name === "cancel_retainer") {
    const r = retainer(a.retainer_id || a.subscription_id || "") ||
      retainers().find((x) => a.client && x.client.toLowerCase().includes(String(a.client).toLowerCase()) && !["CANCELLED", "EXPIRED"].includes(x.status));
    if (!r) throw Error("Retainer not found");
    return confirmed ? [await cancelRetainer(r.id)] : [pendingAction("cancel_retainer", { retainer_id: r.id, client: r.client }, session)];
  }
  if (name === "list_retainers") return retainers().map((r) => ({ kind: "retainer", ...r }));
  if (name === "what_needs_collecting") return [scanCollections()];
  if (name === "cashflow") return [{kind:"cashflow", ...cashflow()}];
  if (name === "run_collections") {
    const scan = scanCollections();
    return [scan, ...scan.rows.filter(i => i.eligible).map(i => pendingAction("remind_invoice", reminderPlan(i), session))];
  }
  if (name === "remind_invoice" && !confirmed) {
    const i = resolve(a.invoice_id);
    if (!unpaid(i)) throw Error("Only unpaid, sent invoices can be reminded");
    return [pendingAction(name, {...a, invoice_id:i.id}, session)];
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
    saveObject(o);
    db.prepare("INSERT INTO orders(id,description,amount,currency,status,approve_url,data) VALUES (?,?,?,?,?,?,?)").run(o.id, a.description || "Payment", Number(a.amount), a.currency || "USD", o.status, o.links?.find((l: any) => ["approve", "payer-action"].includes(l.rel))?.href || null, JSON.stringify(o));
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
    if (r?.id) saveObject({ id: "refund:" + r.id, applied: true });
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
    if (a.order_id) {
      const o = order(a.order_id);
      const refunded = Number(o.refunded) + Number(a.amount || remaining);
      const status = refunded >= o.amount ? "REFUNDED" : "COMPLETED";
      db.prepare("UPDATE orders SET refunded=?,status=? WHERE id=?").run(refunded, status, o.id);
      db.prepare("UPDATE payments SET refunded=?,status=? WHERE order_id=?").run(refunded, refunded >= o.amount ? "REFUNDED" : "PARTIALLY_REFUNDED", o.id);
      event(o.id, "PAYMENT.REFUNDED", { capture_id: a.capture_id, amount: Number(r.amount?.value), refund_id: r.id });
      return [{ ...order(o.id), kind: "payment", remaining_refundable: o.amount - refunded }];
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
    await paypal.sendInvoice(i.paypal_id, { send_to_recipient: true, subject: `Invoice from ${process.env.MERCHANT_NAME || "Ledgerly"}`,
      note: `Pay securely with PayPal: ${payLinkFor(i)}` });
    status = "SENT";
  } else if (name === "remind_invoice") {
    if (!unpaid(i)) throw Error("Send the invoice before reminding");
    await paypal.remindInvoice(i.paypal_id, {
      subject: a.subject || "Payment reminder",
      note: `${a.message || "A friendly reminder about your invoice."}\n\nPay securely with PayPal: ${payLinkFor(i)}`.slice(0, 4000),
      send_to_recipient: true,
    });
    recordReminder(i.id, a.tone);
    event(i.id, "COLLECTIONS.REMINDED", {tone:a.tone || "friendly", message:a.message, pay_link: payLinkFor(i), by: a.by || "human"});
  } else if (name === "cancel_invoice") {
    if (!["DRAFT", "SENT", "PARTIALLY_PAID"].includes(i.status))
      throw Error("This invoice cannot be cancelled");
    await paypal.cancelInvoice(i.paypal_id);
    status = "CANCELLED";
  } else if (name === "record_payment") {
    if (i.status === "DRAFT")
      throw Error(`Invoice ${i.id} is still a draft. Send the invoice first, then record the payment.`);
    if (!["SENT", "PARTIALLY_PAID"].includes(i.status))
      throw Error(`Invoice ${i.id} is ${i.status}; payments can only be recorded on sent, unpaid invoices.`);
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
  if (mock && type === "CHECKOUT.ORDER.APPROVED" && object(id)?.status === "CREATED") saveObject({ ...object(id), status: "APPROVED" });
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
const capturing = new Map<string, Promise<any>>();
export async function captureApproved(id: string) {
  if (capturing.has(id)) return capturing.get(id);
  const work = (async () => {
    const o = order(id);
    if (o?.capture_id) return;
    let remote = await paypal.getOrder(id);
    // Milestone holds (intent=AUTHORIZE) are authorized and captured per milestone by the finance module, never auto-captured here.
    if (remote.intent === "AUTHORIZE") return;
    if (!o) {
      const unit = remote.purchase_units[0];
      db.prepare("INSERT OR IGNORE INTO orders(id,description,amount,currency,status,data) VALUES (?,?,?,?,?,?)").run(id, unit.description || "Payment", Number(unit.amount.value), unit.amount.currency_code, remote.status, JSON.stringify(remote));
    }
    db.prepare("UPDATE orders SET status='APPROVED' WHERE id=? AND capture_id IS NULL").run(id);
    if (remote.status !== "COMPLETED") remote = await paypal.captureOrder(id);
    const c = remote.purchase_units?.flatMap((u: any) => u.payments?.captures || [])[0];
    if (!c?.id) throw Error("Capture response missing capture id");
    saveObject({ ...c, order_id: id });
    saveObject(remote);
    db.transaction(() => {
      db.prepare("UPDATE orders SET capture_id=?,data=? WHERE id=?").run(c.id, JSON.stringify(remote), id);
      db.prepare("INSERT OR IGNORE INTO payments(id,order_id,amount,currency,status) VALUES (?,?,?,?,?)").run(c.id, id, Number(c.amount.value), c.amount.currency_code, "CAPTURED");
    })();
    event(id, "PAYMENT.CAPTURED", { capture_id: c.id });
    const linked = order(id)?.invoice_id;
    if (linked) await settleInvoiceCapture(linked, c, "pay page capture");
    if (mock) await webhook({ id: "WH-COMPLETED-" + c.id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { ...c, supplementary_data: { related_ids: { order_id: id } } } });
  })();
  capturing.set(id, work);
  try { await work; } finally { capturing.delete(id); }
}
export async function webhook(e: any) {
  if (!e.id || !e.event_type || !e.resource) throw Error("Invalid webhook");
  const duplicate = db.prepare("SELECT id FROM events WHERE id=?").get(e.id);
  if (duplicate) {
    if (e.event_type === "CHECKOUT.ORDER.APPROVED") await captureApproved(e.resource.id);
    return;
  }
  if (retainerWebhook(e)) return;
  const r = e.resource;
  // Captures/refunds that belong to a pay-page invoice are applied idempotently to that invoice.
  if (e.event_type.startsWith("PAYMENT.CAPTURE.")) {
    const linked = invoiceForCapture(r);
    if (linked) {
      const fresh = db.prepare("INSERT OR IGNORE INTO events (id,invoice_id,event_type,data) VALUES (?,?,?,?)").run(e.id, linked, e.event_type, JSON.stringify(e));
      if (!fresh.changes) return;
      if (e.event_type === "PAYMENT.CAPTURE.COMPLETED") await settleInvoiceCapture(linked, r, "webhook");
      if (e.event_type === "PAYMENT.CAPTURE.DENIED") {
        db.prepare("UPDATE invoices SET status='SENT' WHERE id=? AND status IN ('PAYMENT_PENDING','SENT')").run(linked);
        event(linked, "PAYMENT.DENIED", { capture_id: r.id, reason: r.status_details?.reason });
      }
      if (e.event_type === "PAYMENT.CAPTURE.REFUNDED" && !object("refund:" + r.id)) {
        saveObject({ id: "refund:" + r.id, applied: true });
        const i = invoice(linked);
        const refunded = Math.round((Number(i.refunded || 0) + Number(r.amount?.value || 0)) * 100) / 100;
        const status = refunded + 0.001 >= (Number(i.paid_amount) || i.amount) ? "REFUNDED" : "PARTIALLY_REFUNDED";
        db.prepare("UPDATE invoices SET refunded=?,status=? WHERE id=?").run(refunded, status, linked);
        event(linked, "REFUND.CONFIRMED_BY_PAYPAL", { refund_id: r.id, amount: Number(r.amount?.value || 0) });
      }
      for (const fn of listeners) fn({ ...e, invoice_id: linked });
      return;
    }
  }
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
    const current = invoice(id);
    let next: string | undefined = status;
    // Never downgrade a locally tracked refund state; a partial refund stays partial.
    if (current && status === "PAID" && ["PARTIALLY_REFUNDED", "REFUNDED"].includes(current.status)) next = undefined;
    if (current && status === "REFUNDED" && Number(current.refunded || 0) > 0 && Number(current.refunded) + 0.001 < (Number(current.paid_amount) || current.amount)) next = "PARTIALLY_REFUNDED";
    if (next)
      db.prepare("UPDATE invoices SET status=? WHERE id=? OR paypal_id=?").run(
        next,
        id,
        id,
      );
  })();
  if (e.event_type === "PAYMENT.CAPTURE.COMPLETED" && order(id)) {
    saveObject({ ...r, order_id: id, refunded: object(r.id)?.refunded || 0 });
    db.prepare("UPDATE orders SET status=CASE WHEN refunded>=amount THEN 'REFUNDED' ELSE 'COMPLETED' END,capture_id=? WHERE id=?").run(r.id, id);
    const o = order(id);
    db.prepare("INSERT INTO payments(id,order_id,amount,currency,status) VALUES (?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET status=CASE WHEN payments.refunded>0 THEN payments.status ELSE 'PAID' END").run(r.id, id, o.amount, o.currency, "PAID");
  }
  if (e.event_type === "CHECKOUT.ORDER.APPROVED") await captureApproved(r.id);
  if (status === "PAID" && !["PARTIALLY_REFUNDED", "REFUNDED"].includes(invoice(id)?.status)) {
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
  if (status && !order(id) && object(id)) saveObject({ ...object(id), status });
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
      note: [a.note, `Pay online with PayPal: ${payLink(generated.invoice_number)}`].filter(Boolean).join("\n\n"),
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
