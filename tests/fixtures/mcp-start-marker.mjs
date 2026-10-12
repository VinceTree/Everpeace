import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], `${process.pid}\n`);
await import("./mcp-stdio-server.mjs");
