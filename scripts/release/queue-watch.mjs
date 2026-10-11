import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { github, repository } from "./github.mjs";

export async function watchQueue({ repo, run, api = github, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), limitMs = 5 * 60_000 }) {
  assert.match(String(run), /^\d+$/u);
  const started = now();
  while (now() - started < limitMs) {
    const jobs = await api(`repos/${repo}/actions/runs/${run}/jobs?per_page=100`);
    const native = jobs.jobs.find((job) => job.name.endsWith("native / native") || job.labels?.includes("everpeace-native"));
    if (native && (native.status === "in_progress" || native.status === "completed")) return;
    await sleep(5_000);
  }
  await api(`repos/${repo}/actions/runs/${run}/cancel`, { method: "POST" });
  throw new Error("Dedicated Windows job did not start within five minutes; this run was cancelled");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await watchQueue({ repo: repository(), run: process.env.GITHUB_RUN_ID });
