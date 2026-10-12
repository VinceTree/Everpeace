import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema,
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult, type GetPromptResult, type ListPromptsResult, type ListResourcesResult,
  type ListResourceTemplatesResult, type ListToolsResult, type ReadResourceResult,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

export interface ProtocolFixtureOptions {
  capabilities?: ServerCapabilities;
  listTools?(cursor: string | undefined, signal: AbortSignal): Promise<ListToolsResult>;
  callTool?(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  listResources?(cursor: string | undefined): Promise<ListResourcesResult>;
  listTemplates?(cursor: string | undefined): Promise<ListResourceTemplatesResult>;
  listPrompts?(cursor: string | undefined): Promise<ListPromptsResult>;
  readResource?(uri: string): Promise<ReadResourceResult>;
  getPrompt?(name: string): Promise<GetPromptResult>;
}

/** Real SDK server; handlers deliberately permit invalid advertised tool output. */
export function createProtocolFixture(options: ProtocolFixtureOptions = {}): Server {
  const capabilities = options.capabilities ?? { tools: { listChanged: true } };
  const server = new Server({ name: "protocol-fixture", version: "1" }, { capabilities, instructions: "Fixture instructions remain available without tools." });
  if (capabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, (request, extra) => options.listTools?.(request.params?.cursor, extra.signal) ?? Promise.resolve({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => options.callTool?.(request.params.name, request.params.arguments ?? {}, extra.signal) ?? Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
  }
  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, (request) => options.listResources?.(request.params?.cursor) ?? Promise.resolve({ resources: [] }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => options.listTemplates?.(request.params?.cursor) ?? Promise.resolve({ resourceTemplates: [{ name: "notes", uriTemplate: "fixture://notes/{name}" }] }));
    server.setRequestHandler(ReadResourceRequestSchema, (request) => options.readResource?.(request.params.uri) ?? Promise.resolve({ contents: [{ uri: request.params.uri, text: "你好\r\n  resource" }] }));
  }
  if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, (request) => options.listPrompts?.(request.params?.cursor) ?? Promise.resolve({ prompts: [{ name: "greeting" }] }));
    server.setRequestHandler(GetPromptRequestSchema, (request) => options.getPrompt?.(request.params.name) ?? Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hello" } }] }));
  }
  return server;
}

/** An actual loopback Streamable HTTP endpoint with owned sessions and sockets. */
export async function startHttpProtocolFixture(options: ProtocolFixtureOptions = {}) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const transports = new Set<StreamableHTTPServerTransport>();
  const servers = new Set<Server>();
  const http = createServer((request, response) => {
    void (async () => {
      let body: unknown;
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      const sessionId = request.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!transport && body && typeof body === "object" && "method" in body && body.method === "initialize") {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized(id) { sessions.set(id, created); },
        });
        transport = created;
        transports.add(created);
        const server = createProtocolFixture(options);
        servers.add(server);
        // The SDK transport declares optional callbacks with explicit undefined,
        // unlike its own Transport interface under exactOptionalPropertyTypes.
        await server.connect(created as never);
      }
      if (!transport) {
        response.writeHead(404).end();
        return;
      }
      await transport.handleRequest(request, response, body);
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    servers,
    transports,
    async expireSessions() {
      sessions.clear();
      await Promise.all([...transports].map((transport) => transport.close()));
    },
    async notifyTools() { await Promise.all([...servers].map((server) => server.sendToolListChanged())); },
    async close() {
      await Promise.all([...servers].map((server) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[2] === "--stdio") {
  const mode = process.argv[3] ?? "tools";
  const capabilities: ServerCapabilities = mode === "resources" ? { resources: {} }
    : mode === "prompts" ? { prompts: {} } : mode === "instructions" ? {} : { tools: {} };
  const server = createProtocolFixture({
    capabilities,
    async listTools(cursor) {
      return cursor ? { tools: [{ name: "last", inputSchema: { type: "object" } }] } : {
        tools: [{ name: "first", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
          { name: "task", inputSchema: { type: "object" }, execution: { taskSupport: "required" } }],
        nextCursor: "second",
      };
    },
    async callTool(_name, args) { return { content: [{ type: "text", text: "output" }], structuredContent: { value: args.value ?? 42 } }; },
  });
  await server.connect(new StdioServerTransport());
}
