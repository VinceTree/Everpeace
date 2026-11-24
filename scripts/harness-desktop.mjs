import { OPEN_IN_APP_CATALOG } from "@deepseek-ai/dsh-host-open-in-app/src/catalog.ts";
import { extractAppIcon } from "@deepseek-ai/dsh-host-open-in-app/src/icons.ts";
import { launchDetachedApp, launchResolved, resolveLaunch, resolveOpenInAppApps } from "@deepseek-ai/dsh-host-open-in-app/src/resolver.ts";
import { canOpenNativePath, nativeFileApplications, openNativeAssociatedPath, openNativeFileApplication, revealNativePath } from "@deepseek-ai/dsh-native-command";

const probeMs = 3000;
const watchMs = 600;

export function createDesktop({ run, resolveExecutable }) {
  const ssh = Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
  const options = { ssh, run, resolveExecutable, async launch(command, args, launcher) {
    const executable = await resolveExecutable(command);
    if (!executable) throw Object.assign(new Error("Desktop launcher is unavailable"), { code: "ENOENT" });
    return launchDetachedApp(executable, args, launcher);
  } };
  const available = !ssh && canOpenNativePath();
  let resolutions;
  const catalog = () => resolutions ??= resolveOpenInAppApps(probeMs, options);
  const icons = new Map();
  return {
    available,
    async apps() { return available ? [...(await catalog()).keys()] : []; },
    async icon(id) {
      if (!available) return null;
      const app = OPEN_IN_APP_CATALOG.find(item => item.id === id);
      const item = (await catalog()).get(id);
      if (!app || !item) return null;
      if (!icons.has(id)) icons.set(id, extractAppIcon(app, item, probeMs, options));
      return icons.get(id);
    },
    async openDirectory(id, verify, signal) {
      const app = OPEN_IN_APP_CATALOG.find(item => item.id === id);
      const entries = await catalog();
      let item = entries.get(id);
      if (!available || !app || !item) return "unavailable";
      const launch = async () => {
        const path = await verify();
        signal.throwIfAborted();
        return launchResolved(item, path, watchMs, options);
      };
      const outcome = await launch();
      if (outcome !== "missing") return outcome;
      item = await resolveLaunch(app, probeMs, options);
      icons.delete(id);
      if (!item) { entries.delete(id); return "unavailable"; }
      entries.set(id, item);
      return await launch() === "launched" ? "launched" : "failed";
    },
    applications(path, signal) { return nativeFileApplications(path, signal, options); },
    openFile(path, action, application, signal) {
      if (action === "reveal") return revealNativePath(path, signal, options);
      if (application !== undefined) return openNativeFileApplication(path, application, signal, options);
      return openNativeAssociatedPath(path, signal, options);
    },
  };
}
