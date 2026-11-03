// MCP server for the CLIENT's agent (the payer side). Scoped to one project by a client token; it can read the
// quote, negotiate within Ledgerly's coded bounds, accept, and get the PayPal funding link. It cannot move money.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { project, type Project } from "./finance/store.js";
import { acceptTerms, proposeTerms, quote, negotiation } from "./finance/negotiate.js";
import { holdInfo } from "./finance/money.js";

export const clientToolNames = ["get_quote", "propose_terms", "accept_terms", "get_funding_status"];
const text = (v: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
export function createClientMcpServer(p: Project) {
  const s = new McpServer({ name: "ledgerly-client", version: "0.1.0" }, {
    instructions: `You are talking to Ledgerly, the finance agent of a freelancer working on "${p.title}". Get the quote, propose terms (discount %, % of the remaining amount held at PayPal up front, net days). Ledgerly accepts or counters within fixed limits. Accept an offer by its offer_id; then a person at the client must approve the PayPal hold. Ledgerly holds funds via a PayPal authorization; it is not escrow.`,
  });
  const fresh = () => project(p.id)!;
  s.registerTool("get_quote", { description: "Scope, milestones, standard terms and what is negotiable.", annotations: { readOnlyHint: true } }, async () => text(quote(fresh())));
  s.registerTool("propose_terms", { description: "Propose terms. Returns accepted or a counter-offer with reasons and an offer_id.",
    inputSchema: { discount_pct: z.number().min(0).max(100), deposit_pct: z.number().min(0).max(100).describe("% of the remaining amount held at PayPal up front"), net_days: z.number().int().min(0).max(120), note: z.string().optional() } },
    async (a) => text(proposeTerms(fresh(), a)));
  s.registerTool("accept_terms", { description: "Accept the latest offer (yours if accepted, or Ledgerly's counter). Returns the PayPal funding link for a human to approve.", inputSchema: { offer_id: z.string() } },
    async ({ offer_id }) => text(await acceptTerms(fresh(), offer_id)));
  s.registerTool("get_funding_status", { description: "Whether the funds are held yet, and the agreed terms.", annotations: { readOnlyHint: true } },
    async () => { const h = holdInfo(p.id); return text({ hold: h.hold && { status: h.hold.status, amount: h.hold.amount, captured: h.hold.captured }, negotiation: negotiation(p.id) }); });
  return s;
}
