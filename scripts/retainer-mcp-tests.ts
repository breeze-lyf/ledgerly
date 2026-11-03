// Mock-mode tests: PayPal Subscriptions retainers (confirm gate, webhooks, idempotency) and the Ledgerly MCP server.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { action, confirmAction, webhook } from "../server/service.js";
import { db } from "../server/db.js";
import { retainer, retainers, simulatedRetainerEvent } from "../server/subscriptions.js";
import { chat } from "../server/agent/index.js";
import { execute, paypalTools } from "../server/agent/toolkit.js";
import { createMcpServer, mcpToolNames, MCP_SESSION } from "../server/mcp.js";

// 1. Creating a retainer is only a proposal until a human confirms.
const [p] = await action("create_retainer", { client_name: "Acme Retainer", client_email: "ap@acme.test", amount: 800, months: 3 }, false, "r");
assert.equal(p.kind, "pending_action");
assert.equal(p.label, "Confirm retainer subscription");
assert.equal(retainers().length, 0);
const [r] = await confirmAction(p.id, "r");
assert.equal(r.kind, "retainer");
assert.equal(r.status, "APPROVAL_PENDING");
assert.match(r.approve_url, /retainer=RET-/);
assert.ok(r.product_id && r.plan_id && r.subscription_id);
await assert.rejects(confirmAction(p.id, "r"), /no longer pending/);
await assert.rejects(action("create_retainer", { client_name: "X", amount: 10, months: 0 }, false, "r"), /Months/);
await assert.rejects(action("create_retainer", { client_name: "", amount: 10, months: 2 }, false, "r"), /client/);
// 2. Subscription webhooks move state once per event id.
const act = simulatedRetainerEvent("BILLING.SUBSCRIPTION.ACTIVATED", r.id);
await webhook(act); await webhook(act);
assert.equal(retainer(r.id).status, "ACTIVE");
const sale = simulatedRetainerEvent("PAYMENT.SALE.COMPLETED", r.id);
await webhook(sale); await webhook(sale);
await webhook(simulatedRetainerEvent("PAYMENT.SALE.COMPLETED", r.id));
assert.equal(retainer(r.id).cycles_paid, 2);
assert.equal(retainer(r.id).collected, 1600);
await webhook(simulatedRetainerEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", r.id));
assert.equal(retainer(r.id).failed_payments, 1);
const evts = db.prepare("SELECT event_type FROM events WHERE invoice_id=?").all(r.id).map((e: any) => e.event_type);
assert.equal(evts.filter((t) => t === "RETAINER.PAYMENT_RECEIVED").length, 2);
assert.ok(evts.includes("RETAINER.PAYMENT_FAILED"));
// Unknown subscriptions are acknowledged without touching invoices.
await webhook({ id: "WH-unknown", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: "I-NOPE" } });
// 3. Cancelling is also confirm-gated.
const [c] = await action("cancel_retainer", { client: "acme retainer" }, false, "r");
assert.equal(c.kind, "pending_action");
assert.equal(retainer(r.id).status, "ACTIVE");
await confirmAction(c.id, "r");
assert.equal(retainer(r.id).status, "CANCELLED");
// 4. Chat: ambiguous recurring billing offers a choice; explicit retainer proposes a subscription.
const choice = await chat("Bill Nimbus Kite $800/month for 3 months", "c");
assert.equal(choice.cards[0].kind, "recurring_choice");
assert.equal(choice.cards[0].args.months, 3);
const sub = await chat("Set up a retainer for Nimbus Kite $800/month for 3 months as a PayPal subscription", "c");
assert.equal(sub.cards[0].kind, "pending_action");
assert.equal(sub.cards[0].name, "create_retainer");
assert.equal(retainers().length, 1);
// 5. Read-only Agent Toolkit groups (disputes, transactions, subscriptions) are exposed to the agent.
const names = paypalTools.map((t: any) => t.function.name);
for (const n of ["list_disputes", "get_dispute", "list_transactions", "show_subscription_details"]) assert.ok(names.includes(n), n);
assert.equal(names.length, 17);
const [d] = await execute("list_disputes", {}, "c");
assert.equal(d.kind, "toolkit_result");
// 6. MCP server: tools listed, reads work, proposals never execute.
const server = createMcpServer();
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: "test", version: "1" });
await client.connect(ct);
const listed = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(listed, [...mcpToolNames].sort());
assert.equal(listed.length, 15);
const cf = JSON.parse((await client.callTool({ name: "cashflow", arguments: {} }) as any).content[0].text);
assert.ok(Array.isArray(cf.by_currency));
const before = retainers().length;
const prop = JSON.parse((await client.callTool({ name: "propose_retainer", arguments: { client_name: "MCP Co", amount: 500, months: 2 } }) as any).content[0].text);
assert.equal(prop.needs_human_confirmation, true);
assert.equal(retainers().length, before);
const pend = JSON.parse((await client.callTool({ name: "list_pending_approvals", arguments: {} }) as any).content[0].text);
assert.equal(pend[0].name, "create_retainer");
const bad = await client.callTool({ name: "get_invoice", arguments: { invoice_id: "nope" } }) as any;
assert.equal(bad.isError, true);
await confirmAction(pend[0].id, MCP_SESSION);
assert.equal(retainers().length, before + 1);
await client.close();
console.log("retainer + mcp tests passed");
