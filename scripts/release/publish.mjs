import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { candidateSha, requireSuccess, verifyPackage } from "./policy.mjs";
import { github, repository } from "./github.mjs";

export async function publish({ directory, sha, packageDigest, checks, repo, api = github }) {
  requireSuccess(checks, ["candidate", "package", "consumers", "native", "gate"]);
  candidateSha(sha);
  const receipt = JSON.parse(readFileSync(path.join(directory, "receipt.json"), "utf8"));
  assert.match(receipt.filename, /^everpeace-[0-9A-Za-z.+-]+\.tgz$/u);
  const archive = path.join(directory, receipt.filename);
  verifyPackage(receipt, archive, sha, packageDigest);
  assert.match(receipt.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  const tag = `v${receipt.version}`;
  const base = `repos/${repo}`;
  const existingTag = await api(`${base}/git/ref/tags/${tag}`, { allowMissing: true });
  if (existingTag) {
    let object = existingTag.object;
    for (let depth = 0; depth < 5 && object.type === "tag"; depth++) object = (await api(`${base}/git/tags/${object.sha}`)).object;
    assert.equal(object.type, "commit", "Tag does not resolve to a commit");
    assert.equal(object.sha, sha, "Existing tag belongs to another candidate");
  }
  let release = await api(`${base}/releases/tags/${tag}`, { allowMissing: true });
  if (release) {
    assert.ok(existingTag, "Existing release has no matching tag");
    assert.equal(release.tag_name, tag);
    const asset = release.assets.find((entry) => entry.name === receipt.filename);
    if (asset) assert.equal(asset.digest, `sha256:${packageDigest}`, "Existing release asset differs");
    if (!release.draft) {
      assert.ok(asset, "Published release is missing the verified package; refusing to modify it");
      console.log(`Verified existing ${tag}; no changes needed.`);
      return;
    }
  }
  if (!existingTag) {
    const object = await api(`${base}/git/tags`, { method: "POST", body: JSON.stringify({ tag, message: `Verified candidate ${sha}`, object: sha, type: "commit" }) });
    await api(`${base}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: object.sha }) });
  }
  if (!release) release = await api(`${base}/releases`, { method: "POST", body: JSON.stringify({ tag_name: tag, target_commitish: sha, name: tag, draft: true, prerelease: receipt.version.includes("-"), generate_release_notes: true }) });
  const files = [[receipt.filename, archive], ["receipt.json", path.join(directory, "receipt.json")]];
  for (const [name, file] of files) {
    const asset = release.assets.find((entry) => entry.name === name);
    if (asset) {
      // Never overwrite an existing asset, including a partially completed draft.
      const { digest } = await import("./policy.mjs");
      assert.equal(asset.digest, `sha256:${digest(file)}`, `Existing ${name} differs`);
      continue;
    }
    const token = process.env.GH_TOKEN;
    assert.ok(token, "Publishing requires a GitHub token");
    const response = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: "POST", body: readFileSync(file), redirect: "error", signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" },
    });
    assert.ok(response.ok, `Release asset upload failed (${response.status})`);
    const uploaded = await response.json();
    const { digest } = await import("./policy.mjs");
    assert.equal(uploaded.digest, `sha256:${digest(file)}`, "Uploaded release asset digest differs");
  }
  await api(`${base}/releases/${release.id}`, { method: "PATCH", body: JSON.stringify({ draft: false }) });
  console.log(`Published verified ${tag} at ${sha}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publish({ directory: path.resolve(process.argv[2]), sha: process.env.CANDIDATE_SHA, packageDigest: process.env.PACKAGE_SHA256, checks: JSON.parse(process.env.CHECK_RESULTS ?? "{}"), repo: repository() });
}
