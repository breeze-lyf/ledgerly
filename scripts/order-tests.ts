import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { normalizeOrder } from "../server/agent/order-arguments.js";
import { execute, invokePayPal, executionTrace } from "../server/agent/toolkit.js";
import { directPayPal } from "../server/paypal/index.js";
import { webhook } from "../server/service.js";
import { db, orders } from "../server/db.js";

assert.equal(normalizeOrder({ amount: "25", currency: "usd", description: "Logo revision" }).amount, 25);
assert.equal(normalizeOrder({ amount: { value: "25", currency_code: "USD" } }).amount, 25);
const normalized = normalizeOrder({ currencyCode: "USD", items: [{ name: "Logo", quantity: "2", itemCost: "10", taxPercent: "10" }], shippingCost: "4", discount: "1" });
assert.equal(normalized.amount, 25);
assert.equal(normalized.items[0].itemTotal, 20);
assert.equal(normalizeOrder({ items: [{ quantity: "2", itemTotal: "25" }] }).amount, 25);
assert.equal(normalizeOrder({ purchase_units: [{ amount: { value: "25", currency_code: "USD" } }] }).amount, 25);
assert.throws(() => normalizeOrder({ amount: "oops" }), /finite/);
assert.throws(() => normalizeOrder({ amount: -1 }), /Invalid|positive/);

const original = directPayPal.getOrder;
directPayPal.getOrder = async id => ({ id, status: "CREATED" });
const body = { intent: "CAPTURE", purchase_units: [{ description: "Logo revision", amount: { value: "25.00", currency_code: "USD" } }] };
let calls = 0;
const stub = async (call: any) => {
  calls++;
  const a = JSON.parse(call.function.arguments);
  assert.equal(call.function.name, "create_order");
  assert.deepEqual(a.items, [{ name: "Logo revision", quantity: 1, itemCost: 25, itemTotal: 25, taxPercent: 0 }]);
  return { content: JSON.stringify({ id: "STUB-ORDER" }) } as any;
};
assert.equal((await invokePayPal("createOrder", [body], "unit", stub, true)).id, "STUB-ORDER");
assert.equal(calls, 1);
directPayPal.getOrder = original;
const errors: any[] = [];
const log = console.error;
console.error = (...a) => { errors.push(a); };
try {
  const failed = async () => { throw { response: { data: { name: "INVALID_REQUEST", details: [{ issue: "BAD_AMOUNT", field: "/amount", description: "Invalid amount" }], debug_id: "debug-123" }, headers: { Authorization: "SECRET" } }, message: "SECRET" }; };
  const fallback = await invokePayPal("createOrder", [body], "unit", failed, true);
  assert.ok(fallback.id);
  assert.equal(executionTrace.get("unit"), "ours (fallback)");
  assert.ok(JSON.stringify(errors).includes("debug-123"));
  assert.ok(!JSON.stringify(errors).includes("SECRET"));
  const axios = createRequire(import.meta.url)("axios");
  const stripped = async () => {
    try {
      await axios.post("https://api-m.sandbox.paypal.com/v2/checkout/orders", {}, { adapter: async () => {
        throw { response: { data: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AMOUNT_MISMATCH" }], debug_id: "preserved-debug" } }, config: { headers: { Authorization: "SECRET" } } };
      } });
    } catch { throw Error("PayPal rejected the request"); }
    return {} as any;
  };
  await invokePayPal("createOrder", [body], "unit", stripped, true);
  assert.ok(JSON.stringify(errors).includes("preserved-debug"));
  assert.ok(!JSON.stringify(errors).includes("SECRET"));
  const rejected = async () => ({ content: JSON.stringify({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REJECTED" }] }) }) as any;
  assert.ok((await invokePayPal("createOrder", [body], "unit", rejected, true)).id);
} finally { console.error = log; }
const cards = await execute("create_order", { amount: "25", currency: "USD", description: "Logo revision" });
assert.equal(cards[0].purchase_units[0].amount.value, "25.00");
assert.equal(cards[0].purchase_units[0].description, "Logo revision");
const orderId = cards[0].id;
const captureOrder = directPayPal.captureOrder;
const getOrder = directPayPal.getOrder;
let captures = 0;
directPayPal.getOrder = async id => ({ ...(await getOrder.call(directPayPal, id)), status: "APPROVED" });
directPayPal.captureOrder = async id => {
  captures++;
  if (captures === 1) throw Error("Transient capture failure");
  return { id, status: "COMPLETED", purchase_units: [{ amount: { value: "25.00", currency_code: "USD" }, payments: { captures: [{ id: "CAP-RETRY", status: "COMPLETED", amount: { value: "25.00", currency_code: "USD" } }] } }] };
};
const approval = { id: "WH-RETRY", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: orderId } };
await assert.rejects(() => webhook(approval), /Transient/);
await Promise.all([webhook(approval), webhook(approval)]);
assert.equal(captures, 2);
assert.equal(orders().find(o => o.id === orderId).payment.status, "PAID");
assert.equal(orders().find(o => o.id === orderId).capture_id, "CAP-RETRY");
await webhook(approval);
assert.equal(captures, 2);
directPayPal.captureOrder = captureOrder;
directPayPal.getOrder = getOrder;
db.close();
console.log("PASS: LLM order shapes, numeric totals, stubbed toolkit, sanitized errors and client fallback");
