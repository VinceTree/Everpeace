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

server.registerResource(
  "notes",
  "test://notes",
  { description: "A deterministic test resource.", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: "resource-value", mimeType: "text/plain" }] }),
);

server.registerPrompt(
  "greeting",
  { description: "Build a deterministic greeting prompt." },
  async () => ({ messages: [{ role: "user", content: { type: "text", text: "prompt-value" } }] }),
);

await server.connect(new StdioServerTransport());
