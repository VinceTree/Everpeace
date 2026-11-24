import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { uiText, type UiMessageKey } from "../localization/messages.js";
import { normalizeWorkspacePath } from "../memory/learned-memory.js";
import type { WebPermissionMode } from "../permissions/policy.js";
import { UserSettingsStore } from "../storage/user-settings.js";
import { inputRecord, requestArguments, stringValue, HarnessBridge } from "./harness-bridge.js";
import { pickNativeWorkspace, type DirectoryPicker } from "./harness-directory-picker.js";
import { verifyDesktopPath, type HarnessDesktop } from "./harness-desktop.js";
import { HarnessPreferences, plainRecord } from "./harness-preferences.js";
import { WebRequestError, type WebWorkbench } from "./workbench.js";

interface FolderIdentity {
  path: string;
  identity: string;
}

interface WorkspaceFolder extends FolderIdentity {
  addedAt: string;
  id: string;
  listed: boolean;
}

interface WorkspaceRegistry {
  version: 1;
  folders: WorkspaceFolder[];
}

interface WorkspaceBinding {
  folder: WorkspaceFolder;
  bridge: HarnessBridge;
}

const maxWorkspaces = 64;
const pickerReceiptMs = 5 * 60_000;
const membershipFields = {
  "workspace/archiveSession": "archivedSessionIds",
  "workspace/unarchiveSession": "archivedSessionIds",
  "workspace/pinSession": "pinnedSessionIds",
  "workspace/unpinSession": "pinnedSessionIds",
} as const;
type MembershipEndpoint = keyof typeof membershipFields;
type WorkspaceMessage = Extract<UiMessageKey, `web.workspace.${string}`> extends `web.workspace.${infer Key}` ? Key : never;

function isLocalPath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 4_096 && !path.includes("\0") &&
    isAbsolute(path) && (process.platform !== "win32" || /^[A-Z]:[/\\]/iu.test(path));
}

function workspaceKey(path: string): string {
  return normalizeWorkspacePath(path);
}

function workspaceDigest(path: string): string {
  return createHash("sha256").update(workspaceKey(path)).digest("hex");
}

async function inspectFolder(path: string): Promise<FolderIdentity> {
  if (!isLocalPath(path)) throw new Error("Invalid workspace directory");
  const canonical = await realpath(path);
  const stats = await stat(canonical, { bigint: true });
  if (!isLocalPath(canonical) || !stats.isDirectory()) throw new Error("Invalid workspace directory");
  return { path: canonical, identity: `${stats.dev}:${stats.ino}` };
}

function isRegistry(value: unknown): value is WorkspaceRegistry {
  if (!plainRecord(value) || value.version !== 1 || !Array.isArray(value.folders) || value.folders.length > maxWorkspaces) return false;
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const folder of value.folders) {
    if (!plainRecord(folder) || !isLocalPath(folder.path) || typeof folder.identity !== "string" ||
        !/^\d+:\d+$/u.test(folder.identity) || typeof folder.addedAt !== "string" || !Number.isFinite(Date.parse(folder.addedAt)) ||
        typeof folder.id !== "string" || !/^[\w-]{1,64}$/u.test(folder.id) || typeof folder.listed !== "boolean") return false;
    const key = workspaceKey(folder.path);
    if (keys.has(key) || ids.has(folder.id)) return false;
    keys.add(key);
    ids.add(folder.id);
  }
  return true;
}

/** Each adopted folder keeps its own production workbench. Only the stock protocol's global feeds are combined. */
export class HarnessWorkspaces {
  readonly #registry: UserSettingsStore<WorkspaceRegistry>;
  readonly #listeners = new Set<() => void>();
  readonly #scopes = new Map<string, WorkspaceBinding>();
  readonly #projection = { cursor: -1 };
  readonly #receipts = new WeakMap<AbortSignal, { folder: FolderIdentity; expiresAt: number }>();
  #tail: Promise<unknown> = Promise.resolve();
  #picking = false;
  #working = true;
  #order: string[] = [];
  #launchFolder!: WorkspaceFolder;
  #root!: HarnessBridge;

  constructor(
    private readonly launch: WebWorkbench,
    private readonly preferences = new HarnessPreferences(launch.workspace),
    private readonly pickDirectory: DirectoryPicker = pickNativeWorkspace,
    private readonly desktop?: HarnessDesktop,
  ) {
    const name = `browser-workspaces-${workspaceDigest(launch.workspace)}.json`;
    this.#registry = new UserSettingsStore(name, isRegistry, () => ({ version: 1, folders: [this.#launchFolder] }),
      preferences.directory === undefined ? undefined : join(preferences.directory, name));
  }

  async initialize(): Promise<void> {
    this.#launchFolder = { ...await inspectFolder(this.launch.workspace), addedAt: new Date().toISOString(), id: "everpeace-local", listed: true };
    const registry = await this.#registry.read();
    const rootKey = workspaceKey(this.launch.workspace);
    const savedRoot = registry.folders.find(folder => workspaceKey(folder.path) === rootKey);
    if (savedRoot?.identity === this.#launchFolder.identity) this.#launchFolder = savedRoot;
    this.#root = await this.#bridge(this.launch, this.#launchFolder);
    for (const folder of registry.folders) {
      const key = workspaceKey(folder.path);
      if (key === rootKey) {
        this.#scopes.set(key, await this.#binding(this.#launchFolder));
        continue;
      }
      if (!await this.#stillSameFolder(folder)) continue;
      this.#scopes.set(key, await this.#binding(folder));
    }
    this.#applyOrder(registry);
  }

  async #bridge(workbench: WebWorkbench, folder: WorkspaceFolder): Promise<HarnessBridge> {
    const isRoot = workbench === this.launch;
    const preferences = isRoot ? this.preferences : new HarnessPreferences(folder.path, this.preferences.directory);
    const bridge = new HarnessBridge(workbench, preferences, folder.id, folder.addedAt, this.#projection, () => this.#settingsCap());
    await bridge.initialize();
    return bridge;
  }

  async #binding(folder: WorkspaceFolder): Promise<WorkspaceBinding> {
    if (workspaceKey(folder.path) === workspaceKey(this.launch.workspace)) {
      return { folder, bridge: this.#root };
    }
    const workbench = this.launch.forWorkspace(folder.path, () => this.#verifyFolder(folder));
    try {
      await workbench.initialize(this.launch.defaultModelId ?? undefined);
      return { folder, bridge: await this.#bridge(workbench, folder) };
    } catch (error) {
      await workbench.close();
      throw error;
    }
  }

  async #settingsCap(): Promise<WebPermissionMode> {
    const scopes = [...this.#scopes.values()];
    const caps = scopes.length ? await Promise.all(scopes.map(async scope =>
      await this.#stillSameFolder(scope.folder) ? scope.bridge.workbench.refreshPermissionCap() : "read-only",
    )) : [await this.launch.refreshPermissionCap()];
    return caps.includes("workspace-write") ? "workspace-write" : caps.includes("ask") ? "ask" : "read-only";
  }

  async #stillSameFolder(folder: FolderIdentity): Promise<boolean> {
    try {
      const observed = await inspectFolder(folder.path);
      return workspaceKey(observed.path) === workspaceKey(folder.path) && observed.identity === folder.identity;
    } catch { return false; }
  }

  async #verifyFolder(folder: FolderIdentity): Promise<void> {
    if (!await this.#stillSameFolder(folder)) throw this.#error(409, "workspace/invalid-path", "invalidPath");
  }

  #applyOrder(registry: WorkspaceRegistry): void {
    const ordered = registry.folders.map(folder => workspaceKey(folder.path)).filter(key => this.#scopes.get(key)?.folder.listed);
    const listed = [...this.#scopes].flatMap(([key, scope]) => scope.folder.listed ? [key] : []);
    this.#order = [...new Set([...ordered, ...listed])];
  }

  #listed(): WorkspaceBinding[] {
    return this.#order.flatMap(key => this.#scopes.get(key) ?? []);
  }

  #broadcast(): void {
    for (const listener of this.#listeners) listener();
  }

  #workspaceState() {
    const entries = new Map([...this.#scopes].map(([key, scope]) => [key, scope.bridge.workspaceState()]));
    return {
      items: this.#order.map(key => entries.get(key)!.workspace),
      archivedSessionIds: [...entries.values()].flatMap(entry => entry.archivedSessionIds),
      pinnedSessionIds: [...entries.values()].flatMap(entry => entry.pinnedSessionIds),
    };
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(() => {
      if (!this.#working) throw this.#error(409, "workspace/unavailable", "closing");
      return action();
    });
    this.#tail = next.catch(() => {});
    return next;
  }

  #error(status: number, code: string, message: WorkspaceMessage): WebRequestError {
    return new WebRequestError(status, uiText(`web.workspace.${message}`, {}, this.launch.snapshot().language), code);
  }

  async #pick(signal?: AbortSignal, connection?: AbortSignal): Promise<string | null> {
    if (!connection || connection.aborted || this.#picking) throw this.#error(409, "directory-picker/unavailable", "pickerBusy");
    const lifetime = AbortSignal.any([connection, AbortSignal.timeout(pickerReceiptMs), ...(signal ? [signal] : [])]);
    this.#picking = true;
    this.#receipts.delete(connection);
    try {
      const selected = await this.pickDirectory(uiText("web.workspace.pickTitle", {}, this.launch.snapshot().language), lifetime);
      lifetime.throwIfAborted();
      if (selected === null) return null;
      const folder = await inspectFolder(selected);
      lifetime.throwIfAborted();
      this.#receipts.set(connection, { folder, expiresAt: Date.now() + pickerReceiptMs });
      return folder.path;
    } catch {
      throw this.#error(400, "directory-picker/unavailable", "pickerFailed");
    } finally { this.#picking = false; }
  }

  async #create(path: string, signal?: AbortSignal, connection?: AbortSignal) {
    if (!isLocalPath(path)) throw this.#error(400, "workspace/invalid-path", "invalidPath");
    return this.#serialize(async () => {
      const key = workspaceKey(path);
      const existing = this.#scopes.get(key);
      if (existing?.folder.listed) return { workspace: existing.bridge.workspaceState().workspace, created: false };
      const isLaunch = key === workspaceKey(this.launch.workspace);
      const receipt = !isLaunch && connection && !connection.aborted ? this.#receipts.get(connection) : undefined;
      if (!isLaunch &&
          (!receipt || receipt.expiresAt < Date.now() || workspaceKey(receipt.folder.path) !== key)) {
        throw this.#error(403, "workspace/invalid-path", "selectFirst");
      }
      const selected = isLaunch ? this.#launchFolder : receipt!.folder;
      if (existing && selected.identity !== existing.folder.identity || !await this.#stillSameFolder(selected)) {
        throw this.#error(409, "workspace/invalid-path", "invalidPath");
      }
      const folder = { ...selected, id: randomUUID(), addedAt: new Date().toISOString(), listed: true };
      signal?.throwIfAborted();
      const binding = existing ?? await this.#binding(folder);
      try {
        signal?.throwIfAborted();
        const registry = await this.#registry.update(current => {
          signal?.throwIfAborted();
          if (receipt && connection && (connection.aborted || this.#receipts.get(connection) !== receipt || receipt.expiresAt < Date.now())) {
            throw this.#error(403, "workspace/invalid-path", "selectFirst");
          }
          const others = current.folders.filter(entry => workspaceKey(entry.path) !== key);
          if (others.length >= maxWorkspaces) throw this.#error(409, "workspace/unavailable", "limit");
          return { ...current, folders: [...others, folder] };
        });
        binding.folder = folder;
        binding.bridge.workspaceId = folder.id;
        binding.bridge.registeredAt = folder.addedAt;
        this.#scopes.set(key, binding);
        if (receipt && connection && this.#receipts.get(connection) === receipt) this.#receipts.delete(connection);
        this.#applyOrder(registry);
      } catch (error) {
        if (!existing && binding.bridge !== this.#root) await binding.bridge.workbench.close();
        throw error;
      }
      this.#broadcast();
      return { workspace: binding.bridge.workspaceState().workspace, created: true };
    });
  }

  #byId(id: unknown): WorkspaceBinding {
    const scope = this.#listed().find(item => item.bridge.workspaceId === id);
    if (!scope) throw this.#error(404, "workspace/not-found", "unavailable");
    return scope;
  }

  #bySession(id: unknown): WorkspaceBinding {
    const scope = typeof id === "string" ? [...this.#scopes.values()].find(item => item.bridge.workbench.hasSession(id)) : undefined;
    if (!scope) throw new WebRequestError(404, "Session is unavailable in this workspace", "session/not-found");
    return scope;
  }

  async #delete(id: unknown) {
    return this.#serialize(async () => {
      const scope = this.#byId(id);
      const key = workspaceKey(scope.folder.path);
      const folder = { ...scope.folder, listed: false };
      const registry = await this.#registry.update(current => ({
        ...current, folders: [...current.folders.filter(entry => workspaceKey(entry.path) !== key), folder],
      }));
      scope.folder = folder;
      this.#applyOrder(registry);
      this.#broadcast();
      return { deleted: true };
    });
  }

  async #move(id: unknown, beforeId: unknown) {
    return this.#serialize(async () => {
      const source = this.#byId(id);
      const anchor = beforeId === undefined ? undefined : this.#byId(beforeId);
      if (source !== anchor) {
        const sourceKey = workspaceKey(source.folder.path);
        const anchorKey = anchor && workspaceKey(anchor.folder.path);
        const registry = await this.#registry.update(current => {
          const folders = current.folders.filter(folder => workspaceKey(folder.path) !== sourceKey);
          const index = anchorKey === undefined ? -1 : folders.findIndex(folder => workspaceKey(folder.path) === anchorKey);
          folders.splice(index < 0 ? folders.length : index, 0, source.folder);
          return { ...current, folders };
        });
        this.#applyOrder(registry);
        this.#broadcast();
      }
      return { workspaceIds: this.#listed().map(scope => scope.bridge.workspaceId) };
    });
  }

  #scope(endpoint: string, args: Record<string, unknown>): WorkspaceBinding | undefined {
    if (endpoint === "session/create") {
      const scope = args.workspaceId !== undefined ? this.#byId(args.workspaceId)
        : typeof args.cwd === "string" ? this.#scopes.get(workspaceKey(args.cwd))
          : args.sessionId !== undefined ? this.#bySession(args.sessionId) : this.#listed()[0];
      if (!scope || args.cwd !== undefined && (!isLocalPath(args.cwd) || workspaceKey(args.cwd) !== workspaceKey(scope.folder.path))) {
        throw this.#error(404, "workspace/not-found", "unavailable");
      }
      return scope;
    }
    if (args.workspaceId !== undefined) return this.#byId(args.workspaceId);
    const session = args.sessionId ?? args.agentId ?? args.workspaceFileScopeId ??
      (plainRecord(args.address) ? args.address.sessionId : undefined);
    return session === undefined ? undefined : this.#bySession(session);
  }

  #scopeArgs(endpoint: string, payload: unknown): Record<string, unknown> {
    if (endpoint.startsWith("workspaceFiles/") || endpoint === "fileUploads/upload") return inputRecord(inputRecord(payload).args);
    if (endpoint.startsWith("goals/")) {
      const { args } = inputRecord(payload);
      return inputRecord(Array.isArray(args) ? args[0] : args);
    }
    return requestArguments(payload);
  }

  async uploadFile(params: URLSearchParams, bytes: Uint8Array, signal?: AbortSignal) {
    const scope = this.#bySession(params.get("sessionId"));
    await this.#verifyFolder(scope.folder);
    return scope.bridge.uploadFile(params, bytes, signal);
  }

  async openDirectory(app: string, target: string, signal: AbortSignal) {
    const scope = isLocalPath(target) ? this.#scopes.get(workspaceKey(target)) : undefined;
    if (!scope) throw this.#error(404, "workspace/not-found", "unavailable");
    if (!this.desktop?.available) throw this.#desktopError(404, "unavailable");
    const result = await this.desktop.openDirectory(app, async () => {
      await this.#verifyFolder(scope.folder);
      return scope.folder.path;
    }, signal);
    if (result !== "launched") throw this.#desktopError(result === "failed" ? 502 : 400, result === "failed" ? "failed" : "unavailable");
    return { ok: true };
  }

  #desktopError(status: number, key: "target" | "unavailable" | "failed") {
    return new WebRequestError(status, uiText(`web.desktop.${key}`, {}, this.launch.snapshot().language),
      status === 502 ? "gateway/internal" : "gateway/bad-request");
  }

  async #desktopFile(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const desktop = this.desktop;
    if (!desktop?.available) {
      if (endpoint === "session/workspacePathApplications") return [];
      throw this.#desktopError(404, "unavailable");
    }
    const target = stringValue(args, "path");
    if (!isLocalPath(target)) throw this.#desktopError(400, "target");
    const normalized = workspaceKey(resolve(target));
    const scope = [...this.#scopes.values()]
      .filter(({ folder }) => {
        const key = workspaceKey(folder.path);
        return key === normalized || normalized.startsWith(key.endsWith(sep) ? key : key + sep);
      })
      .sort((a, b) => b.folder.path.length - a.folder.path.length)[0];
    if (!scope) throw this.#desktopError(403, "target");
    await this.#verifyFolder(scope.folder);
    const { action, application } = args;
    if (action !== undefined && action !== "reveal" || application !== undefined &&
      (typeof application !== "string" || !application || application.length > 4096 || application.includes("\0"))) {
      throw this.#desktopError(400, "target");
    }
    const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const path = await verifyDesktopPath(scope.folder.path, target, endpoint === "session/openWorkspacePath" && action !== "reveal",
      this.launch.snapshot().language, lifetime);
    await this.#verifyFolder(scope.folder);
    try {
      if (endpoint === "session/workspacePathApplications") return await desktop.applications(path, lifetime);
      await desktop.openFile(path, action === "reveal" ? "reveal" : "open", application, lifetime);
      return { opened: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      throw this.#desktopError(502, "failed");
    }
  }

  async call(endpoint: string, payload: unknown, signal?: AbortSignal, connection?: AbortSignal): Promise<unknown> {
    if (endpoint === "settings/mutate") return this.#root.call(endpoint, payload, signal, connection);
    const args = this.#scopeArgs(endpoint, payload);
    switch (endpoint) {
      case "session/canOpenWorkspacePath": return this.desktop?.available ?? false;
      case "session/workspacePathApplications":
      case "session/openWorkspacePath": return this.#desktopFile(endpoint, args, signal);
      case "directoryPicker/pick": return this.#pick(signal, connection);
      case "workspace/initializeDefault": return undefined;
      case "workspace/create": return this.#create(stringValue(args, "path"), signal, connection);
      case "workspace/delete": return this.#delete(args.workspaceId);
      case "workspace/insertBefore": return this.#move(args.workspaceId, args.beforeWorkspaceId);
      case "workspace/rename":
      case "workspace/insertSessionBefore": return this.#serialize(async () => {
        const scope = this.#byId(args.workspaceId);
        await this.#verifyFolder(scope.folder);
        return scope.bridge.call(endpoint, payload, signal, connection);
      });
      case "session/list": return { items: [...this.#scopes.values()].flatMap(scope => scope.bridge.sessionSummaries()) };
      case "session/search": {
        const query = stringValue(args, "query");
        const searches = await Promise.all([...this.#scopes.values()].map(scope => scope.bridge.workbench.searchSessions(query, signal)));
        const items = searches.flatMap(result => result.items);
        return { items: items.slice(0, 20), hasMore: items.length > 20 || searches.some(result => result.hasMore) };
      }
      case "$events/result": {
        const id = stringValue(args, "eventId");
        const scope = [...this.#scopes.values()].find(item => item.bridge.hasPendingEvent(id));
        if (!scope) throw new WebRequestError(409, "This request is no longer pending");
        await this.#verifyFolder(scope.folder);
        return scope.bridge.call(endpoint, payload, signal, connection);
      }
    }
    const scope = this.#scope(endpoint, args);
    if (!scope) return this.#root.call(endpoint, payload, signal, connection);
    if (endpoint !== "session/cancel") await this.#verifyFolder(scope.folder);
    const result = await scope.bridge.call(endpoint, payload, signal, connection);
    if (Object.hasOwn(membershipFields, endpoint)) {
      const field = membershipFields[endpoint as MembershipEndpoint];
      return { [field]: this.#workspaceState()[field] };
    }
    return result;
  }

  #observeBindings(
    attach: (scope: WorkspaceBinding, initial: boolean) => () => void,
  ): () => void {
    const attached = new Map<WorkspaceBinding, () => void>();
    const synchronize = (initial = false) => {
      for (const scope of this.#scopes.values()) if (!attached.has(scope)) attached.set(scope, attach(scope, initial));
    };
    const onChange = () => synchronize();
    synchronize(true);
    this.#listeners.add(onChange);
    return () => {
      this.#listeners.delete(onChange);
      for (const dispose of attached.values()) dispose();
    };
  }

  async subscribe(endpoint: string, payload: unknown, write: (frame: unknown) => void, signal: AbortSignal, finish: () => void): Promise<() => void> {
    if (endpoint === "$events") {
      const clientId = randomUUID();
      write({ type: "ready", clientId, host: { home: homedir() } });
      const settingsChanged = () => write({ type: "emit", event: "settings/document-updated", args: [] });
      const capChanged = () => {
        write({ type: "emit", event: "permission-presets/catalog-changed", args: [] });
        settingsChanged();
      };
      const stopSettings = this.#root.watchSettings(settingsChanged);
      const stopScopes = this.#observeBindings((scope, initial) => {
        const stop = scope.bridge.watchEvents(clientId, signal, write, !initial);
        if (!initial) capChanged();
        return stop;
      });
      return () => { stopScopes(); stopSettings(); };
    }
    if (endpoint === "workspace/follow") {
      const initial = this.#workspaceState();
      let fingerprint = JSON.stringify(initial);
      write({ type: "baseline", value: initial });
      const publish = () => {
        const value = this.#workspaceState();
        const next = JSON.stringify(value);
        if (next === fingerprint) return;
        fingerprint = next;
        write({ type: "replace", value });
      };
      const stop = this.#observeBindings(scope => scope.bridge.watchWorkspace(publish));
      this.#listeners.add(publish);
      return () => { this.#listeners.delete(publish); stop(); };
    }
    if (endpoint === "session/control") {
      const projections = Object.assign({}, ...[...this.#scopes.values()].map(scope => scope.bridge.controlSnapshot()));
      write({ type: "baseline", value: { projections } });
      return this.#observeBindings((scope, initial) => scope.bridge.watchControl(write, !initial));
    }
    const scope = this.#scope(endpoint, this.#scopeArgs(endpoint, payload));
    const bridge = scope?.bridge ?? this.#root;
    if (scope) await this.#verifyFolder(scope.folder);
    return bridge.subscribe(endpoint, payload, write, signal, finish);
  }

  async close(): Promise<void> {
    this.#working = false;
    await this.#tail;
    this.#listeners.clear();
    const workbenches = new Set([this.launch, ...[...this.#scopes.values()].map(scope => scope.bridge.workbench)]);
    for (const scope of this.#scopes.values()) scope.bridge.close();
    await Promise.all([...workbenches].map(workbench => workbench.close()));
  }
}
