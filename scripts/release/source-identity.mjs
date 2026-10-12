import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export function sourceIdentity(root) {
  const roots = ["src", "tests", "scripts", ".github", "docs", "assets", "third_party", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches", "README.md", "README.zh-CN.md", "tsconfig.json", "tsconfig.build.json", ".oxlintrc.json", ".gitignore", ".gitattributes", ".gitleaks.toml", "AGENTS.md", "LICENSE", "SECURITY.md"];
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file + "\0").update(readFileSync(path.join(root, file))).update("\0");
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...roots], { cwd: root, encoding: "utf8" }).trim() !== "";
  return { sourceSha256: hash.digest("hex"), dirty };
}
