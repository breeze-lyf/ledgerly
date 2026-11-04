import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { base, mock, paypalApiBase } from "../config.js";
import { db, object, saveObject } from "../db.js";
type Body = Record<string, any>;
export interface PayPalClient {
  getAccessToken(): Promise<string>;
  generateInvoiceNumber(): Promise<any>;
  createDraftInvoice(body: Body): Promise<any>;
  getInvoice(id: string): Promise<any>;
  deleteInvoice(id: string): Promise<any>;
  updateInvoice(id: string, body: Body): Promise<any>;
  listInvoices(): Promise<any>;
  sendInvoice(id: string, body?: Body): Promise<any>;
  remindInvoice(id: string, body?: Body): Promise<any>;
  cancelInvoice(id: string, body?: Body): Promise<any>;
  recordPayment(id: string, body: Body): Promise<any>;
  recordRefund(id: string, body: Body): Promise<any>;
  createOrder(body: Body): Promise<any>;
  getOrder(id: string): Promise<any>;
  captureOrder(id: string): Promise<any>;
  refundCapture(id: string, body?: Body): Promise<any>;
  getRefund(id: string): Promise<any>;
  getCapture(id: string): Promise<any>;
  verifyWebhookSignature(body: Body): Promise<any>;
  authorizeOrder(id: string): Promise<any>;
  getAuthorization(id: string): Promise<any>;
  captureAuthorization(id: string, body: Body, requestId: string): Promise<any>;
  reauthorizeAuthorization(id: string, body: Body, requestId: string): Promise<any>;
  voidAuthorization(id: string): Promise<any>;
  createPayout(body: Body, requestId: string): Promise<any>;
  getPayout(batchId: string): Promise<any>;
  provideDisputeEvidence(id: string, input: Body, file: Buffer, filename: string): Promise<any>;
}
export class SandboxPayPalClient implements PayPalClient {
  private token = "";
  private expires = 0;
  async getAccessToken() {
    if (Date.now() < this.expires) return this.token;
    const r = await fetch(paypalApiBase + "/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
          ).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const d = (await r.json()) as any;
    if (!r.ok) throw Error(`PayPal authentication failed (${r.status})`);
    this.token = d.access_token;
    this.expires = Date.now() + (d.expires_in - 60) * 1000;
    return this.token;
  }
  async request(path: string, method = "GET", body?: Body, requestId = randomUUID() as string) {
    const r = await fetch(paypalApiBase + path, {
      method,
      headers: {
        Authorization: "Bearer " + (await this.getAccessToken()),
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
        Prefer: "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    const d = t ? JSON.parse(t) : {};
    if (!r.ok) throw Error(`PayPal ${r.status}: ${JSON.stringify(d)}`);
    return d;
  }
  generateInvoiceNumber() {
    return this.request(
      "/v2/invoicing/generate-next-invoice-number",
      "POST",
      {},
    );
  }
  createDraftInvoice(b: Body) {
    return this.request("/v2/invoicing/invoices", "POST", b);
  }
  deleteInvoice(id: string) {
    return this.request("/v2/invoicing/invoices/" + encodeURIComponent(id), "DELETE");
  }
  getInvoice(id: string) {
    return this.request("/v2/invoicing/invoices/" + encodeURIComponent(id));
  }
  updateInvoice(id: string, b: Body) {
    return this.request(
      "/v2/invoicing/invoices/" + encodeURIComponent(id),
      "PUT",
      b,
    );
  }
  listInvoices() {
    return this.request("/v2/invoicing/invoices");
  }
  sendInvoice(id: string, b: Body = {}) {
    return this.request(
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`,
      "POST",
      b,
    );
  }
  remindInvoice(id: string, b: Body = {}) {
    return this.request(
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`,
      "POST",
      b,
    );
  }
  cancelInvoice(id: string, b: Body = {}) {
    return this.request(
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`,
      "POST",
      b,
    );
  }
  recordPayment(id: string, b: Body) {
    return this.request(
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`,
      "POST",
      b,
    );
  }
  recordRefund(id: string, b: Body) {
    return this.request(
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/refunds`,
      "POST",
      b,
    );
  }
  createOrder(b: Body) {
    return this.request("/v2/checkout/orders", "POST", b);
  }
  getOrder(id: string) {
    return this.request("/v2/checkout/orders/" + encodeURIComponent(id));
  }
  captureOrder(id: string) {
    return this.request(
      `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
      "POST",
      {},
      "ledgerly-capture-" + id,
    );
  }
  refundCapture(id: string, b: Body = {}) {
    return this.request(
      `/v2/payments/captures/${encodeURIComponent(id)}/refund`,
      "POST",
      b,
    );
  }
  getCapture(id: string) {
    return this.request("/v2/payments/captures/" + encodeURIComponent(id));
  }
  getRefund(id: string) {
    return this.request("/v2/payments/refunds/" + encodeURIComponent(id));
  }
  verifyWebhookSignature(b: Body) {
    return this.request(
      "/v1/notifications/verify-webhook-signature",
      "POST",
      b,
    );
  }
  authorizeOrder(id: string) {
    return this.request(`/v2/checkout/orders/${encodeURIComponent(id)}/authorize`, "POST", {}, "ledgerly-authorize-" + id);
  }
  getAuthorization(id: string) {
    return this.request("/v2/payments/authorizations/" + encodeURIComponent(id));
  }
  captureAuthorization(id: string, b: Body, requestId: string) {
    return this.request(`/v2/payments/authorizations/${encodeURIComponent(id)}/capture`, "POST", b, requestId);
  }
  reauthorizeAuthorization(id: string, b: Body, requestId: string) {
    return this.request(`/v2/payments/authorizations/${encodeURIComponent(id)}/reauthorize`, "POST", b, requestId);
  }
  voidAuthorization(id: string) {
    return this.request(`/v2/payments/authorizations/${encodeURIComponent(id)}/void`, "POST", undefined, "ledgerly-void-" + id);
  }
  createPayout(b: Body, requestId: string) {
    return this.request("/v1/payments/payouts", "POST", b, requestId);
  }
  getPayout(batchId: string) {
    return this.request("/v1/payments/payouts/" + encodeURIComponent(batchId));
  }
  async provideDisputeEvidence(id: string, input: Body, file: Buffer, filename: string) {
    const fd = new FormData();
    fd.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
    fd.append("file1", new Blob([new Uint8Array(file)], { type: "application/pdf" }), filename);
    const r = await fetch(paypalApiBase + `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, { method: "POST", headers: { Authorization: "Bearer " + (await this.getAccessToken()) }, body: fd });
    const t = await r.text(); const d = t ? JSON.parse(t) : {};
    if (!r.ok) throw Error(`PayPal ${r.status}: ${JSON.stringify(d)}`);
    return d;
  }
}
export class MockPayPalClient implements PayPalClient {
  async getAccessToken() {
    return "mock-token";
  }
  async generateInvoiceNumber() {
    return { invoice_number: "LL-" + Date.now() };
  }
  private get(id: string) {
    const o = object(id);
    if (!o) throw Error("PayPal object not found");
    return o;
  }
  async createDraftInvoice(b: Body) {
    const id = "INV2-" + randomUUID().slice(0, 19).toUpperCase();
    return saveObject({
      ...b,
      id,
      status: "DRAFT",
      amount: { currency_code: b.detail.currency_code, value: b.items.reduce((sum: number, i: any) => sum + Number(i.quantity) * Number(i.unit_amount.value), 0).toFixed(2) },
      links: [
        { rel: "self", href: base + "api/invoices/" + id },
        { rel: "payer-view", href: base + "mock-pay/" + id },
      ],
    });
  }
  async deleteInvoice(id: string) {
    if (this.get(id).status !== "DRAFT") throw Error("Only draft invoices can be deleted");
    db.prepare("DELETE FROM paypal_objects WHERE id=?").run(id);
    return {};
  }
  async getInvoice(id: string) {
    return this.get(id);
  }
  async updateInvoice(id: string, b: Body) {
    return saveObject({ ...b, id });
  }
  async listInvoices() {
    return {
      items: db
        .prepare("SELECT data FROM paypal_objects WHERE id LIKE ?")
        .all("INV2-%")
        .map((r: any) => JSON.parse(r.data)),
    };
  }
  private update(id: string, status: string) {
    return saveObject({ ...this.get(id), status });
  }
  async sendInvoice(id: string) {
    return this.update(id, "SENT");
  }
  async remindInvoice(id: string) {
    return this.get(id);
  }
  async cancelInvoice(id: string) {
    return this.update(id, "CANCELLED");
  }
  async recordPayment(id: string, b: Body) {
    return this.update(
      id,
      Number(b.amount?.value) < Number(this.get(id).amount?.value)
        ? "PARTIALLY_PAID"
        : "PAID",
    );
  }
  async recordRefund(id: string, b: Body) {
    const o = this.get(id);
    const refunded = Number(o.refunds?.refund_amount?.value || 0) + Number(b.amount.value);
    return saveObject({ ...o, status: refunded < Number(o.amount.value) ? "PARTIALLY_REFUNDED" : "REFUNDED",
      refunds: { refund_amount: { ...b.amount, value: refunded.toFixed(2) } } });
  }
  async createOrder(b: Body) {
    const id = "ORDER-" + randomUUID().slice(0, 12);
    return saveObject({
      ...b,
      id,
      status: "CREATED",
      links: [{ rel: "approve", href: base + "mock-pay/" + id }],
    });
  }
  async getOrder(id: string) {
    return this.get(id);
  }
  async captureOrder(id: string) {
    const o = this.get(id);
    if (o.status === "COMPLETED") return o;
    if (o.status !== "APPROVED") throw Error("ORDER_NOT_APPROVED: Approve the order using its PayPal approval link before capturing payment.");
    const capture = {
      id: "CAP-" + randomUUID().slice(0, 12),
      status: "COMPLETED",
      amount: o.purchase_units[0].amount,
    };
    saveObject({ ...capture, order_id: id });
    return saveObject({
      ...o,
      status: "COMPLETED",
      purchase_units: [
        { ...o.purchase_units[0], payments: { captures: [capture] } },
      ],
    });
  }
  async refundCapture(id: string, b: Body = {}) {
    const o = this.get(id);
    return saveObject({
      id: "REF-" + randomUUID().slice(0, 12),
      status: "COMPLETED",
      amount: b.amount || o.amount,
      capture_id: id,
    });
  }
  async getCapture(id: string) {
    return this.get(id);
  }
  async getRefund(id: string) {
    return this.get(id);
  }
  async verifyWebhookSignature() {
    return { verification_status: "SUCCESS" };
  }
  async authorizeOrder(id: string) {
    const o = this.get(id);
    const existing = o.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (existing) return o;
    if (o.intent !== "AUTHORIZE") throw Error("ACTION_DOES_NOT_MATCH_INTENT");
    if (o.status !== "APPROVED") throw Error("ORDER_NOT_APPROVED");
    const auth = saveObject({ id: "AUTH-" + randomUUID().slice(0, 12), status: "CREATED", amount: o.purchase_units[0].amount, captured: 0, create_time: new Date().toISOString(), expiration_time: new Date(Date.now() + 29 * 864e5).toISOString(), reauthorized: false, custom_id: o.purchase_units[0].custom_id });
    return saveObject({ ...o, status: "COMPLETED", purchase_units: [{ ...o.purchase_units[0], payments: { authorizations: [auth] } }] });
  }
  async getAuthorization(id: string) { return this.get(id); }
  async captureAuthorization(id: string, b: Body, requestId: string) {
    const prior = object("mockreq:" + requestId); if (prior) return this.get(prior.capture_id);
    const a = this.get(id);
    if (!["CREATED", "PARTIALLY_CAPTURED"].includes(a.status)) throw Error("PayPal 422: AUTHORIZATION_ALREADY_CAPTURED_OR_VOIDED (" + a.status + ")");
    const value = Number(b.amount?.value ?? a.amount.value);
    if (a.captured + value > Number(a.amount.value) + 0.001) throw Error("PayPal 422: MAX_CAPTURE_AMOUNT_EXCEEDED");
    const cap = saveObject({ id: "CAP-" + randomUUID().slice(0, 12), status: "COMPLETED", amount: { currency_code: a.amount.currency_code, value: value.toFixed(2) }, final_capture: !!b.final_capture, authorization_id: id, invoice_id: b.invoice_id });
    const captured = Math.round((a.captured + value) * 100) / 100;
    saveObject({ ...a, captured, status: b.final_capture || captured + 0.001 >= Number(a.amount.value) ? "CAPTURED" : "PARTIALLY_CAPTURED" });
    saveObject({ id: "mockreq:" + requestId, capture_id: cap.id });
    return cap;
  }
  async reauthorizeAuthorization(id: string, b: Body, requestId: string) {
    const prior = object("mockreq:" + requestId); if (prior) return this.get(prior.auth_id);
    const a = this.get(id);
    const age = (Date.now() - Date.parse(a.create_time)) / 864e5;
    if (a.reauthorized || age < 3 || age > 29) throw Error("PayPal 422: REAUTHORIZATION_TOO_SOON: A reauthorization is only allowed once from Day 4 to Day 29 since the date of the original authorization.");
    const n = saveObject({ id: "AUTH-" + randomUUID().slice(0, 12), status: "CREATED", amount: b.amount, captured: 0, create_time: new Date().toISOString(), expiration_time: a.expiration_time, reauthorized: true, parent: id });
    saveObject({ ...a, reauthorized: true });
    saveObject({ id: "mockreq:" + requestId, auth_id: n.id });
    return n;
  }
  async voidAuthorization(id: string) {
    const a = this.get(id);
    if (a.status === "VOIDED") return {};
    if (a.status === "CAPTURED") throw Error("PayPal 422: AUTHORIZATION_ALREADY_CAPTURED");
    saveObject({ ...a, status: "VOIDED" }); return {};
  }
  async createPayout(b: Body, requestId: string) {
    const prior = object("mockreq:" + requestId); if (prior) return { batch_header: this.get(prior.batch_id).batch_header };
    if (object("payout-sender:" + b.sender_batch_header.sender_batch_id)) throw Error("PayPal 400: SENDER_BATCH_ID_ALREADY_USED");
    const id = "PB-" + randomUUID().slice(0, 10).toUpperCase();
    const batch = saveObject({ id, batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: b.sender_batch_header }, items: b.items.map((i: any) => ({ payout_item_id: "PI-" + randomUUID().slice(0, 8), transaction_status: "PENDING", payout_item: i })) });
    saveObject({ id: "payout-sender:" + b.sender_batch_header.sender_batch_id, batch_id: id });
    saveObject({ id: "mockreq:" + requestId, batch_id: id });
    return { batch_header: batch.batch_header };
  }
  async getPayout(batchId: string) { return this.get(batchId); }
  async provideDisputeEvidence(id: string, input: Body) { return saveObject({ id: "evidence-submitted:" + id, input, links: [{ rel: "self" }] }); }
}
export const directPayPal: PayPalClient = mock
  ? new MockPayPalClient()
  : new SandboxPayPalClient();

type Invocation = (method: keyof PayPalClient, args: any[]) => Promise<any>;
const execution = new AsyncLocalStorage<Invocation>();
export function withPayPalExecution<T>(invoke: Invocation, fn: () => Promise<T>) {
  return execution.run(invoke, fn);
}
export const paypal = new Proxy(directPayPal, {
  get(target, key: keyof PayPalClient) {
    return (...args: any[]) => {
      const invoke = execution.getStore();
      return invoke ? invoke(key, args) : (target[key] as any).apply(target, args);
    };
  },
});
