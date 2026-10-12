import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const launcher = join(dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");
// Include prospective additions only in maintained code roots; user fixture directories stay outside the gate.
const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src", "tests", "scripts"], { encoding: "utf8" }).split("\0"))]
  .filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file)).sort();
if (!files.length) throw new Error("Lint found no maintained source files");
// Windows has a finite process command-line length; each batch still rejects every warning.
let batch = []; let length = 0;
const lint = () => {
  const result = spawnSync(process.execPath, [launcher, "--config", ".oxlintrc.json", "--max-warnings", "0", "--", ...batch], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  batch = []; length = 0;
};
for (const file of files) { if (length + file.length > 12_000) lint(); batch.push(file); length += file.length + 3; }
if (batch.length) lint();
