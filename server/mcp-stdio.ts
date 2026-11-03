// stdio entry for MCP clients. stdout carries protocol frames, so route logs to stderr first.
console.log = (...a: any[]) => console.error(...a);
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createMcpServer } = await import("./mcp.js");
await createMcpServer().connect(new StdioServerTransport());
console.error("Ledgerly MCP server ready on stdio");
