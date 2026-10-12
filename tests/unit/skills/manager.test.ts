import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { zipSync } from "fflate";
import { SkillCatalog } from "../../../src/skills/catalog.js";
import {
  buildGitCloneArguments,
  parseGitTreeEntries,
  selectGitSkillCandidates,
  SkillManager,
  normalizeGeneratedSkillMarkdown,
  validateManagedSkillMarkdown,
} from "../../../src/skills/manager.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }] as const;

async function workspace(t: TestContext) {
  const path = await fs.mkdtemp(join(tmpdir(), "everpeace-skill-manager-"));
  await fs.mkdir(join(path, ".git"));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

const skill = (name: string) => `---\nname: ${name}\ndescription: Handle ${name} tasks when this workflow applies.\n---\n\nFollow the ${name} workflow.\n`;

test("closing a Skill manager cancels an active download and rejects further preparation", async (t) => {
  const root = await workspace(t);
  let started!: () => void;
  const downloading = new Promise<void>((resolve) => { started = resolve; });
  let fetches = 0;
  const manager = new SkillManager({
    workspacePath: root, catalog: new SkillCatalog(root), lookup: publicLookup,
    async fetch(_url, options) {
      fetches++;
      const signal = options?.signal;
      assert.ok(signal);
      started();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const preparation = assert.rejects(manager.prepareInstall("https://example.com/SKILL.md"), /closed/i);
  await downloading;
  const first = manager.close(), second = manager.close();
  assert.equal(first, second);
  await Promise.all([first, second, preparation]);
  await assert.rejects(manager.prepareInstall("https://example.com/SKILL.md"), /closed/i);
  assert.equal(fetches, 1);
});

test("created skills are validated, installed atomically, and become discoverable", async (t) => {
  const root = await workspace(t);
  const catalog = new SkillCatalog(root);
  const manager = new SkillManager({ workspacePath: root, catalog });

  const result = await manager.saveCreated(skill("created-demo"), "project");
  assert.equal(result.name, "created-demo");
  assert.equal(await fs.readFile(join(result.directory, "SKILL.md"), "utf8"), skill("created-demo"));
  assert.ok((await manager.list()).some((item) => item.name === "created-demo" && item.usable));
  await assert.rejects(manager.saveCreated(skill("created-demo"), "project"), /already exists/u);
});

test("direct public SKILL.md is staged, previewed, and installed only after confirmation", async (t) => {
  const root = await workspace(t);
  const catalog = new SkillCatalog(root);
  const manager = new SkillManager({
    workspacePath: root,
    catalog,
    lookup: publicLookup,
    async fetch() {
      return new Response(skill("remote-demo"), { status: 200, headers: { "content-type": "text/markdown" } });
    },
  });
  t.after(() => manager.close());

  const prepared = await manager.prepareInstall("https://example.com/SKILL.md");
  assert.equal(prepared.candidates[0]?.name, "remote-demo");
  assert.equal((await manager.list()).some((item) => item.name === "remote-demo"), false);
  const result = await manager.installPrepared(prepared.id, prepared.candidates[0]!.id, "project");
  assert.equal(await fs.readFile(join(result.directory, "SKILL.md"), "utf8"), skill("remote-demo"));
});

test("multi-Skill ZIP sources expose separate previews and install only the selected package", async (t) => {
  const root = await workspace(t);
  const archive = zipSync({
    "bundle/first/SKILL.md": new TextEncoder().encode(skill("first-demo")),
    "bundle/second/SKILL.md": new TextEncoder().encode(skill("second-demo")),
    "bundle/second/references/details.md": new TextEncoder().encode("selected reference"),
  });
  const manager = new SkillManager({
    workspacePath: root,
    catalog: new SkillCatalog(root),
    lookup: publicLookup,
    async fetch() { return new Response(archive, { status: 200 }); },
  });
  t.after(() => manager.close());

  const prepared = await manager.prepareInstall("https://example.com/skills.zip");
  assert.deepEqual(prepared.candidates.map((candidate) => candidate.name), ["first-demo", "second-demo"]);
  const selected = prepared.candidates[1]!;
  assert.deepEqual(selected.files, ["SKILL.md", "references/details.md"]);

  const result = await manager.installPrepared(prepared.id, selected.id, "project");
  assert.equal(result.name, "second-demo");
  assert.equal(await fs.readFile(join(result.directory, "references", "details.md"), "utf8"), "selected reference");
  assert.equal((await manager.list()).some((item) => item.name === "first-demo"), false);
});

test("bounded Skill archives may contain more than the legacy 2,000-entry limit", async (t) => {
  const root = await workspace(t);
  const archiveEntries: Record<string, Uint8Array> = {
    "large-bounded/SKILL.md": new TextEncoder().encode(skill("large-bounded")),
  };
  for (let index = 0; index < 2_100; index += 1) {
    archiveEntries[`large-bounded/references/item-${index}.txt`] = new Uint8Array();
  }
  const manager = new SkillManager({
    workspacePath: root,
    catalog: new SkillCatalog(root),
    lookup: publicLookup,
    async fetch() { return new Response(zipSync(archiveEntries), { status: 200 }); },
  });
  t.after(() => manager.close());

  const prepared = await manager.prepareInstall("https://example.com/large-skill.zip");
  assert.equal(prepared.candidates[0]?.name, "large-bounded");
  assert.equal(prepared.candidates[0]?.files.length, 2_101);
});

test("Git preparation uses a no-checkout clone and parses bounded repository trees", () => {
  const args = buildGitCloneArguments(
    new URL("https://github.com/example/skills.git"),
    "C:\\temporary\\repository",
    "main",
  );
  assert.ok(args.includes("core.longpaths=true"));
  assert.ok(args.includes("--no-checkout"));
  assert.ok(!args.includes("--filter=blob:none"));
  assert.deepEqual(args.slice(-5), ["--branch", "main", "--", "https://github.com/example/skills.git", "C:\\temporary\\repository"]);

  const tree = parseGitTreeEntries([
    "100644 blob 0123456789abcdef 123\tskills/demo/SKILL.md",
    "100755 blob fedcba9876543210 456\tskills/demo/scripts/run.sh",
    "",
  ].join("\0"));
  assert.deepEqual(tree.map(({ mode, type, size, path }) => ({ mode, type, size, path })), [
    { mode: "100644", type: "blob", size: 123, path: "skills/demo/SKILL.md" },
    { mode: "100755", type: "blob", size: 456, path: "skills/demo/scripts/run.sh" },
  ]);
});

test("Git candidate limits apply after mirrored Skill manifests are deduplicated", () => {
  const canonical = Array.from({ length: 83 }, (_, index) => ({
    directory: `skills/demo-${index}`,
    name: `demo-${index}`,
  }));
  const mirrored = canonical.slice(0, 53).map((candidate) => ({
    directory: `skills/skills-codex/${candidate.name}`,
    name: candidate.name,
  }));
  const reviewed = canonical.slice(0, 53).map((candidate) => ({
    directory: `skills/skills-codex-review/${candidate.name}`,
    name: candidate.name,
  }));

  const selected = selectGitSkillCandidates([...mirrored, ...reviewed, ...canonical]);
  assert.equal(selected.length, 83);
  assert.ok(selected.every((candidate) => candidate.directory === `skills/${candidate.name}`));

  const distinct = Array.from({ length: 101 }, (_, index) => ({
    directory: `skills/distinct-${index}`,
    name: `distinct-${index}`,
  }));
  assert.throws(() => selectGitSkillCandidates(distinct), /more than 100 distinct candidate Skills/u);
});

test("remote sources reject traversal, private destinations, and HTTPS downgrades", async (t) => {
  const root = await workspace(t);
  const archive = zipSync({ "../outside.txt": new TextEncoder().encode("escape") });
  const manager = new SkillManager({
    workspacePath: root,
    catalog: new SkillCatalog(root),
    lookup: publicLookup,
    async fetch() { return new Response(archive, { status: 200 }); },
  });
  await assert.rejects(manager.prepareInstall("https://example.com/skill.zip"), /escapes its root/u);

  const privateManager = new SkillManager({
    workspacePath: root,
    catalog: new SkillCatalog(root),
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    async fetch() { throw new Error("fetch must not run"); },
  });
  await assert.rejects(privateManager.prepareInstall("https://example.com/SKILL.md"), /private network/u);

  let redirectRequests = 0;
  const redirectManager = new SkillManager({
    workspacePath: root,
    catalog: new SkillCatalog(root),
    lookup: publicLookup,
    async fetch() {
      redirectRequests += 1;
      return new Response(null, { status: 302, headers: { location: "http://example.com/SKILL.md" } });
    },
  });
  await assert.rejects(redirectManager.prepareInstall("https://example.com/SKILL.md"), /remain public HTTPS/u);
  assert.equal(redirectRequests, 1);
});

test("generated Skill normalization strips one outer fence and enforces names", () => {
  const normalized = normalizeGeneratedSkillMarkdown(`\`\`\`markdown\n${skill("fenced-demo").trim()}\n\`\`\``);
  assert.equal(validateManagedSkillMarkdown(normalized).name, "fenced-demo");
  assert.throws(() => validateManagedSkillMarkdown(skill("Bad_Name")), /lowercase/u);
});
