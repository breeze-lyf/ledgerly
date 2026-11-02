import { db, invoice, object } from "./db.js";
import { mock } from "./config.js";
import { action, simulated, webhook } from "./service.js";
import { paypal } from "./paypal/index.js";

/** Mock-only fixtures, idempotent on a nonempty database. */
export async function seed() {
  if (!mock) throw Error("Seeding is only available in PAYPAL_MODE=mock");
  if ((db.prepare("SELECT COUNT(*) AS n FROM invoices").get() as any).n) return;
  const date = (offset: number, months = 0) => {
    const d = new Date();
    // Anchor historical fixtures inside the requested month, even on its first day.
    if (months) { d.setDate(15); d.setMonth(d.getMonth() + months); }
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const fixtures = [
    ["Acme Corp", 2400, "PAID", 7, 0],
    ["Globex Studio", 1850, "PAID", -5, -1],
    ["Initech", 3200, "SENT", 14, 0],
    ["Umbrella Design", 975, "SENT", -18, 0],
    ["Stark Labs", 4800, "DRAFT", 21, 0],
    ["Wayne Media", 1600, "PARTIALLY_REFUNDED", 3, 0],
  ] as const;
  for (const [client, amount, status, due, months] of fixtures) {
    const cards = await action("create_invoice", {
      client_name: client, client_email: `billing@${client.split(" ")[0].toLowerCase()}.example`,
      items: [{ name: "Design and engineering retainer", quantity: 1, unit_amount: amount }],
      invoice_date: date(-10, months), due_in_days: due,
    }, false, "seed");
    const id = cards[0].id;
    const data = JSON.parse(invoice(id).data);
    data.detail.payment_term.due_date = date(due, months);
    await paypal.updateInvoice(id, { ...object(id), detail: data.detail });
    db.prepare("UPDATE invoices SET due_date=?,created_at=?,data=? WHERE id=?")
      .run(date(due, months), date(-10, months) + "T09:00:00Z", JSON.stringify(data), id);
    if (status !== "DRAFT") {
      await action("send_invoice", { invoice_id: id }, true, "seed");
      if (status === "PAID" || status === "PARTIALLY_REFUNDED") {
        await paypal.recordPayment(id, { amount: { value: String(amount), currency_code: "USD" } });
        await webhook(simulated("INVOICING.INVOICE.PAID", id));
        if (status === "PARTIALLY_REFUNDED") {
          const capture_id = JSON.parse(invoice(id).data).capture_id;
          await action("refund", { invoice_id: id, capture_id, amount: 300, currency: "USD" }, true, "seed");
        }
      }
    }
    const paidDate = months ? date(-3, months) : date(0);
    db.prepare("UPDATE events SET created_at=? WHERE invoice_id=? AND event_type='INVOICING.INVOICE.PAID'")
      .run(paidDate + "T10:00:00Z", id);
    db.prepare("UPDATE events SET created_at=? WHERE invoice_id=? AND event_type='INVOICE.CREATED'")
      .run(date(-10, months) + "T09:00:00Z", id);
    db.prepare("UPDATE events SET created_at=? WHERE invoice_id=? AND event_type='SEND_INVOICE'")
      .run(date(-9, months) + "T09:00:00Z", id);
  }
  await action("create_invoice", {
    client_name: "Acme Corp", client_email: "billing@acme.example",
    items: [{ name: "Monthly maintenance", quantity: 1, unit_amount: 800 }],
    recurrence: { count: 3 }, due_in_days: 14,
  }, false, "seed");
  db.prepare("DELETE FROM actions WHERE session_id='seed'").run();
  console.log("Seeded 9 invoices across 6 clients.");
}
