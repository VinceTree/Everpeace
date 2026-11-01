/** Fake global fetch fixtures must not inherit the host's real model proxy. */
export function isolateOfflineModelProxy(): () => void {
  const names = ["no_proxy", "NO_PROXY"] as const;
  const before = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) process.env[name] = "*";
  return () => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
