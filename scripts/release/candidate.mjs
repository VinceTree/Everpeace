import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { candidateSha } from "./policy.mjs";

assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Dispatch Release from main");
const sha = candidateSha(process.env.CANDIDATE_SHA);
assert.equal(execFileSync("git", ["rev-parse", `${sha}^{commit}`], { encoding: "utf8" }).trim(), sha);
execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
const manifest = JSON.parse(execFileSync("git", ["show", `${sha}:package.json`], { encoding: "utf8" }));
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
console.log(`Candidate ${sha} validated on main.`);
