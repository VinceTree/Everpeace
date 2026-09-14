import { AsyncEntry } from "@napi-rs/keyring";

const SERVICE_NAME = "Everpeace";
const ENTRY_OPTIONS = { linux: { store: "secret-service" as const } };

function unavailable(operation: string, cause: unknown): Error {
  return new Error(
    `System credential storage is unavailable while ${operation}. ` +
      "Unlock or configure Windows Credential Manager, macOS Keychain, or Linux Secret Service, then try again.",
    { cause },
  );
}

export interface AuthStorage {
  set(authRef: string, apiKey: string): Promise<void>;
  get(authRef: string): Promise<string | null>;
  delete(authRef: string): Promise<boolean>;
}

export class SystemAuthStorage implements AuthStorage {
  async set(authRef: string, apiKey: string): Promise<void> {
    try {
      await new AsyncEntry(SERVICE_NAME, authRef, ENTRY_OPTIONS).setPassword(apiKey);
    } catch (error) {
      throw unavailable("saving an API Key", error);
    }
  }

  async get(authRef: string): Promise<string | null> {
    try {
      return (
        (await new AsyncEntry(SERVICE_NAME, authRef, ENTRY_OPTIONS).getPassword()) ?? null
      );
    } catch (error) {
      throw unavailable("reading an API Key", error);
    }
  }

  async delete(authRef: string): Promise<boolean> {
    try {
      return await new AsyncEntry(SERVICE_NAME, authRef, ENTRY_OPTIONS).deletePassword();
    } catch (error) {
      throw unavailable("deleting an API Key", error);
    }
  }
}
