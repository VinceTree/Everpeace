import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

// Launch JS entry points without a Windows .cmd shell or command interpolation.
export async function packageManager(name, args, options = {}) {
  const executable = process.platform === "win32" ? `${name}.cmd` : name;
  let launcher;
  if (name === "pnpm" && process.env.npm_execpath && /^pnpm\.[cm]?js$/u.test(path.basename(process.env.npm_execpath))) launcher = process.env.npm_execpath;
  else {
    const require = createRequire(import.meta.url);
    try { launcher = require.resolve(`${name}/bin/${name === "npm" ? "npm-cli" : "pnpm"}.js`); }
    catch {
      const locations = execFileSync(process.platform === "win32" ? "where.exe" : "which", [executable], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/u);
      if (process.platform === "win32") {
        for (const location of locations) {
          try { launcher = require.resolve(path.join(path.dirname(location), "node_modules", name, "bin", name === "npm" ? "npm-cli.js" : "pnpm.cjs")); break; } catch { /* Try the next installation. */ }
        }
      }
    }
  }
  if (launcher) return runCommand(process.execPath, [launcher, ...args], options);
  if (process.platform === "win32") throw new Error(`Cannot locate ${name} JavaScript launcher`);
  return runCommand(name, args, options);
}

/** Own package/native child processes through close and any requested tree termination. */
export async function runCommand(file, args, { timeout = 10 * 60_000, ...options } = {}) {
  const child = spawn(file, args, { windowsHide: true, detached: process.platform !== "win32", ...options });
  let output = "";
  let failure;
  let cleanup;
  let closed = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    const remaining = 32 * 1024 * 1024 - output.length;
    output += chunk.slice(0, Math.max(0, remaining));
    if (chunk.length > remaining) { failure = new Error("Command output limit exceeded"); stop(); }
  });
  child.stderr?.on("data", (chunk) => { if (options.stdio !== "inherit") process.stderr.write(chunk); });
  function stop() {
    if (cleanup || closed) return;
    failure ??= new Error("Owned command was cancelled or timed out");
    cleanup = Promise.resolve().then(async () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        await new Promise((resolve, reject) => {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          killer.once("error", reject);
          killer.once("close", (code) => code === 0 ? resolve() : reject(new Error("Owned process-tree termination failed")));
        });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }).catch((error) => {
      failure = new Error("Process-tree cleanup failed; retain the fixture directory", { cause: error });
      failure.cleanupFailed = true;
      child.kill();
    });
  }
  const timer = setTimeout(stop, timeout);
  const cancel = () => { failure ??= new Error("Owned command was cancelled"); stop(); };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await new Promise((resolve) => {
      child.once("error", (error) => { failure = error; stop(); });
      child.once("close", (code) => { closed = true; resolve(code); });
    });
    await cleanup;
    if (failure) throw failure;
    if (result !== 0) throw new Error(`Owned command failed (${result ?? "no exit code"}): ${path.basename(file)}`);
    return output;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
