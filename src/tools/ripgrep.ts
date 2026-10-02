import { constants, promises as fs } from "node:fs";
import path from "node:path";

interface RipgrepModule {
  rgPath?: unknown;
}

export type RipgrepPathResolver = () => Promise<string>;
export type RipgrepModuleLoader = () => Promise<unknown>;

function unavailable(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Bundled ripgrep is unavailable for ${process.platform}-${process.arch}. `
      + `Reinstall Everpeace with optional dependencies enabled. ${detail}`,
    { cause: error },
  );
}

/** Creates a lazy, cached resolver so tests can model a missing platform package. */
export function createBundledRipgrepResolver(
  loadModule: RipgrepModuleLoader = () => import("@vscode/ripgrep"),
  access: (filePath: string, mode?: number) => Promise<void> = fs.access,
): RipgrepPathResolver {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= (async () => {
      let loaded: RipgrepModule;
      try {
        loaded = await loadModule() as RipgrepModule;
      } catch (error) {
        throw unavailable(error);
      }
      if (typeof loaded.rgPath !== "string" || !path.isAbsolute(loaded.rgPath)) {
        throw unavailable(new Error("@vscode/ripgrep did not provide an absolute executable path"));
      }
      try {
        await access(loaded.rgPath, constants.F_OK);
      } catch (error) {
        throw unavailable(error);
      }
      return loaded.rgPath;
    })();
    return pending;
  };
}

export const resolveBundledRipgrep = createBundledRipgrepResolver();
