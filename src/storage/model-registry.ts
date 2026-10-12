import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthStorage } from "./auth-storage.js";
import { isModelRequestSettings, isResponsesProfile, type ModelRequestSettings, type ResponsesProfile } from "../providers/capabilities.js";

const REGISTRY_VERSION = 1;

export interface StoredModelRegistration {
  id: string;
  model_name: string;
  base_url: string;
  auth_ref: string;
  created_at: string;
  updated_at: string;
  request_settings?: ModelRequestSettings;
  responses_profile?: ResponsesProfile;
}

export interface RegisteredModel {
  id: string;
  model_name: string;
  base_url: string;
  api_key: string;
  request_settings?: ModelRequestSettings;
  responses_profile?: ResponsesProfile;
}

export interface RegisteredModelStatus extends StoredModelRegistration {
  credential_status: "ready" | "missing";
}

interface RegistryFile {
  version: typeof REGISTRY_VERSION;
  models: StoredModelRegistration[];
}

export interface ResolvedModels {
  available: RegisteredModel[];
  missing: StoredModelRegistration[];
}

export interface ModelRegistryOptions {
  authStorage: AuthStorage;
  filePath?: string;
  now?: () => Date;
  createId?: () => string;
}

export function defaultRegistryPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  if (platform === "win32") {
    const root = env.APPDATA?.trim() || path.win32.join(homeDirectory, "AppData", "Roaming");
    return path.win32.join(root, "Everpeace", "models.json");
  }

  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "Everpeace", "models.json");
  }

  const root = env.XDG_CONFIG_HOME?.trim() || path.join(homeDirectory, ".config");
  return path.join(root, "everpeace", "models.json");
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStoredRegistration(value: unknown): value is StoredModelRegistration {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isString(record.id) &&
    isString(record.model_name) &&
    isString(record.base_url) &&
    isString(record.auth_ref) &&
    isString(record.created_at) &&
    isString(record.updated_at)
    && (record.request_settings === undefined || isModelRequestSettings(record.request_settings))
    && (record.responses_profile === undefined || isResponsesProfile(record.responses_profile))
  );
}

function parseRegistry(contents: string, filePath: string): RegistryFile {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`Model registry is not valid JSON: ${filePath}`);
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== REGISTRY_VERSION ||
    !("models" in value) ||
    !Array.isArray(value.models) ||
    !value.models.every(isStoredRegistration)
  ) {
    throw new Error(`Model registry has an unsupported or invalid format: ${filePath}`);
  }

  return { version: REGISTRY_VERSION, models: value.models };
}

export class ModelRegistry {
  readonly #authStorage: AuthStorage;
  readonly #filePath: string;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: ModelRegistryOptions) {
    this.#authStorage = options.authStorage;
    this.#filePath = options.filePath ?? defaultRegistryPath();
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  get filePath(): string {
    return this.#filePath;
  }

  async listStored(): Promise<StoredModelRegistration[]> {
    return [...(await this.#load()).models];
  }

  async listStatuses(): Promise<RegisteredModelStatus[]> {
    const stored = await this.listStored();
    return Promise.all(
      stored.map(async (model) => ({
        ...model,
        credential_status:
          (await this.#authStorage.get(model.auth_ref)) === null ? "missing" : "ready",
      })),
    );
  }

  async resolveAll(): Promise<ResolvedModels> {
    const stored = await this.listStored();
    const available: RegisteredModel[] = [];
    const missing: StoredModelRegistration[] = [];

    for (const model of stored) {
      const apiKey = await this.#authStorage.get(model.auth_ref);
      if (apiKey === null) {
        missing.push(model);
      } else {
        available.push({
          id: model.id,
          model_name: model.model_name,
          base_url: model.base_url,
          api_key: apiKey,
          ...(model.responses_profile === undefined ? {} : { responses_profile: model.responses_profile }),
          ...(model.request_settings ? { request_settings: { ...model.request_settings } } : {}),
        });
      }
    }

    return { available, missing };
  }

  async registerMany(
    baseUrl: string,
    modelNames: readonly string[],
    apiKey: string,
  ): Promise<StoredModelRegistration[]> {
    if (!baseUrl.trim()) throw new Error("base_url is required");
    if (!apiKey) throw new Error("api_key is required");

    const uniqueModelNames = [...new Set(modelNames.map((name) => name.trim()))].filter(Boolean);
    if (uniqueModelNames.length === 0) throw new Error("Select at least one model");

    const registry = await this.#load();
    const nextModels = registry.models.map((model) => ({ ...model }));
    const timestamp = this.#now().toISOString();
    const changes: Array<{ authRef: string; previousKey: string | null }> = [];
    const registered: StoredModelRegistration[] = [];

    try {
      for (const modelName of uniqueModelNames) {
        let model = nextModels.find(
          (candidate) =>
            candidate.base_url === baseUrl && candidate.model_name === modelName,
        );

        if (model === undefined) {
          const id = this.#createId();
          model = {
            id,
            model_name: modelName,
            base_url: baseUrl,
            auth_ref: `model:${id}`,
            created_at: timestamp,
            updated_at: timestamp,
          };
          nextModels.push(model);
        } else {
          model.updated_at = timestamp;
        }

        const previousKey = await this.#authStorage.get(model.auth_ref);
        changes.push({ authRef: model.auth_ref, previousKey });
        await this.#authStorage.set(model.auth_ref, apiKey);
        registered.push({ ...model });
      }

      await this.#save({ version: REGISTRY_VERSION, models: nextModels });
      return registered;
    } catch (error) {
      try {
        await this.#rollbackSecrets(changes);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Registration failed and system credentials could not be fully rolled back",
        );
      }
      throw error;
    }
  }

  async setResponsesProfile(model: Pick<StoredModelRegistration, "id" | "base_url" | "model_name">, profile: ResponsesProfile): Promise<StoredModelRegistration> {
    if (!isResponsesProfile(profile)) throw new Error("Use auto, generic, or deepseek for the Responses profile");
    const registry = await this.#load();
    const current = registry.models.find((entry) => entry.id === model.id);
    if (!current || current.base_url !== model.base_url || current.model_name !== model.model_name) {
      throw new Error("Model registration changed; select the model again before configuring its profile");
    }
    if (current.responses_profile !== profile) delete current.request_settings;
    current.responses_profile = profile;
    current.updated_at = this.#now().toISOString();
    await this.#save(registry);
    return { ...current };
  }

  async removeMany(ids: readonly string[]): Promise<StoredModelRegistration[]> {
    const uniqueIds = new Set(ids);
    const registry = await this.#load();
    const removed = registry.models.filter((model) => uniqueIds.has(model.id));
    if (removed.length === 0) return [];

    const savedSecrets: Array<{ authRef: string; previousKey: string | null }> = [];
    try {
      for (const model of removed) {
        const previousKey = await this.#authStorage.get(model.auth_ref);
        savedSecrets.push({ authRef: model.auth_ref, previousKey });
        await this.#authStorage.delete(model.auth_ref);
      }

      await this.#save({
        version: REGISTRY_VERSION,
        models: registry.models.filter((model) => !uniqueIds.has(model.id)),
      });
      return removed;
    } catch (error) {
      try {
        await this.#restoreSecrets(savedSecrets);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Logout failed and system credentials could not be fully restored",
        );
      }
      throw error;
    }
  }

  async #load(): Promise<RegistryFile> {
    try {
      return parseRegistry(await fs.readFile(this.#filePath, "utf8"), this.#filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: REGISTRY_VERSION, models: [] };
      }
      throw error;
    }
  }

  async #save(registry: RegistryFile): Promise<void> {
    const directory = path.dirname(this.#filePath);
    const temporaryPath = `${this.#filePath}.${this.#createId()}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });

    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.#filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #rollbackSecrets(
    changes: Array<{ authRef: string; previousKey: string | null }>,
  ): Promise<void> {
    await this.#restoreSecrets([...changes].reverse());
  }

  async #restoreSecrets(
    changes: Array<{ authRef: string; previousKey: string | null }>,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const change of changes) {
      try {
        if (change.previousKey === null) {
          await this.#authStorage.delete(change.authRef);
        } else {
          await this.#authStorage.set(change.authRef, change.previousKey);
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to roll back system credentials");
    }
  }
}
