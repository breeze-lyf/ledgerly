import { randomUUID } from "node:crypto";
import { base, mock } from "../config.js";
import { db, object, saveObject } from "../db.js";
type Body = Record<string, any>;
export interface PayPalClient {
  getAccessToken(): Promise<string>;
  generateInvoiceNumber(): Promise<any>;
  createDraftInvoice(body: Body): Promise<any>;
  getInvoice(id: string): Promise<any>;
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
}
export class SandboxPayPalClient implements PayPalClient {
  private token = "";
  private expires = 0;
  async getAccessToken() {
    if (Date.now() < this.expires) return this.token;
    const r = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
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
    if (!r.ok) throw Error(JSON.stringify(d));
    this.token = d.access_token;
    this.expires = Date.now() + (d.expires_in - 60) * 1000;
    return this.token;
  }
  async request(path: string, method = "GET", body?: Body) {
    const r = await fetch("https://api-m.sandbox.paypal.com" + path, {
      method,
      headers: {
        Authorization: "Bearer " + (await this.getAccessToken()),
        "Content-Type": "application/json",
        "PayPal-Request-Id": randomUUID(),
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
      links: [
        { rel: "self", href: base + "api/invoices/" + id },
        { rel: "payer-view", href: base + "mock-pay/" + id },
      ],
    });
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
  async recordRefund(id: string, _b: Body) {
    return this.update(id, "REFUNDED");
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
}
export const paypal: PayPalClient = mock
  ? new MockPayPalClient()
  : new SandboxPayPalClient();
