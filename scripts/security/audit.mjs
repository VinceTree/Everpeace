import { spawn } from "node:child_process";

export async function captureAudit() {
  // Run the existing shell-free package-manager launcher in a child, retaining JSON on nonzero exit.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `import { packageManager } from ${JSON.stringify(new URL("../release/commands.mjs", import.meta.url).href)}; await packageManager("pnpm", ["audit", "--json", "--registry=https://registry.npmjs.org"], { stdio: "inherit" }).catch(() => { process.exitCode = 1; });`], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Audit service timed out")); }, 120_000);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 32 * 1024 * 1024) child.kill(); });
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(timer); if (![0, 1].includes(code) || output.length > 32 * 1024 * 1024) reject(new Error("Audit service failed")); else resolve(output); });
  });
}
