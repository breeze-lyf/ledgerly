import "./config.js";
import express from "express";
import { resolve as pathResolve } from "node:path";
import { readFileSync } from "node:fs";
import { base, mock, llmConfigured } from "./config.js";
import { db, invoice, invoices, object, saveObject } from "./db.js";
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
      cards: await confirmAction(
        req.params.id,
        req.body.session_id || "default",
        req.params.operation === "cancel",
      ),
    });
  }),
);
api.get("/invoices", (_req, res) => res.json(invoices()));
api.get("/invoices/:id", (req, res) => {
  const i = invoice(req.params.id);
  if (!i) return res.status(404).json({ error: "Not found" });
  res.json({
    ...i,
    timeline: db
      .prepare(
        "SELECT * FROM events WHERE invoice_id=? ORDER BY created_at,rowid",
      )
      .all(i.id),
  });
});
for (const name of ["send", "remind", "cancel", "refund"])
  api.post(
    "/invoices/:id/" + name,
    wrap(async (req: any, res: any) =>
      res.json(
        await execute(
          (
            {
              send: "send_invoice",
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
    const verification = await paypal.verifyWebhookSignature({
      auth_algo: req.headers["paypal-auth-algo"],
      cert_url: req.headers["paypal-cert-url"],
      transmission_id: req.headers["paypal-transmission-id"],
      transmission_sig: req.headers["paypal-transmission-sig"],
      transmission_time: req.headers["paypal-transmission-time"],
      webhook_id: process.env.PAYPAL_WEBHOOK_ID,
      webhook_event: req.body,
    });
    if (verification.verification_status !== "SUCCESS")
      return res.status(401).json({ error: "Invalid webhook signature" });
  }
  webhook(req.body);
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
        "PAYMENT.CAPTURE.COMPLETED",
        "PAYMENT.CAPTURE.REFUNDED",
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
        const captured = await paypal.captureOrder(id);
        webhook(
          simulated(
            "PAYMENT.CAPTURE.COMPLETED",
            captured.purchase_units[0].payments.captures[0].id,
          ),
        );
      }
    } else {
      const i = invoice(id);
      if (!i || !["SENT", "PARTIALLY_PAID"].includes(i.status))
        return res
          .status(400)
          .json({ error: "Invoice must be sent and unpaid" });
      webhook(simulated("INVOICING.INVOICE.PAID", id));
    }
    res.json({ ok: true });
  }),
);
app.use(base + "api", api);
app.use(base, express.static(pathResolve("web/dist"), { index: false }));
app.get(base + "*", (_req, res) => {
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
app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
  console.log(`Ledgerly: http://localhost:${process.env.PORT || 3000}${base}`),
);
