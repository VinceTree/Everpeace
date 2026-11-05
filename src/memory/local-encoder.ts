import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { withPublicResponse } from "../network/public-http.js";
import type { SemanticEncoder } from "./semantic-retrieval.js";

const MODEL = "Xenova/multilingual-e5-small";
export const E5_MODEL = MODEL;
export const BGE_MODEL = "Xenova/bge-small-en-v1.5";
export const BGE_BASE_MODEL = "Xenova/bge-base-en-v1.5";
type LocalEncoderModel = typeof MODEL | typeof BGE_MODEL | typeof BGE_BASE_MODEL;
const RUNTIME = "3.8.1";
const FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
interface Assets { model: string; revision: string; runtime: string; files: Record<string, string> }
const modelFiles = (model: string) => [...FILES.slice(0, -1), model === BGE_MODEL ? "onnx/model.onnx" : "onnx/model_quantized.onnx"];

async function runtimeVersion(): Promise<string> {
  const entry = createRequire(import.meta.url).resolve("@huggingface/transformers");
  return (JSON.parse(await readFile(path.resolve(path.dirname(entry), "../package.json"), "utf8")) as { version: string }).version;
}

/** Freeze the actual native runtime too, including app-local VC runtime prerequisites. */
export async function semanticRuntimeFiles(): Promise<Record<string, string>> {
  const require = createRequire(import.meta.url), hf = require.resolve("@huggingface/transformers");
  const ort = createRequire(hf).resolve("onnxruntime-node");
  const root = path.resolve(path.dirname(ort), "../bin/napi-v3", process.platform, process.arch);
  const files: Record<string, string> = {};
  for (const name of (await readdir(root)).sort()) {
    const file = path.join(root, name), stat = await lstat(file);
    if (stat.isFile() && /\.(?:node|dll|so|dylib)$/u.test(name)) files[file] = sha(await readFile(file));
  }
  if (!Object.keys(files).length) throw Error("Native encoder runtime unavailable");
  return files;
}

async function download(address: string): Promise<Buffer> {
  let url = new URL(address);
  const signal = AbortSignal.timeout(600_000);
  for (let hop = 0; hop < 8; hop++) {
    const result = await withPublicResponse(url, { signal }, {}, async response => {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location) throw Error("Model redirect missing location");
        return new URL(location, url);
      }
      if (!response.ok) throw Error(`Model asset download failed: ${response.status}`);
      const parts: Uint8Array[] = []; let bytes = 0;
      const reader = response.body?.getReader(); if (!reader) throw Error("Missing model asset body");
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.length; if (bytes > 300_000_000) throw Error("Model asset exceeds limit"); parts.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      return Buffer.concat(parts);
    });
    if (result instanceof URL) { url = result; continue; }
    return result;
  }
  throw Error("Too many model asset redirects");
}

/** Explicit setup only. No facts, queries or credentials are sent to the model host. */
export async function prepareSemanticAssets(directory: string, model: LocalEncoderModel = MODEL): Promise<void> {
  if (![MODEL, BGE_MODEL, BGE_BASE_MODEL].includes(model)) throw Error("Unreviewed encoder model");
  if (await runtimeVersion() !== RUNTIME) throw Error("Unexpected encoder runtime");
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  const info = JSON.parse((await download(`https://huggingface.co/api/models/${model}`)).toString("utf8")) as { sha: string };
  if (!/^[a-f0-9]{40}$/u.test(info.sha)) throw Error("Invalid model revision");
  const files: Record<string, string> = {};
  for (const name of modelFiles(model)) {
    const bytes = await download(`https://huggingface.co/${model}/resolve/${info.sha}/${name}`);
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), bytes, { flag: "wx" }); files[name] = sha(bytes);
    console.log(JSON.stringify({ asset: name, bytes: bytes.length }));
  }
  const manifest: Assets = { model, revision: info.sha, runtime: RUNTIME, files };
  const bytes = JSON.stringify(manifest, null, 2);
  await writeFile(path.join(directory, "assets.json"), bytes, { flag: "wx" });
  await writeFile(path.join(directory, "assets.sha256"), sha(bytes), { flag: "wx" });
}

export async function verifySemanticAssets(directory: string): Promise<{ identity: string; files: Record<string, string>; model: string }> {
  const bytes = await readFile(path.join(directory, "assets.json")), identity = sha(bytes);
  if (identity !== (await readFile(path.join(directory, "assets.sha256"), "utf8")).trim()) throw Error("Encoder manifest changed");
  const m = JSON.parse(bytes.toString("utf8")) as Assets;
  if (![MODEL, BGE_MODEL, BGE_BASE_MODEL].includes(m.model) || !/^[a-f0-9]{40}$/u.test(m.revision) || m.runtime !== RUNTIME || await runtimeVersion() !== RUNTIME
    || JSON.stringify(Object.keys(m.files).sort()) !== JSON.stringify(modelFiles(m.model).sort())) throw Error("Unexpected encoder assets");
  const files: Record<string, string> = {};
  for (const [name, hash] of Object.entries(m.files)) {
    const file = path.join(directory, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || sha(await readFile(file)) !== hash) throw Error("Encoder asset changed");
    files[file] = hash;
  }
  for (const name of ["assets.json", "assets.sha256"]) files[path.join(directory, name)] = sha(await readFile(path.join(directory, name)));
  return { identity, files, model: m.model };
}

/** Content tokens leave room for prefix and special tokens; windows overlap by 64 tokens. */
export function semanticWindows(tokens: readonly number[]): number[][] {
  if (!tokens.length) return [[]];
  const windows: number[][] = [];
  for (let start = 0; start < tokens.length; start += 416) {
    windows.push(tokens.slice(start, start + 480)); if (start + 480 >= tokens.length) break;
  }
  return windows;
}

export function semanticCacheKey(identity: string, prefix: "query" | "passage", text: string): string {
  return sha(JSON.stringify([identity, prefix, text]));
}

export async function loadLocalEncoder(directory: string): Promise<SemanticEncoder & { dispose(): Promise<void> }> {
  const assets = await verifySemanticAssets(directory);
  const { pipeline, AutoTokenizer, env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  const tokenizer = await AutoTokenizer.from_pretrained(directory, { local_files_only: true });
  const bge = assets.model !== MODEL;
  const extractor = await pipeline("feature-extraction", directory, { local_files_only: true, device: "cpu", dtype: assets.model === BGE_MODEL ? "fp32" : "q8" });
  const cache = new Map<string, number[][]>();
  const encode = async (text: string, prefix: "query" | "passage", signal?: AbortSignal): Promise<number[][]> => {
    signal?.throwIfAborted();
    const key = semanticCacheKey(assets.identity, prefix, text); const saved = cache.get(key); if (saved) return saved;
    const tokens = tokenizer(text, { add_special_tokens: false }).input_ids.tolist()[0]!.map(Number);
    const vectors: number[][] = [];
    for (const window of semanticWindows(tokens)) {
      signal?.throwIfAborted();
      const content = tokenizer.decode(window, { skip_special_tokens: true });
      const input = bge ? (prefix === "query" ? `Represent this sentence for searching relevant passages: ${content}` : content) : `${prefix}: ${content}`;
      const result = await extractor(input, { pooling: bge ? "cls" : "mean", normalize: true });
      signal?.throwIfAborted();
      const vector = Array.from(result.data, Number), norm = Math.sqrt(vector.reduce((n, v) => n + v * v, 0));
      if (vector.length !== (assets.model === BGE_BASE_MODEL ? 768 : 384) || !Number.isFinite(norm) || Math.abs(norm - 1) > 0.001) throw Error("Invalid local embedding");
      vectors.push(vector);
    }
    cache.set(key, vectors); return vectors;
  };
  const similarity = (left: number[][], right: number[][]) => Math.max(...left.flatMap(q => right.map(p => q.reduce((n, v, i) => n + v * p[i]!, 0))));
  return { identity: assets.identity, async scores(query, documents, signal) {
    const queries = await encode(query, "query", signal), scores: number[] = [];
    for (const document of documents) {
      const passages = await encode(document, "passage", signal);
      scores.push(similarity(queries, passages));
    }
    return scores;
  }, async similarities(documents, signal) {
    const vectors: number[][][] = [];
    for (const document of documents) vectors.push(await encode(document, "passage", signal));
    return vectors.map(left => vectors.map(right => similarity(left, right)));
  }, async dispose() { cache.clear(); await extractor.dispose(); } };
}
