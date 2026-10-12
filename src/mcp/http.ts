import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { validateMcpUrl } from "./launch.js";
import { McpPermanentConnectionError } from "./errors.js";

/** A transport-owned dispatcher: long-lived SSE is closed with the MCP client. */
export function createMcpHttp(rawUrl: string, onPolicyFailure: (error: McpPermanentConnectionError) => void): { fetch: typeof globalThis.fetch; close(): Promise<void> } {
  const endpoint = validateMcpUrl(rawUrl);
  const loopback = endpoint.protocol === "http:";
  const dispatcher = new Agent(loopback ? {
    connect: {
      lookup: (_hostname, options, callback) => {
        // localhost never invokes system DNS. Literal addresses bypass lookup.
        const address = options.family === 6 ? "::1" : "127.0.0.1";
        if (options.all) callback(null, [{ address, family: isIP(address) }]);
        else callback(null, address, isIP(address));
      },
    },
  } : { connect: { rejectUnauthorized: true } });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    try {
      const url = validateMcpUrl(input instanceof Request ? input.url : String(input));
      if (url.href !== endpoint.href) throw new McpPermanentConnectionError("MCP request endpoint changed");
      const response = await undiciFetch(url, { ...init, redirect: "manual", dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new McpPermanentConnectionError("MCP redirects are blocked; configure the final endpoint");
      }
      return response;
    } catch (error) {
      if (error instanceof McpPermanentConnectionError) { onPolicyFailure(error); throw error; }
      // SDK errors may otherwise include credential-bearing URL paths or query strings.
      throw new Error("MCP HTTP request failed");
    }
  };
  return { fetch, async close() { await dispatcher.destroy(); } };
}
