import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";

export function inspectWorkflow(document) {
  function visit(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "uses") {
        assert.equal(typeof entry, "string");
        assert.ok(entry.startsWith("./") || /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/u.test(entry) || /^docker:\/\/[^\s]+@sha256:[a-f0-9]{64}$/u.test(entry), `Action must be pinned: ${entry}`);
      }
      if (key === "container" || key === "services") {
        const images = key === "services" ? Object.values(entry) : [entry];
        for (const image of images) assert.match(typeof image === "string" ? image : image.image, /@sha256:[a-f0-9]{64}$/u, "Container must be pinned");
      }
      visit(entry);
    }
  }
  visit(document);
  assert.ok(!(typeof document.on === "object" && document.on !== null && Object.hasOwn(document.on, "pull_request_target")) && document.on !== "pull_request_target" && !(Array.isArray(document.on) && document.on.includes("pull_request_target")), "Privileged PR execution is prohibited");
}

export function checkWorkflows(root) {
  const directory = path.join(root, ".github/workflows");
  for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/u.test(name))) inspectWorkflow(parse(readFileSync(path.join(directory, file), "utf8")));
  const release = parse(readFileSync(path.join(directory, "release.yml"), "utf8"));
  assert.deepEqual(Object.keys(release.on), ["workflow_dispatch"], "Release must only accept explicit dispatch");
  assert.equal(release.permissions.contents, "read");
  const publish = release.jobs.publish;
  assert.deepEqual(publish.needs, ["candidate", "package", "consumers", "security", "evidence", "native", "gate"]);
  const test = parse(readFileSync(path.join(directory, "test.yml"), "utf8"));
  assert.deepEqual(test.jobs.required.needs, ["validate", "security"]);
  for (const job of ["security", "evidence"]) assert.ok(release.jobs.gate.needs.includes(job));
  assert.equal(publish.permissions.contents, "write");
  assert.equal(publish.if, "github.event.inputs.failure_drill != 'true'");
  assert.equal(release.jobs.native.permissions.actions, "write", "The reusable queue watchdog needs caller cancellation permission");
  const native = parse(readFileSync(path.join(directory, "windows-native.yml"), "utf8"));
  assert.deepEqual(native.jobs.native.permissions, { contents: "read" }, "The dedicated runner must not inherit cancellation or publishing permission");
  const validation = parse(readFileSync(path.join(directory, "validate.yml"), "utf8"));
  const backend = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies["@openai/codex"];
  assert.match(backend, /^\d+\.\d+\.\d+$/u, "Native backend must use an exact reviewed package");
  const sandbox = validation.jobs.test.steps.find((step) => step.name === "Permit pinned Linux sandbox namespaces");
  assert.ok(sandbox?.run?.includes(`'${backend}-linux-x64'`), "Re-audit the native backend and synchronize its CI identity with package.json");
  assert.deepEqual(validation.jobs.test.strategy.matrix.os, ["ubuntu-24.04", "windows-2025"]);
  const checks = validation.jobs.test.steps.map((step) => step.run).filter(Boolean);
  for (const command of ["pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build"]) assert.ok(checks.some((step) => step.includes(command)), `Missing CI check ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkWorkflows(path.resolve(process.argv[2] ?? "."));
  console.log("Workflow pins and required gates verified.");
}
