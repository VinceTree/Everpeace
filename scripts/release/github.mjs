export async function github(endpoint, options = {}) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GitHub token is required for this operation");
  const response = await fetch(`https://api.github.com/${endpoint}`, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
  });
  if (response.status === 404 && options.allowMissing) return undefined;
  if (!response.ok) throw new Error(`GitHub operation failed (${response.status})`);
  return response.status === 204 ? undefined : response.json();
}

export function repository() {
  const value = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/u.test(value ?? "")) throw new Error("A GitHub repository is required");
  return value;
}
