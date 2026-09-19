import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer(
  { name: "everpeace-test", version: "1.0.0" },
  { instructions: "Use ping to verify the test MCP connection." },
);

server.registerTool(
  "ping",
  {
    description: "Return a deterministic MCP test response.",
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => ({ content: [{ type: "text", text: "pong" }] }),
);

await server.connect(new StdioServerTransport());
