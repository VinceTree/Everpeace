import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import type { RegisteredModel } from "../../../src/storage/model-registry.js";
import type {
  ManagedSkill,
  PreparedSkillInstall,
  SkillInstallResult,
  SkillManagerLike,
} from "../../../src/skills/manager.js";
import { SkillWizard } from "../../../src/tui/components/wizards/skill-wizard.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

async function waitFor(check: () => boolean, debug?: () => string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail(`Timed out waiting for Skill wizard update${debug ? `\n${debug()}` : ""}`);
}

const skillMarkdown = "---\nname: demo-skill\ndescription: Handle deterministic demo tasks.\n---\n\nFollow the demo workflow.\n";
const model: RegisteredModel = { id: "model", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };

function manager(overrides: Partial<SkillManagerLike> = {}): SkillManagerLike {
  const installed: SkillInstallResult = { name: "demo-skill", directory: "/skills/demo-skill", scope: "project" };
  return {
    async list() { return []; },
    async saveCreated() { return installed; },
    async prepareInstall() { throw new Error("not configured"); },
    async installPrepared() { return installed; },
    async discardPrepared() {},
    ...overrides,
  };
}

test("Skill manager creates an AI draft and saves only after confirmation", async () => {
  let saved = "";
  const view = render(<SkillWizard
    manager={manager({ async saveCreated(markdown) { saved = markdown; return { name: "demo-skill", directory: "/skills/demo-skill", scope: "project" }; } })}
    activeModel={model}
    generateDraft={async () => skillMarkdown}
    reviseDraft={async () => skillMarkdown}
    onUse={() => {}}
    onBack={() => {}}
  />);
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Current project"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Describe the task"));
  await tick();
  view.stdin.write("build deterministic demos");
  await waitFor(() => (view.lastFrame() ?? "").includes("build deterministic demos"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Confirm and save"), () => view.lastFrame() ?? "");
  await tick();
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("is available now"), () => view.lastFrame() ?? "");
  assert.equal(saved, skillMarkdown);
  view.unmount();
});

test("installed Skill list can prefill an explicit invocation", async () => {
  const entry: ManagedSkill = {
    name: "demo-skill",
    description: "Handle deterministic demo tasks.",
    path: "/skills/demo-skill/SKILL.md",
    directory: "/skills/demo-skill",
    scope: "user",
    conflict: false,
    usable: true,
    skillMarkdown,
  };
  let used = "";
  const view = render(<SkillWizard manager={manager({ async list() { return [entry]; } })} onUse={(name) => { used = name; }} onBack={() => {}} />);
  await tick();
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("demo-skill · user"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Use in next prompt"), () => view.lastFrame() ?? "");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => used === "demo-skill");
  view.unmount();
});

test("URL installation previews one candidate and requires scope plus confirmation", async () => {
  const prepared: PreparedSkillInstall = {
    id: "prepared",
    sourceUrl: "https://example.com/SKILL.md",
    candidates: [{ id: "0", name: "demo-skill", description: "Handle deterministic demo tasks.", skillMarkdown, files: ["SKILL.md"] }],
  };
  let installed = false;
  const view = render(<SkillWizard manager={manager({
    async prepareInstall() { return prepared; },
    async installPrepared() { installed = true; return { name: "demo-skill", directory: "/skills/demo-skill", scope: "project" }; },
  })} onUse={() => {}} onBack={() => {}} />);
  await tick();
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Public GitHub folder"));
  await tick();
  view.stdin.write("https://example.com/SKILL.md");
  await waitFor(() => (view.lastFrame() ?? "").includes("https://example.com/SKILL.md"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Install this Skill"), () => view.lastFrame() ?? "");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Current project"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Install demo-skill"));
  await tick();
  view.stdin.write("y");
  await waitFor(() => installed && (view.lastFrame() ?? "").includes("is available now"));
  view.unmount();
});
