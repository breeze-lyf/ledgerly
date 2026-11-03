import { scanCollections, cashflow } from "./collections.js";
import "./config.js";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import { readFileSync } from "node:fs";
import { base, mock, llmConfigured } from "./config.js";
import { db, invoice, invoices, object, saveObject, orders } from "./db.js";
import { paypal } from "./paypal/index.js";
import {
  action,
  confirmAction,
  listeners,
  simulated,
  webhook,
} from "./service.js";
import { toolkitHealth, execute } from "./agent/toolkit.js";
import { chat } from "./agent/index.js";
import { payInfo, createPayOrder, capturePayOrder, syncInvoices, lastSync, payLinkFor } from "./lifecycle.js";
import { retainers, retainer, syncRetainer, retainerWebhook, simulatedRetainerEvent, retainerEventTypes } from "./subscriptions.js";
import { createMcpServer, pendingMcpActions, MCP_SESSION } from "./mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { policy, setPolicy, runAutopilot, activity, outcomes, approvals, approve, scheduleAutopilot } from "./autopilot.js";
if (mock && process.env.SEED_ON_START === "1") {
  const { seed } = await import("./seed.js");
  await seed();
}
const app = express();
app.use(express.json({ limit: "1mb" }));
const api = express.Router();
const wrap = (fn: any) => (req: any, res: any, next: any) =>
  Promise.resolve(fn(req, res)).catch(next);
api.get("/health", (_req, res) =>
  res.json({
    paypalMode: mock ? "mock" : "sandbox",
    llm: llmConfigured,
    basePath: base,
    toolkit: toolkitHealth,
  }),
);
api.get("/collections", (_req, res) => res.json(scanCollections()));
// Client pay page (public): PayPal JS SDK buttons create/capture an Orders v2 order tied to the invoice.
api.get("/pay/:ref", (req, res) => { try { res.json(payInfo(req.params.ref)); } catch (e: any) { res.status(404).json({ error: e.message }); } });
api.post("/pay/:ref/order", wrap(async (req: any, res: any) => res.json(await createPayOrder(req.params.ref))));
api.post("/pay/:ref/capture", wrap(async (req: any, res: any) => res.json(await capturePayOrder(req.params.ref, String(req.body.order_id || "")))));
api.post("/sync", wrap(async (_req: any, res: any) => res.json(await syncInvoices())));
api.get("/sync", (_req, res) => res.json(lastSync()));
// Autopilot collections
api.get("/autopilot", (_req, res) => res.json({ policy: policy(), activity: activity(), approvals: approvals(), outcomes: outcomes() }));
api.post("/autopilot/policy", (req, res) => res.json(setPolicy(req.body || {})));
api.post("/autopilot/run", wrap(async (_req: any, res: any) => res.json(await runAutopilot({ force: true, trigger: "manual" }))));
api.post("/autopilot/approvals/:id", wrap(async (req: any, res: any) => res.json(await approve(req.params.id, req.body.decision === "reject" ? "reject" : "approve"))));
// Retainers (PayPal Subscriptions). Create/cancel are proposed and confirmed through /actions/:id/confirm.
api.get("/retainers", (_req, res) => res.json(retainers()));
api.post("/retainers", wrap(async (req: any, res: any) => res.json(await action("create_retainer", req.body || {}, false, req.body?.session_id || "default"))));
api.post("/retainers/:id/cancel", wrap(async (req: any, res: any) => res.json(await action("cancel_retainer", { retainer_id: req.params.id }, false, req.body?.session_id || "default"))));
api.post("/retainers/:id/sync", wrap(async (req: any, res: any) => res.json(await syncRetainer(req.params.id))));
api.post("/dev/retainer-event", wrap(async (req: any, res: any) => {
  if (!mock) return res.sendStatus(404);
  if (!retainerEventTypes.includes(req.body.event_type) || !retainer(req.body.retainer_id || "")) return res.status(400).json({ error: "Valid event_type and retainer_id required" });
  req.body = simulatedRetainerEvent(req.body.event_type, req.body.retainer_id, req.body.amount);
  await handleWebhook(req, res);
}));
// Actions proposed by external MCP agents, confirmed by a human in the UI.
api.get("/mcp/pending", (_req, res) => res.json({ session_id: MCP_SESSION, actions: pendingMcpActions(), enabled: !!process.env.MCP_TOKEN }));
api.get("/outcomes", (_req, res) => res.json(outcomes()));
scheduleAutopilot();
if (!mock && process.env.SYNC_DISABLED !== "1") {
  const every = Math.max(60000, Number(process.env.SYNC_INTERVAL_MS || 300000));
  const sweep = () => syncInvoices().then((r) => r.changed.length && console.log("PayPal sync:", r.changed.length, "changed")).catch((e) => console.error("sync", e.message));
  setTimeout(sweep, 15000).unref(); setInterval(sweep, every).unref();
}
api.get("/cashflow", (_req, res) => res.json(cashflow()));
api.post("/collections/run", wrap(async (req: any, res: any) => res.json(await execute("run_collections", {}, req.body.session_id || "default"))));
if (process.env.COLLECTIONS_AUTO === "1" || process.env.SEED === "1") {
 const scan = () => console.log("Collections scan:", scanCollections().rows.length, "candidates (no sends)");
 scan(); setInterval(scan, 6*60*60*1000).unref();
}
api.post(
  "/chat",
  wrap(async (req: any, res: any) => {
    if (typeof req.body.message !== "string" || !req.body.message.trim())
      return res.status(400).json({ error: "Message required" });
    res.json(
      await chat(
        req.body.message.slice(0, 8000),
        req.body.session_id || "default",
      ),
    );
  }),
);
api.get("/messages", (req, res) =>
  res.json(
    (
      db
        .prepare(
          "SELECT * FROM messages WHERE session_id=? ORDER BY id LIMIT 200",
        )
        .all(String(req.query.session_id || "default")) as any[]
    ).map((m) => ({ ...m, ...JSON.parse(m.payload || "{}") })),
  ),
);
api.post(
  "/actions/:id/:operation",
  wrap(async (req: any, res: any) => {
    if (!["confirm", "cancel"].includes(req.params.operation))
      throw Error("Invalid action");
    res.json({
      mode: "system",
      cards: await confirmAction(
        req.params.id,
        req.body.session_id || "default",
        req.params.operation === "cancel",
      ),
    });
  }),
);
function purgeLocal(ids: string[]) {
  db.transaction(() => {
    for (const id of ids) {
      const row = invoice(id);
      if (!row) continue;
      db.prepare("DELETE FROM events WHERE invoice_id=?").run(row.id);
      db.prepare("DELETE FROM invoices WHERE id=?").run(row.id);
      db.prepare("DELETE FROM paypal_objects WHERE id IN (?,?)").run(row.id, row.paypal_id);
    }
  })();
}
api.post("/admin/purge-local", (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.sendStatus(404);
  const supplied = Buffer.from(req.get("x-admin-token") || "");
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.sendStatus(403);
  const ids = req.body.ids;
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id: any) => typeof id === "string" && id.length > 0))
    return res.status(400).json({ error: "ids must be an array of up to 500 nonempty strings" });
  purgeLocal(ids);
  res.json({ ok: true });
});
api.post("/invoices", wrap(async (req: any, res: any) => {
  const a = req.body;
  if (typeof a.client_name !== "string" || !a.client_name.trim() || !Array.isArray(a.items) || !a.items.length ||
      !a.items.every((i: any) => typeof i.name === "string" && Number(i.quantity) > 0 && Number(i.unit_amount) > 0))
    return res.status(400).json({ error: "Client and positive invoice items required" });
  for (const date of [a.due_date, a.invoice_date])
    if (date !== undefined && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))))
      return res.status(400).json({ error: "Dates must use YYYY-MM-DD" });
  res.json(await action("create_invoice", a, false, req.body.session_id || "default"));
}));
api.post("/invoices/:id/delete", wrap(async (req: any, res: any) => {
  const row = invoice(req.params.id);
  if (!row) return res.sendStatus(404);
  if (row.status !== "DRAFT") return res.status(409).json({ error: "Only draft invoices can be deleted" });
  const remote = await paypal.getInvoice(row.paypal_id);
  if (remote.status !== "DRAFT") return res.status(409).json({ error: "PayPal invoice is no longer a draft" });
  await paypal.deleteInvoice(row.paypal_id);
  purgeLocal([row.id]);
  res.json({ ok: true });
}));
api.get("/orders", (_req, res) => res.json(orders()));
api.post("/orders/:id/refund", wrap(async (req: any, res: any) => res.json(await action("refund_order", { ...req.body, order_id: req.params.id }, false, req.body.session_id || "default"))));
api.get("/invoices", (_req, res) => res.json(invoices()));
api.get("/invoices/:id", (req, res) => {
  const i = invoice(req.params.id);
  if (!i) return res.status(404).json({ error: "Not found" });
  res.json({
    ...i,
    pay_link: payLinkFor(i),
    timeline: db
      .prepare(
        "SELECT * FROM events WHERE invoice_id=? ORDER BY datetime(created_at),rowid",
      )
      .all(i.id),
  });
});
for (const name of ["send", "remind", "cancel", "refund", "record-payment"])
  api.post(
    "/invoices/:id/" + name,
    wrap(async (req: any, res: any) =>
      res.json(
        await execute(
          (
            {
              send: "send_invoice",
              "record-payment": "record_payment_for_invoice",
              remind: "send_invoice_reminder",
              cancel: "cancel_sent_invoice",
              refund: "record_refund_for_invoice",
            } as Record<string, string>
          )[name],
          {
            ...req.body,
            invoice_id: req.params.id,
          },
          req.body.session_id || "default",
        ),
      ),
    ),
  );
async function handleWebhook(req: any, res: any) {
  if (!mock) {
    let verified = false;
    const headerNames = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
    if (process.env.PAYPAL_WEBHOOK_ID && headerNames.every((h) => req.headers[h])) {
      try {
        const verification = await paypal.verifyWebhookSignature({
          auth_algo: req.headers["paypal-auth-algo"],
          cert_url: req.headers["paypal-cert-url"],
          transmission_id: req.headers["paypal-transmission-id"],
          transmission_sig: req.headers["paypal-transmission-sig"],
          transmission_time: req.headers["paypal-transmission-time"],
          webhook_id: process.env.PAYPAL_WEBHOOK_ID,
          webhook_event: req.body,
        });
        verified = verification.verification_status === "SUCCESS";
      } catch { /* Invalid verification requests fail closed. */ }
    }
    console.log("PayPal webhook verification:", verified ? "SUCCESS" : "FAILURE");
    if (!verified) return res.status(401).json({ error: "Invalid webhook signature" });
  }
  await webhook(req.body);
  res.json({ ok: true });
}
api.post("/webhooks/paypal", wrap(handleWebhook));
api.post(
  "/dev/simulate-webhook",
  wrap(async (req: any, res: any) => {
    if (!mock) return res.sendStatus(404);
    if (
      !req.body.resource_id ||
      ![
        "INVOICING.INVOICE.PAID",
        "INVOICING.INVOICE.CANCELLED",
        "INVOICING.INVOICE.REFUNDED",
        "CHECKOUT.ORDER.APPROVED",
        "PAYMENT.CAPTURE.COMPLETED",
        "PAYMENT.CAPTURE.REFUNDED",
        "PAYMENT.CAPTURE.DENIED",
      ].includes(req.body.event_type)
    )
      return res
        .status(400)
        .json({ error: "Valid event_type and resource_id required" });
    req.body = simulated(
      req.body.event_type,
      req.body.resource_id,
      req.body.amount,
    );
    await handleWebhook(req, res);
  }),
);
api.get("/events", (_req, res) =>
  res.json(
    db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 100").all(),
  ),
);
api.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(": connected\n\n");
  const send = (e: any) => res.write("data: " + JSON.stringify(e) + "\n\n");
  listeners.add(send);
  const timer = setInterval(() => res.write(": heartbeat\n\n"), 20000);
  req.on("close", () => {
    clearInterval(timer);
    listeners.delete(send);
  });
});
api.post(
  "/mock-pay/:id",
  wrap(async (req: any, res: any) => {
    if (!mock) return res.sendStatus(404);
    const id = req.params.id;
    if (id.startsWith("ORDER-")) {
      const o = object(id);
      if (!o) return res.sendStatus(404);
      if (o.status !== "COMPLETED") {
        saveObject({ ...o, status: "APPROVED" });
        await webhook({ id: "WH-APPROVED-" + id, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id, status: "APPROVED" } });
      }
    } else {
      const i = invoice(id);
      if (!i || !["SENT", "PARTIALLY_PAID"].includes(i.status))
        return res
          .status(400)
          .json({ error: "Invoice must be sent and unpaid" });
      await webhook(simulated("INVOICING.INVOICE.PAID", id));
    }
    res.json({ ok: true });
  }),
);
// Remote MCP endpoint (Streamable HTTP, stateless). Disabled unless MCP_TOKEN is set; bearer auth required.
app.post(base + "mcp", wrap(async (req: any, res: any) => {
  const token = process.env.MCP_TOKEN;
  const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(404).json({ error: "MCP endpoint disabled" });
  const a = Buffer.from(given), b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: "Unauthorized" });
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}));
app.all(base + "mcp", (_req, res) => res.status(405).json({ error: "Use POST" }));
app.use(base + "api", api);
app.use(base, express.static(pathResolve("web/dist"), { index: false }));
app.get(base + "*", (req, res) => {
  if (!mock && req.path.startsWith(base + "mock-pay/")) return res.sendStatus(404);
  const html = readFileSync("web/dist/index.html", "utf8").replace(
    "<head>",
    "<head><script>window.__BASE_PATH__=" + JSON.stringify(base) + ";</script>",
  );
  res.type("html").send(html);
});
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err.message);
  res.status(400).json({ error: err.message || "Request failed" });
});
app.listen(Number(process.env.PORT || 3000), process.env.HOST || "0.0.0.0", () =>
  console.log(`Ledgerly: http://localhost:${process.env.PORT || 3000}${base}`),
);
