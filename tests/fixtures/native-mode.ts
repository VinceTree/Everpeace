/** Hosted Windows explicitly opts out. Required native acceptance never skips. */
export function windowsNativeSkip(env = process.env, platform = process.platform): string | false {
  if (env.EVERPEACE_NATIVE_REQUIRED === "1") {
    if (platform !== "win32") throw new Error("Required Windows native acceptance needs Windows");
    if (env.EVERPEACE_NATIVE_MODE === "hosted") throw new Error("Required native acceptance cannot use hosted mode");
    return false;
  }
  if (platform !== "win32") return "Windows-only native sandbox integration";
  return env.EVERPEACE_NATIVE_MODE === "hosted" ? "Hosted Windows cannot initialize the nested native sandbox" : false;
}
