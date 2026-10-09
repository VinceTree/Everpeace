import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "offline-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "Isolated MCP pong" }] }));
process.stdin.once("end", () => { void server.close(); });
await server.connect(new StdioServerTransport());
