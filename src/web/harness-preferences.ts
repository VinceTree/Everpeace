import { createHash } from "node:crypto";
import { join } from "node:path";
import { normalizeWorkspacePath } from "../memory/learned-memory.js";
import { isWebPermissionMode, webPermissionMode, type WebPermissionMode } from "../permissions/policy.js";
import { UserSettingsStore } from "../storage/user-settings.js";

const fontSize = (min: number, max: number) => (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
function fontFamily(value: unknown): boolean {
  return typeof value === "string" && value.length <= 256 && !/[<>]/u.test(value) &&
    [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
}

const settingFields = {
  permission: { defaultPreset: { type: "string", valid: isWebPermissionMode } },
  "ui-settings-general": {
    welcomeNoticeVersion: { type: "string", valid: (value: unknown) => typeof value === "string" && /^[\w.-]{1,32}$/u.test(value) },
  },
  "ui-theme": {
    preference: { type: "string", valid: (value: unknown) => value === "light" || value === "dark" || value === "system" },
    fontSize: { type: "number", valid: fontSize(10, 22) },
    codeFontSize: { type: "number", valid: fontSize(10, 16) },
    terminalFontSize: { type: "number", valid: fontSize(10, 20) },
    textFontFamily: { type: "string", valid: fontFamily },
    codeFontFamily: { type: "string", valid: fontFamily },
    terminalFontFamily: { type: "string", valid: fontFamily },
  },
  locale: {
    preference: { type: "string", valid: (value: unknown) =>
      typeof value === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,5}$/u.test(value) },
  },
};

const settingsDefaults = {
  permission: {},
  "ui-settings-general": {},
  "ui-theme": {
    preference: "system", fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
    textFontFamily: "", codeFontFamily: "", terminalFontFamily: "",
  },
  locale: {},
};

export type HarnessSettingsNamespace = keyof typeof settingFields;
type SettingsField = { type: string; valid(value: unknown): boolean };
type SettingsValue = string | number;
interface SettingsSection {
  revision: number;
  value: Record<string, SettingsValue>;
}
interface BrowserSettings {
  version: 1;
  sections: Partial<Record<HarnessSettingsNamespace, SettingsSection>>;
}

type SettingChange =
  | { key: string; operation: "set"; value: SettingsValue }
  | { key: string; operation: "unset" };

export interface WorkspaceSidebar {
  version: 1;
  title?: string;
  orderedSessionIds: string[];
  pinnedSessionIds: string[];
  archivedSessionIds: string[];
}

export function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isSettingsNamespace(name: unknown): name is HarnessSettingsNamespace {
  return typeof name === "string" && Object.hasOwn(settingFields, name);
}

function fields(namespace: HarnessSettingsNamespace): Readonly<Record<string, SettingsField>> {
  return settingFields[namespace];
}

export function settingChange(namespace: HarnessSettingsNamespace, input: unknown): SettingChange | undefined {
  if (!plainRecord(input) || !Array.isArray(input.path) || input.path.length !== 1 || typeof input.path[0] !== "string") return;
  const key = input.path[0];
  const schema = fields(namespace);
  if (!Object.hasOwn(schema, key)) return;
  if (input.op === "unset") return { key, operation: "unset" };
  const value = input.value;
  if (input.op === "set" && (typeof value === "string" || typeof value === "number") && schema[key]!.valid(value)) {
    return { key, operation: "set", value };
  }
}

function isBrowserSettings(input: unknown): input is BrowserSettings {
  if (!plainRecord(input) || input.version !== 1 || !plainRecord(input.sections)) return false;
  return Object.entries(input.sections).every(([name, section]) => {
    if (!isSettingsNamespace(name) || !plainRecord(section) || typeof section.revision !== "number" ||
        !Number.isSafeInteger(section.revision) || section.revision < 0 || !plainRecord(section.value)) return false;
    const schema = fields(name);
    return Object.entries(section.value).every(([key, value]) => Object.hasOwn(schema, key) && schema[key]!.valid(value));
  });
}

function ids(input: unknown): input is string[] {
  return Array.isArray(input) && input.every(id => typeof id === "string" && /^[\w-]{1,100}$/u.test(id)) &&
    new Set(input).size === input.length;
}

function isSidebar(input: unknown): input is WorkspaceSidebar {
  return plainRecord(input) && input.version === 1 &&
    (input.title === undefined || typeof input.title === "string" && input.title.length <= 240) &&
    ids(input.orderedSessionIds) && ids(input.pinnedSessionIds) && ids(input.archivedSessionIds);
}

export function emptySidebar(): WorkspaceSidebar {
  return { version: 1, orderedSessionIds: [], pinnedSessionIds: [], archivedSessionIds: [] };
}

export class SettingsRevisionConflict extends Error {}

function permissionDefault(state: BrowserSettings, cap: WebPermissionMode): WebPermissionMode {
  const saved = state.sections.permission?.value.defaultPreset;
  return webPermissionMode(cap, isWebPermissionMode(saved) ? saved : undefined);
}

function sectionView(namespace: HarnessSettingsNamespace, state: BrowserSettings, cap: WebPermissionMode) {
  const section = state.sections[namespace] ?? { revision: 0, value: {} };
  // The stock client's Schema constructor consumes Schemastery's reference table,
  // which is distinct from a bare JSON Schema tree.
  const entries = Object.entries(fields(namespace));
  const dict = Object.fromEntries(entries.map(([key], index) => [key, index + 1]));
  const refs = Object.fromEntries(entries.map(([, field], index) => [index + 1, { type: field.type, meta: { required: false } }]));
  const uid = entries.length + 1;
  const base = namespace === "permission" ? { defaultPreset: cap } : settingsDefaults[namespace];
  const value = namespace === "permission" ? { defaultPreset: permissionDefault(state, cap) } : { ...base, ...section.value };
  const schema = { uid, refs: { ...refs, [uid]: { type: "object", meta: { default: {} }, dict } } };
  return {
    ns: namespace, schema,
    value, base, user: section.value, revision: section.revision,
    autoGenerate: false, applies: "live", secrets: [],
  };
}

export class HarnessPreferences {
  readonly #settings: UserSettingsStore<BrowserSettings>;
  readonly sidebar: UserSettingsStore<WorkspaceSidebar>;

  constructor(workspace: string, readonly directory?: string) {
    const identity = createHash("sha256").update(normalizeWorkspacePath(workspace)).digest("hex");
    const file = (name: string) => directory ? join(directory, name) : undefined;
    this.#settings = new UserSettingsStore("browser-settings.json", isBrowserSettings,
      () => ({ version: 1, sections: {} }), file("browser-settings.json"));
    const sidebar = `browser-workspace-${identity}.json`;
    this.sidebar = new UserSettingsStore(sidebar, isSidebar, emptySidebar, file(sidebar));
  }

  async permissionDefault(cap: WebPermissionMode) {
    return permissionDefault(await this.#settings.read(), cap);
  }

  async describe(cap: WebPermissionMode) {
    const state = await this.#settings.read();
    const namespaces = Object.keys(settingFields).filter(isSettingsNamespace).map(name => sectionView(name, state, cap));
    return { writable: true, hasDocument: true, namespaces };
  }

  async mutate(namespace: HarnessSettingsNamespace, changes: SettingChange[], cap: WebPermissionMode, revision?: number) {
    const next = await this.#settings.update(current => {
      const section = current.sections[namespace] ?? { revision: 0, value: {} };
      if (revision !== undefined && section.revision !== revision) throw new SettingsRevisionConflict();
      const value = { ...section.value };
      for (const change of changes) {
        if (change.operation === "set") value[change.key] = change.value;
        else delete value[change.key];
      }
      return { version: 1, sections: { ...current.sections, [namespace]: { revision: section.revision + 1, value } } };
    });
    return sectionView(namespace, next, cap);
  }
}
