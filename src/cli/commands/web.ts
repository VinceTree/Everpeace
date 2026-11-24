import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { currentLanguage } from "../../localization/language.js";
import { uiText } from "../../localization/messages.js";
import type { ExecModelRegistry } from "../../exec/types.js";
import { loadBrowserAssets, loadHarnessDesktop, loadPreparedHarnessAssets } from "../../web/assets.js";
import { startWorkbenchServer } from "../../web/server.js";
import { WebWorkbench } from "../../web/workbench.js";
import { openCodeGoModelsUrl } from "../../providers/openai-compatible.js";

interface WebOptions {
  open: boolean;
  model: string | undefined;
  harnessClient: string | undefined;
}

export async function runWebCommand(registry: ExecModelRegistry, options: WebOptions): Promise<number> {
  // The browser workbench is the DeepSeek Harness coding UI. When the user has
  // registered the OpenCode Go DeepSeek route, prefer that registration for a
  // new browser session so opening `web` connects to the intended backend
  // without requiring a second model-picker action. An explicit --model still
  // wins, and installations without Go keep their first registered model.
  const initialModel = options.model ?? (await registry.resolveAll()).available.find(model =>
    openCodeGoModelsUrl(model.base_url) !== undefined && model.model_name === "deepseek-v4.1-flash",
  )?.id;
  const [workspace, assets, harness] = await Promise.all([
    realpath(process.cwd()), loadBrowserAssets(), loadPreparedHarnessAssets(options.harnessClient),
  ]);
  const desktop = harness ? await loadHarnessDesktop(options.harnessClient) : undefined;
  const server = await startWorkbenchServer(new WebWorkbench(workspace, currentLanguage(), { registry }), assets, initialModel, harness, undefined, undefined, desktop);
  process.stdout.write(uiText("web.open", { p0: server.url }) + "\n");
  if (options.open) {
    const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const browser = spawn(command, [server.url], { stdio: "ignore", windowsHide: true });
    browser.on("error", () => process.stderr.write(uiText("web.browserError") + "\n"));
    browser.unref();
  }
  try {
    await new Promise<void>(resolve => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } finally {
    await server.close();
  }
  return 0;
}
