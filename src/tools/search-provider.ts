import { withPublicResponse } from "../network/public-http.js";
import { UserSettingsStore } from "../storage/user-settings.js";
import { SystemAuthStorage, type AuthStorage } from "../storage/auth-storage.js";
import { randomUUID } from "node:crypto";
import { searchWeb, type SearchProvider, type WebSearchResult, type WebToolOptions } from "./web.js";

interface SearchSettings { version: 1; provider: "html" | "brave"; auth_ref?: string }
function isSettings(value: unknown): value is SearchSettings {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && (record.provider === "html" && record.auth_ref === undefined || record.provider === "brave" && typeof record.auth_ref === "string" && /^web-brave-[a-f0-9-]+$/u.test(record.auth_ref)) && Object.keys(record).every((key) => ["version", "provider", "auth_ref"].includes(key));
}
export class SearchSettingsStore {
  readonly settings: UserSettingsStore<SearchSettings>;
  constructor(readonly auth: AuthStorage = new SystemAuthStorage(), filePath?: string) {
    this.settings = new UserSettingsStore("web.json", isSettings, () => ({ version: 1, provider: "html" }), filePath);
  }
  async status(): Promise<string> { return (await this.settings.read()).provider; }
  async configure(provider: "html" | "brave", key?: string): Promise<void> {
    if (provider === "html") { await this.settings.update(() => ({ version: 1, provider })); return; }
    if (!key?.trim()) throw new Error("A Brave API key is required");
    const auth_ref = `web-brave-${randomUUID()}`;
    await this.auth.set(auth_ref, key.trim());
    try { await this.settings.update(() => ({ version: 1, provider, auth_ref })); }
    catch (error) { await this.auth.delete(auth_ref).catch(() => false); throw error; }
  }
  provider(): SearchProvider {
    return { name: "html", search: async (query, options) => {
      const settings = await this.settings.read();
      // Reading settings per search means a user change applies to existing agents too.
      const { searchProvider: _provider, ...network } = options;
      if (settings.provider === "html") return searchWeb(query, network);
      const key = await this.auth.get(settings.auth_ref!);
      if (!key) throw new Error("Brave search credential is missing; configure /web");
      return braveSearch(query, key, network);
    } };
  }
}

export async function braveSearch(query: string, key: string, options: WebToolOptions & { signal?: AbortSignal } = {}): Promise<WebSearchResult> {
  if (!query.trim() || query.length > 500 || query.trim().split(/\s+/u).length > 75) throw new Error("Brave query exceeds the supported limit");
  const url = new URL("https://api.search.brave.com/res/v1/llm/context");
  for (const [name, value] of Object.entries({ q: query, count: "5", maximum_number_of_urls: "5", maximum_number_of_tokens: "2048", maximum_number_of_snippets: "5", enable_local: "false" })) url.searchParams.set(name, value);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return withPublicResponse(url, { headers: { Accept: "application/json", "X-Subscription-Token": key }, redirect: "manual", signal }, options, async (response) => {
    if (response.status >= 300 && response.status < 400) throw new Error("Brave search redirects are prohibited; configure the final provider endpoint");
    if (!response.ok) throw new Error(response.status === 401 ? "Brave search authentication failed (401)" : response.status === 429 ? "Brave search rate limit exceeded (429)" : `Brave search failed (HTTP ${response.status})`);
    if (!response.body) throw new Error("Brave search returned no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength; if (total > 2_000_000) throw new Error("Brave search response exceeds the size limit");
        chunks.push(value);
      }
    } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Brave search returned invalid JSON"); }
    const entries = (data as { grounding?: { generic?: unknown } } | null)?.grounding?.generic;
    if (!Array.isArray(entries)) throw new Error("Brave search response structure is unrecognized");
    const results: WebSearchResult["results"] = []; const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry.url !== "string" || typeof entry.title !== "string" || !Array.isArray(entry.snippets)) continue;
      let target: URL; try { target = new URL(entry.url); } catch { continue; }
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.href.length > 2048 || seen.has(target.href)) continue;
      seen.add(target.href);
      results.push({ title: entry.title.slice(0, 500), url: target.href, snippet: entry.snippets.filter((snippet: unknown): snippet is string => typeof snippet === "string").join(" ").slice(0, 2000) });
      if (results.length === 5) break;
    }
    if (entries.length && !results.length) throw new Error("Brave search results could not be interpreted");
    return { query, results };
  });
}
