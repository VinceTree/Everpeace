export interface ResponseOutputItem extends Record<string, unknown> {
  type: string;
  id?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
}

export interface AgentResponse {
  end_turn?: boolean;
  status?: string;
  id: string;
  output_text: string;
  output: ResponseOutputItem[];
  usage?: unknown;
  error?: unknown;
  incomplete_details?: unknown;
}

export type ResponseStreamLike = AsyncIterable<Record<string, unknown>>;

export interface ResponseRecoveryState {
  events: readonly Record<string, unknown>[];
  lastEventId?: string;
  responseId?: string;
}

export interface ResponseRecoveryAdapter {
  resume(
    params: Record<string, unknown>,
    state: ResponseRecoveryState,
    options?: ResponsesRequestOptions,
  ): Promise<AgentResponse | ResponseStreamLike>;
}

export interface ResponsesRequestOptions {
  signal?: AbortSignal;
  maxRetries?: number;
  timeout?: number;
  headers?: Record<string, string>;
}

export interface PromptCacheOptions {
  mode: "implicit";
  ttl: "30m";
}

export interface ResponsesClientLike {
  responses: {
    create(
      params: Record<string, unknown>,
      options?: ResponsesRequestOptions,
    ): Promise<AgentResponse>;
    compact?(
      params: Record<string, unknown>,
      options?: ResponsesRequestOptions,
    ): Promise<{
      output: Array<Record<string, unknown>>;
      usage?: unknown;
    }>;
    stream?(
      params: Record<string, unknown>,
      options?: ResponsesRequestOptions,
    ): Promise<ResponseStreamLike> | ResponseStreamLike;
    recovery?: ResponseRecoveryAdapter;
  };
}

