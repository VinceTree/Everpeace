import { spawn } from "node:child_process";

/** Request process-tree termination and wait for the platform kill request to settle. */
export function stopProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const settle = () => resolve();
      killer.once("error", () => {
        try { process.kill(pid); } catch {}
        settle();
      });
      killer.once("close", settle);
    });
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  return Promise.resolve();
}
