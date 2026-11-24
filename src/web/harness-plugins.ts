import { createHash } from "node:crypto";
import { join } from "node:path";
import { UserSettingsStore } from "../storage/user-settings.js";
import { normalizeWorkspacePath } from "../memory/learned-memory.js";

/**
 * The browser client ships its UI plugins as static assets. The stock client
 * still expects a Host-side profile and inventory, so keep a small durable
 * profile for those shipped entries instead of returning an empty directory.
 * A toggle is applied on the next browser reload because the bundled client
 * modules are loaded once at startup.
 */
const BUILTIN_PLUGINS = [
  "dsh-client-ui-agent-team",
  "dsh-client-ui-file-actions",
  "dsh-client-ui-goal",
  "dsh-client-ui-jobs",
  "dsh-client-ui-model-selection",
  "dsh-client-ui-open-in-app",
  "dsh-client-ui-permission-presets",
  "dsh-client-ui-plan",
  "dsh-client-ui-plugin-manager",
  "dsh-client-ui-reference",
  "dsh-client-ui-schedule",
  "dsh-client-ui-session",
  "dsh-client-ui-skill",
  "dsh-client-ui-workspace",
] as const;

interface PluginProfile {
  version: 1;
  plugins: Record<string, boolean>;
  bundles: Record<string, boolean>;
  indexes: string[];
  exemptions: Record<string, string[]>;
}

function isProfile(value: unknown): value is PluginProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const maps = [record.plugins, record.bundles];
  return record.version === 1 && maps.every(map => map && typeof map === "object" && !Array.isArray(map) &&
    Object.entries(map).every(([key, enabled]) => /^[A-Za-z0-9._/@:-]{1,240}$/u.test(key) && typeof enabled === "boolean")) &&
    Array.isArray(record.indexes) && record.indexes.length <= 16 && record.indexes.every(index => typeof index === "string" && index.startsWith("https://") && index.length <= 2048) &&
    (record.exemptions === undefined || Boolean(record.exemptions && typeof record.exemptions === "object" && !Array.isArray(record.exemptions) && Object.entries(record.exemptions).every(([key, versions]) => typeof key === "string" && Array.isArray(versions) && versions.every(version => typeof version === "string" && version.length <= 128))));
}

function emptyProfile(): PluginProfile {
  return { version: 1, plugins: {}, bundles: {}, indexes: [], exemptions: {} };
}

function pluginMeta(name: string) {
  return { title: name.replace(/^dsh-client-ui-/u, "").replaceAll("-", " ") };
}

export class HarnessPluginManager {
  readonly #store: UserSettingsStore<PluginProfile>;

  constructor(settingsDirectory: string, workspace: string) {
    const digest = createHash("sha256").update(normalizeWorkspacePath(workspace)).digest("hex").slice(0, 24);
    this.#store = new UserSettingsStore(`browser-plugins-${digest}.json`, isProfile, emptyProfile, join(settingsDirectory, `browser-plugins-${digest}.json`));
  }

  async listPlugins() {
    const profile = await this.#store.read();
    return BUILTIN_PLUGINS.map(name => {
      const entryId = `everpeace:${name}`;
      const enabled = profile.plugins[entryId] ?? true;
      return {
        entryId,
        moduleName: `@deepseek-ai/${name}`,
        meta: pluginMeta(name),
        enabled,
        fiberPhase: enabled ? "active" : null,
        ...(enabled ? {} : { diagnostic: "Disabled in the Everpeace browser profile" }),
        patchId: entryId,
      };
    });
  }

  async listBundles() {
    const profile = await this.#store.read();
    const name = "everpeace-browser-client";
    const enabled = profile.bundles[name] ?? true;
    return [{
      name,
      official: true,
      availability: "installation",
      version: "0.2.3-alpha.2",
      enabled,
      installed: true,
      optional: false,
      removable: false,
      listedByDefault: true,
      rows: BUILTIN_PLUGINS.map(rowId => ({ rowId, moduleName: `@deepseek-ai/${rowId}`, meta: pluginMeta(rowId), entryId: `everpeace:${rowId}` })),
      overrides: [],
    }];
  }

  async inventory() {
    const entries = await this.listPlugins();
    return { managementAvailable: true, entries, agentPresets: [] };
  }

  async setPluginEnabled(id: string, enabled: boolean) {
    if (!id.startsWith("everpeace:") || !BUILTIN_PLUGINS.includes(id.slice("everpeace:".length) as typeof BUILTIN_PLUGINS[number])) {
      throw new Error("Unknown browser plugin");
    }
    await this.#store.update(profile => ({ ...profile, plugins: { ...profile.plugins, [id]: enabled } }));
    return { changed: true, application: "restart-required", restartReason: "module-comparison", stage: enabled ? "enable" : "remove", target: id, enabled };
  }

  async setBundleEnabled(name: string, enabled: boolean) {
    if (name !== "everpeace-browser-client") throw new Error("Unknown browser bundle");
    await this.#store.update(profile => ({ ...profile, bundles: { ...profile.bundles, [name]: enabled } }));
    return { changed: true, application: "restart-required", restartReason: "module-comparison", stage: enabled ? "enable" : "remove", target: name, enabled };
  }

  async inspect(spec: string) {
    const name = spec.trim();
    if (!BUILTIN_PLUGINS.includes(name as typeof BUILTIN_PLUGINS[number])) {
      return { status: "refused", problem: "unknown", reason: "Only plugins already shipped with this browser build can be activated" };
    }
    return { status: "accepted", kind: "registry", name, version: "0.2.3-alpha.2", description: pluginMeta(name).title, bundle: true, registry: null };
  }

  async installBundle(spec: string, options?: Record<string, unknown>) {
    const inspected = await this.inspect(spec);
    if (inspected.status !== "accepted") {
      return { changed: false, application: "failed", stage: "install", target: spec, error: { code: "unknown-plugin", diagnostic: inspected.reason } };
    }
    const id = `everpeace:${inspected.name}`;
    await this.#store.update(profile => ({ ...profile, plugins: { ...profile.plugins, [id]: options?.enabled !== false } }));
    return { changed: true, application: "restart-required", restartReason: "module-comparison", stage: "enable", target: inspected.name, enabled: options?.enabled !== false, bundle: inspected.name, version: inspected.version };
  }

  async readBundleDetail(name: string) {
    if (!BUILTIN_PLUGINS.includes(name as typeof BUILTIN_PLUGINS[number])) return { status: "none" };
    return { status: "found", origin: "locale", path: "README.md", markdown: `# ${pluginMeta(name).title}\n\nThis browser plugin is bundled with Everpeace's DeepSeek Harness client.` };
  }

  async updateBundle(name: string) {
    return { changed: false, application: "failed", stage: "install", target: name, error: { code: "not-removable", diagnostic: "Bundled browser plugins are updated with the Everpeace client build" } };
  }

  async cancelInstall() { return { changed: false, application: "cancelled", stage: "install", target: "", enabled: false }; }
  async waitForInstall() { return { status: "none" }; }

  async removeBundle(name: string) {
    if (name !== "everpeace-browser-client") throw new Error("Unknown browser bundle");
    return { changed: false, application: "failed", stage: "remove", target: name, error: { code: "not-removable", diagnostic: "The bundled browser client is part of this Everpeace build" } };
  }

  async listIndexes() {
    return (await this.#store.read()).indexes.map(url => ({ url, title: undefined }));
  }

  async setIndexes(indexes: unknown) {
    if (!Array.isArray(indexes) || indexes.length > 16 || indexes.some(index => typeof index !== "string" || !index.startsWith("https://") || index.length > 2048)) throw new Error("Plugin market indexes must be HTTPS URLs");
    await this.#store.update(profile => ({ ...profile, indexes: [...new Set(indexes)] as string[] }));
    return this.listIndexes();
  }

  async listVersionExemptions() { return { exemptions: (await this.#store.read()).exemptions ?? {}, warnings: [] }; }

  async registries() { return { registry: null, fallbackRegistries: [], resolved: null }; }

  async searchMarket(url: string, query: Record<string, unknown>) {
    const indexes = await this.listIndexes();
    if (!indexes.some(index => index.url === url)) throw new Error("Plugin market index is not configured");
    const text = typeof query.text === "string" ? query.text.trim().toLowerCase() : "";
    const entries = BUILTIN_PLUGINS.filter(name => !text || name.toLowerCase().includes(text)).map(name => ({
      name,
      title: pluginMeta(name).title,
      versions: [],
      installation: { status: "provided" },
    }));
    return { url, title: url, metadata: { categories: {}, labels: {}, sortKeys: {} }, fetchedAt: Date.now(), entries };
  }

  async setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk = false) {
    if (enabled && !acceptRisk) throw new Error("Accept the compatibility risk before enabling an exemption");
    const next = await this.#store.update(profile => {
      const exemptions = Object.fromEntries(Object.entries(profile.exemptions ?? {}).map(([key, values]) => [key, [...values]]));
      const [name] = packageVersion.split("@", 1);
      const values = new Set(exemptions[name ?? packageVersion] ?? []);
      if (enabled) values.add(runtimeVersion); else values.delete(runtimeVersion);
      if (values.size) exemptions[name ?? packageVersion] = [...values]; else delete exemptions[name ?? packageVersion];
      return { ...profile, exemptions };
    });
    return { exemptions: next.exemptions, warnings: [] };
  }

  async readEntryDetail(url: string, name: string) {
    const indexes = await this.listIndexes();
    if (!indexes.some(index => index.url === url)) throw new Error("Plugin market index is not configured");
    return { status: "found", origin: "locale", markdown: `# ${pluginMeta(name).title}\n\nThis entry is available through the configured Everpeace plugin index.`, document: "README.md" };
  }
}
