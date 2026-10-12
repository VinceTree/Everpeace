import { appendFileSync, readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, InitializeRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const [mode, logPath] = process.argv.slice(2);
if (!logPath || !["disconnect", "initialize_timeout"].includes(mode ?? "")) {
  throw new Error("Expected a recovery mode and fixture log path");
}

interface RecordedStart { event: string; pid: number }
let previous: RecordedStart[] = [];
try {
  previous = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedStart).filter((entry) => entry.event === "started");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const generation = previous.length + 1;
function record(event: string, fields: Record<string, unknown> = {}): void {
  appendFileSync(logPath!, `${JSON.stringify({ event, pid: process.pid, generation, at: Date.now(), ...fields })}\n`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

record("started", { previous_alive: previous.some((entry) => alive(entry.pid)) });
// Keep a stalled initialize alive after stdin EOF, but never leave an unbounded
// fixture process behind if the runtime or its test fails to close it.
setTimeout(() => { record("watchdog_exit"); process.exit(29); }, 15_000);
process.stdin.once("end", () => {
  record("stdin_end");
  const finish = () => { record("exiting"); process.exit(0); };
  if (mode === "initialize_timeout" && generation === 1) setTimeout(finish, 1_250);
  else finish();
});

const server = new Server({ name: "stdio-recovery-fixture", version: "1" }, { capabilities: { tools: {} } });
if (mode === "initialize_timeout" && generation === 1) {
  server.setRequestHandler(InitializeRequestSchema, async () => {
    record("initialize_stalled");
    return new Promise<never>(() => undefined);
  });
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "disconnect", inputSchema: { type: "object" } },
  { name: "ping", inputSchema: { type: "object" } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  record("call", { name: request.params.name, arguments: request.params.arguments });
  if (request.params.name === "disconnect") {
    record("interrupted_exit");
    process.exit(23);
  }
  return { content: [{ type: "text", text: `pong from generation ${generation}` }] };
});
await server.connect(new StdioServerTransport());
