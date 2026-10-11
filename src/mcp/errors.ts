export class McpPermanentConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpPermanentConnectionError";
  }
}

export class McpTrustRequiredError extends McpPermanentConnectionError {
  constructor() { super("MCP startup requires approval. Use /mcp trust <server> in this workspace."); }
}
