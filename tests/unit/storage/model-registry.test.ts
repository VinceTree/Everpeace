import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AuthStorage } from "../../../src/storage/auth-storage.js";
import {
  defaultRegistryPath,
  ModelRegistry,
} from "../../../src/storage/model-registry.js";

class MemoryAuthStorage implements AuthStorage {
  readonly secrets = new Map<string, string>();
  failSetNumber: number | undefined;
  setCount = 0;

  async set(authRef: string, apiKey: string): Promise<void> {
    this.setCount += 1;
    if (this.setCount === this.failSetNumber) {
      throw new Error("credential store failure");
    }
    this.secrets.set(authRef, apiKey);
  }

  async get(authRef: string): Promise<string | null> {
    return this.secrets.get(authRef) ?? null;
  }

  async delete(authRef: string): Promise<boolean> {
    return this.secrets.delete(authRef);
  }
}

async function createTestRegistry(): Promise<{
  registry: ModelRegistry;
  auth: MemoryAuthStorage;
  filePath: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-registry-"));
  const auth = new MemoryAuthStorage();
  let id = 0;
  const registry = new ModelRegistry({
    authStorage: auth,
    filePath: path.join(directory, "models.json"),
    now: () => new Date("2026-09-14T00:00:00.000Z"),
    createId: () => `id-${(id += 1)}`,
  });
  return {
    registry,
    auth,
    filePath: registry.filePath,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

test("Responses profile survives restart without copying keys and rejects a changed registration", async () => {
  const fixture = await createTestRegistry();
  try {
    const [model] = await fixture.registry.registerMany("https://cc2.caaa.tech/v1", ["deepseek-flash"], "profile-secret");
    assert.equal(model!.responses_profile, undefined);
    await fixture.registry.setResponsesProfile(model!, "deepseek");
    const restarted = new ModelRegistry({ authStorage: fixture.auth, filePath: fixture.filePath });
    assert.equal((await restarted.resolveAll()).available[0]!.responses_profile, "deepseek");
    assert.equal((await restarted.resolveAll()).available[0]!.api_key, "profile-secret");
    assert.ok(!(await fs.readFile(fixture.filePath, "utf8")).includes("profile-secret"));
    await assert.rejects(restarted.setResponsesProfile({ ...model!, base_url: "https://other.example/v1" }, "deepseek"), /registration changed/u);
    await assert.rejects(restarted.setResponsesProfile({ ...model!, model_name: "another" }, "deepseek"), /registration changed/u);
    await restarted.setResponsesProfile(model!, "auto");
    assert.equal((await restarted.resolveAll()).available[0]!.responses_profile, "auto");
  } finally { await fixture.cleanup(); }
});

test("registerMany stores metadata without writing the API Key to JSON", async () => {
  const fixture = await createTestRegistry();
  try {
    const registered = await fixture.registry.registerMany(
      "https://api.deepseek.com",
      ["deepseek-v4-flash", "deepseek-v4-pro"],
      "sk-secret-value",
    );

    assert.equal(registered.length, 2);
    assert.notEqual(registered[0]?.auth_ref, registered[1]?.auth_ref);
    const contents = await fs.readFile(fixture.filePath, "utf8");
    assert.doesNotMatch(contents, /sk-secret-value/);
    assert.doesNotMatch(contents, /api_key/);

    const resolved = await fixture.registry.resolveAll();
    assert.equal(resolved.available.length, 2);
    assert.equal(resolved.available[0]?.api_key, "sk-secret-value");
    assert.equal(resolved.missing.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("registerMany updates duplicate base_url and model_name records", async () => {
  const fixture = await createTestRegistry();
  try {
    const first = await fixture.registry.registerMany(
      "https://api.deepseek.com",
      ["deepseek-v4-flash"],
      "old-key",
    );
    const second = await fixture.registry.registerMany(
      "https://api.deepseek.com",
      ["deepseek-v4-flash"],
      "new-key",
    );

    assert.equal((await fixture.registry.listStored()).length, 1);
    assert.equal(second[0]?.id, first[0]?.id);
    assert.equal((await fixture.registry.resolveAll()).available[0]?.api_key, "new-key");
  } finally {
    await fixture.cleanup();
  }
});

test("resolveAll separates registrations with missing credentials", async () => {
  const fixture = await createTestRegistry();
  try {
    const [registered] = await fixture.registry.registerMany(
      "https://api.deepseek.com",
      ["deepseek-v4-flash"],
      "secret",
    );
    assert.ok(registered);
    await fixture.auth.delete(registered.auth_ref);

    const resolved = await fixture.registry.resolveAll();
    assert.equal(resolved.available.length, 0);
    assert.equal(resolved.missing[0]?.id, registered.id);
  } finally {
    await fixture.cleanup();
  }
});

test("removeMany deletes selected metadata and credentials", async () => {
  const fixture = await createTestRegistry();
  try {
    const registered = await fixture.registry.registerMany(
      "https://api.deepseek.com",
      ["model-a", "model-b"],
      "secret",
    );
    const first = registered[0];
    assert.ok(first);

    const removed = await fixture.registry.removeMany([first.id]);

    assert.equal(removed.length, 1);
    assert.equal(await fixture.auth.get(first.auth_ref), null);
    assert.deepEqual(
      (await fixture.registry.listStored()).map((model) => model.model_name),
      ["model-b"],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("registerMany rolls back secrets when a batch write fails", async () => {
  const fixture = await createTestRegistry();
  try {
    fixture.auth.failSetNumber = 2;
    await assert.rejects(
      fixture.registry.registerMany(
        "https://api.deepseek.com",
        ["model-a", "model-b"],
        "secret",
      ),
      /credential store failure/,
    );

    assert.equal(fixture.auth.secrets.size, 0);
    assert.deepEqual(await fixture.registry.listStored(), []);
  } finally {
    await fixture.cleanup();
  }
});

test("invalid registry JSON is reported instead of overwritten", async () => {
  const fixture = await createTestRegistry();
  try {
    await fs.mkdir(path.dirname(fixture.filePath), { recursive: true });
    await fs.writeFile(fixture.filePath, "not json", "utf8");

    await assert.rejects(fixture.registry.listStored(), /not valid JSON/);
  } finally {
    await fixture.cleanup();
  }
});

test("defaultRegistryPath follows platform configuration directories", () => {
  assert.equal(
    defaultRegistryPath("win32", { APPDATA: "C:\\Config" }, "C:\\Users\\Test"),
    "C:\\Config\\Everpeace\\models.json",
  );
  assert.equal(
    defaultRegistryPath("linux", { XDG_CONFIG_HOME: "/config" }, "/home/test"),
    path.join("/config", "everpeace", "models.json"),
  );
});
