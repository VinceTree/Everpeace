import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export async function writeSupplyChain(directory: string, sha: string, packageDigest: string): Promise<void> {
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const files: Record<string, string> = {};
  async function write(name: string, data: unknown) { const bytes = JSON.stringify(data); await fs.writeFile(path.join(directory, name), bytes); files[name] = hash(bytes); }
  const lock = "d".repeat(64);
  const receipt = JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"));
  receipt.lockSha256 = lock; await write("receipt.json", receipt);
  await write("scan.json", { schema: 1, commit: sha, lockSha256: lock, success: true, unreviewedSecrets: 0 });
  for (const name of ["secrets-history.json", "secrets-current.json"]) await write(name, []);
  await write("audit.json", { metadata: { totalDependencies: 4, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } });
  const components = ["@openai/codex", "@modelcontextprotocol/sdk", "node-pty", "node-addon-api"].map((name) => ({ name, version: "1.0.0", license: "MIT" }));
  await write("licenses.json", { schema: 1, components });
  const sbom = { bomFormat: "CycloneDX", components: components.map((entry) => ({ ...entry, purl: `pkg:npm/${entry.name}@${entry.version}`, licenses: [{ license: { id: "MIT" } }] })) };
  for (const name of ["lock.cdx.json", "package.cdx.json"]) await write(name, sbom);
  for (const platform of ["linux", "win32"]) {
    const checks = [];
    for (const mode of ["npm", "pnpm", "global"]) {
      const name = `consumer-${platform}-${mode}.cdx.json`; await write(name, sbom);
      const nativeSnapshot = `consumer-${platform}-${mode}-native.json`;
      const licenses = `consumer-${platform}-${mode}-licenses.json`; await write(licenses, { schema: 1, components });
      await write(nativeSnapshot, { schema: 1, files: [{ path: "node_modules/node-pty/prebuilds/pty.node", sha256: "e".repeat(64) }, { path: "node_modules/@openai/codex/bin/codex", sha256: "f".repeat(64) }] });
      checks.push({ mode, success: true, sbom: name, sha256: files[name], nativeSnapshot, nativeSha256: files[nativeSnapshot], licenses, licenseSha256: files[licenses] });
    }
    await write(`consumer-${platform}-x64.json`, { commit: sha, packageSha256: packageDigest, local: false, success: true, checks });
  }
  await fs.writeFile(path.join(directory, "supply-chain.json"), JSON.stringify({ schema: 1, commit: sha, packageSha256: packageDigest, files }));
}
