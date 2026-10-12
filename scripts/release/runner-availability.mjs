import assert from "node:assert/strict";
import { github, repository } from "./github.mjs";

assert.ok(process.env.GH_TOKEN, "Configure RUNNER_READ_TOKEN with repository administration read permission");
let found = false;
for (let page = 1; page <= 100; page++) {
  const result = await github(`repos/${repository()}/actions/runners?per_page=100&page=${page}`);
  found ||= result.runners.some((runner) => runner.status === "online" && !runner.busy && ["self-hosted", "Windows", "X64", "everpeace-native"].every((label) => runner.labels.some((entry) => entry.name.toLowerCase() === label.toLowerCase())));
  if (result.runners.length < 100) break;
}
assert.ok(found, "An idle dedicated Windows native runner is required; publishing is blocked");
console.log("Dedicated Windows runner is available.");
