/** Filter inherited variables before the Node launcher itself starts. Values are never logged. */
export function modelShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => {
    if (value === undefined) return false;
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/iu.test(name)) return false;
    // These can execute code before the OS sandbox is established or load shell startup files.
    return !/^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|BASH_FUNC_.*|LD_.*|DYLD_.*|PYTHONPATH|PYTHONSTARTUP)$/iu.test(name);
  }));
}

/** Protect control metadata through the in-process editor as well as the shell backend. */
export function isProtectedPatchPath(relative: string): boolean {
  return relative.split(/[\\/]/u).some((part) =>
    [".git", ".codex", ".agents", ".everpeace"].includes(part.replace(/[ .]+$/u, "").toLowerCase()));
}
