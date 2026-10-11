import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { digest } from "../release/policy.mjs";
import { runCommand } from "../release/commands.mjs";
import { EnvHttpProxyAgent, fetch } from "undici";

export async function withSecurityTool(name, use) {
  assert.equal(process.arch, "x64", "Security tools currently support x64 Windows/Linux");
  const tools = JSON.parse(await fs.readFile(new URL("./tools.json", import.meta.url), "utf8"));
  const pin = tools[name]?.[process.platform];
  assert.ok(pin, "Unsupported security scanner platform");
  const directory = await fs.mkdtemp(path.join(tmpdir(), "everpeace-scanner-"));
  const dispatcher = new EnvHttpProxyAgent();
  try {
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(300_000), dispatcher });
    assert.ok(response.ok, `Scanner download failed (${response.status})`);
    const archive = path.join(directory, process.platform === "win32" ? "tool.zip" : "tool.tar.gz");
    await fs.writeFile(archive, new Uint8Array(await response.arrayBuffer()));
    assert.equal(digest(archive), pin.sha256, "Scanner checksum mismatch");
    await runCommand("tar", ["-xf", archive, "-C", directory], { stdio: "ignore" });
    return await use(path.join(directory, name + (process.platform === "win32" ? ".exe" : "")), tools[name].version);
  } finally {
    await dispatcher.destroy();
    assert.equal(path.dirname(directory), tmpdir());
    assert.ok(path.basename(directory).startsWith("everpeace-scanner-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function sbom(source, destination, required = []) {
  await withSecurityTool("syft", async (executable) => {
    // Directory defaults emphasize declarations; explicitly include installed package manifests.
    await runCommand(executable, ["scan", `dir:${source}`, "--select-catalogers", "+javascript-package-cataloger", "-o", `cyclonedx-json=${destination}`], { stdio: "ignore", env: { ...process.env, SYFT_JAVASCRIPT_INCLUDE_DEV_DEPENDENCIES: "true", SYFT_JAVASCRIPT_SEARCH_REMOTE_LICENSES: "false" } });
  });
  const { checkSbom } = await import("./policy.mjs");
  const report = JSON.parse(await fs.readFile(destination, "utf8"));
  for (const component of report.components ?? []) if (typeof component.version === "string" && /[~^*><= ]/u.test(component.version)) {
    component.properties = [...(component.properties ?? []), { name: "everpeace:declared-version-range", value: component.version }, { name: "everpeace:version-evidence", value: "manifest declaration; installed version unknown" }];
    delete component.version;
  }
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  checkSbom(report, required);
}
