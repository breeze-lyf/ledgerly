// stdio entry for a client's agent (e.g. Claude Desktop). LEDGERLY_CLIENT_TOKEN selects the project.
console.log = (...a: any[]) => console.error(...a);
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { projectForClientToken } = await import("./finance/negotiate.js");
const { createClientMcpServer } = await import("./mcp-client.js");
const p = projectForClientToken(process.env.LEDGERLY_CLIENT_TOKEN || "");
if (!p) { console.error("LEDGERLY_CLIENT_TOKEN does not match a project"); process.exit(1); }
await createClientMcpServer(p).connect(new StdioServerTransport());
console.error("Ledgerly client MCP ready for project " + p.id);
