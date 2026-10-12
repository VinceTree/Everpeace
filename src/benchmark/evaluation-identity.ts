import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Bind prompts, seed/reference patches, dependencies and independent assertions. */
export async function captureBenchmarkEvaluationDigest(catalogPath: string, fixtureRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const add = async (name: string, file: string) => {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Evaluation inputs must be ordinary files");
    const bytes = await readFile(file);
    hash.update(String(Buffer.byteLength(name))).update("\0").update(name).update("\0").update(String(bytes.byteLength)).update("\0").update(bytes).update("\0");
  };
  await add("catalog", catalogPath);
  const visit = async (directory: string) => {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Evaluation directories must not be symlinks");
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      if ((await lstat(file)).isDirectory()) await visit(file);
      else await add(path.relative(fixtureRoot, file).split(path.sep).join("/"), file);
    }
  };
  await visit(fixtureRoot);
  return hash.digest("hex");
}

export async function captureFixtureTreeDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(current: string): Promise<void> {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error("Fixture source cannot contain symbolic links");
    if (metadata.isDirectory()) { for (const name of (await readdir(current)).sort()) await visit(path.join(current, name)); }
    else if (metadata.isFile()) {
      const name = path.relative(directory, current).split(path.sep).join("/"); const bytes = await readFile(current);
      hash.update(name).update("\0").update(String(bytes.byteLength)).update("\0").update(bytes);
    } else throw new Error("Fixture source must contain only ordinary files");
  }
  await visit(directory); return hash.digest("hex");
}
