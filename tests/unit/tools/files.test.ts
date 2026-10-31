import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FileSearchSession, fileSearchLimits, runFileTool } from "../../../src/tools/files.js";

test("bundled search works without PATH and ignores RIPGREP_CONFIG_PATH", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-files-rg-config-"));
  const root = path.join(parent, "中文 空格 workspace");
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "expected.txt"), "needle\n", "utf8");
    const config = path.join(parent, "rg-config");
    await fs.writeFile(config, "--glob=!*.txt\n--ignore-case\n", "utf8");
    const source = [
      'const { runFileTool } = await import("./src/tools/files.ts");',
      "const root = process.argv[1];",
      'const search = await runFileTool("search_files", JSON.stringify({ query: "needle", glob: "*.txt" }), root);',
      'const mismatchedCase = await runFileTool("search_files", JSON.stringify({ query: "NEEDLE", glob: "*.txt" }), root);',
      'const glob = await runFileTool("glob_files", JSON.stringify({ pattern: "*.txt" }), root);',
      "process.stdout.write(JSON.stringify({ search, mismatchedCase, glob }));",
    ].join("\n");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLocaleLowerCase() !== "path"));
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source, root], {
      cwd: process.cwd(),
      env: { ...env, PATH: "", RIPGREP_CONFIG_PATH: config },
      windowsHide: true,
      timeout: 15_000,
    });
    const result = JSON.parse(stdout) as { search: { matches: Array<{ path: string }> }; mismatchedCase: { matches: unknown[] }; glob: { files: string[] } };
    assert.deepEqual(result.search.matches.map((match) => path.posix.normalize(match.path)), ["expected.txt"]);
    assert.deepEqual(result.mismatchedCase.matches, []);
    assert.deepEqual(result.glob.files.map((value) => path.posix.normalize(value)), ["expected.txt"]);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("search surfaces an injected bundled ripgrep availability error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-files-rg-missing-"));
  try {
    const missing = async () => { throw new Error("Bundled ripgrep fixture is unavailable"); };
    await assert.rejects(
      runFileTool("search_files", JSON.stringify({ query: "needle" }), root, undefined, undefined, missing),
      /Bundled ripgrep fixture is unavailable/iu,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("search cancellation while resolving bundled ripgrep prevents process launch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-files-rg-cancel-"));
  try {
    let markResolving!: () => void;
    let releaseResolver!: (value: string) => void;
    const resolving = new Promise<void>((resolve) => { markResolving = resolve; });
    const executable = new Promise<string>((resolve) => { releaseResolver = resolve; });
    const controller = new AbortController();
    const pending = runFileTool(
      "search_files",
      JSON.stringify({ query: "needle" }),
      root,
      controller.signal,
      undefined,
      () => {
        markResolving();
        return executable;
      },
    );
    await resolving;
    controller.abort(new Error("cancel bundled search"));
    releaseResolver(process.execPath);
    await assert.rejects(pending, /cancel bundled search/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("file tools read and list within the workspace and reject escapes and unsupported content", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-files-"));
  const root = path.join(parent, "workspace");
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "hello.txt"), "hello");
    await fs.writeFile(path.join(parent, "outside.txt"), "private");
    await fs.writeFile(path.join(root, "binary"), Buffer.from([0, 1]));
    await fs.writeFile(path.join(root, "large"), "x".repeat(16 * 1024 * 1024 + 1));
    const read = await runFileTool("read_file", '{"path":"hello.txt"}', root) as Record<string, unknown>;
    assert.equal(read.content, "hello");
    assert.equal(read.exists, true);
    assert.equal(read.start_line, 1);
    assert.equal(read.next_line, null);
    assert.match(String(read.sha256), /^[a-f0-9]{64}$/u);
    const listing = await runFileTool("list_directory", '{"path":"."}', root) as { entries: unknown[] };
    assert.equal(listing.entries.length, 3);
    for (const name of ["../outside.txt", path.join(parent, "outside.txt")]) {
      await assert.rejects(runFileTool("read_file", JSON.stringify({ path: name }), root), /workspace/);
    }
    await fs.symlink(parent, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(runFileTool("read_file", '{"path":"escape/outside.txt"}', root), { code: 'POLICY_DENIED' });
    await assert.rejects(runFileTool("read_file", '{"path":"binary"}', root), /Binary/);
    await assert.rejects(runFileTool("read_file", '{"path":"large"}', root), /limit/);
    await assert.rejects(runFileTool("read_file", '{"path":"."}', root));
    await assert.rejects(runFileTool("read_file", '{"path":3}', root), /Invalid/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("file tools page large text and search Unicode paths without a shell", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-files-page-"));
  try {
    await fs.mkdir(path.join(root, "源码"));
    await fs.writeFile(path.join(root, "源码", "长文件.ts"), Array.from({ length: 450 }, (_, index) => `line ${index + 1} needle`).join("\n"));
    await fs.writeFile(path.join(root, "源码", "other.js"), "needle\n");
    const first = await runFileTool("read_file", JSON.stringify({ path: "源码/长文件.ts", start_line: 201, max_lines: 50 }), root) as Record<string, unknown>;
    assert.equal(first.start_line, 201);
    assert.equal(first.end_line, 250);
    assert.equal(first.next_line, 251);
    assert.match(String(first.content), /^line 201 needle/u);
    assert.match(String(first.content), /line 250 needle$/u);

    const search = await runFileTool("search_files", JSON.stringify({ query: "needle", path: "源码", glob: "*.ts", max_results: 3 }), root) as { matches: Array<{ path: string; line: number }>; truncated: boolean };
    assert.equal(search.matches.length, 3);
    assert.ok(search.matches.every((match) => match.path.endsWith("源码/长文件.ts")));
    assert.equal(search.truncated, true);

    const glob = await runFileTool("glob_files", JSON.stringify({ pattern: "*.ts", path: "源码" }), root) as { files: string[] };
    assert.deepEqual(glob.files, ["源码/长文件.ts"]);
    const missing = await runFileTool("read_file", JSON.stringify({ path: "源码/missing.ts" }), root) as Record<string, unknown>;
    assert.equal(missing.exists, false);
    assert.equal(missing.sha256, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("read_file versions UTF-8 BOM files from their original bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-files-bom-"));
  try {
    const bytes = Buffer.from("\ufefffirst\r\nsecond\r\n", "utf8");
    await fs.writeFile(path.join(root, "bom.txt"), bytes);
    const read = await runFileTool("read_file", JSON.stringify({ path: "bom.txt" }), root) as Record<string, unknown>;
    assert.equal(read.content, "first\r\nsecond\r\n");
    assert.equal(read.sha256, createHash("sha256").update(bytes).digest("hex"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("search continuations traverse more than 200 retained Unicode results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-files-search-pages-"));
  try {
    await fs.mkdir(path.join(root, "源码"));
    await fs.writeFile(path.join(root, "源码", "many.ts"), Array.from({ length: 450 }, (_, index) => `const value${index} = "needle";`).join("\n"));
    const searches = new FileSearchSession();
    const first = await runFileTool(
      "search_files",
      JSON.stringify({ query: "needle", path: "源码", max_results: 200 }),
      root,
      undefined,
      searches,
    ) as { matches: Array<{ path: string }>; continuation: string | null; incomplete: boolean };
    assert.equal(first.matches.length, 200);
    assert.ok(first.matches.every((match) => match.path.endsWith("源码/many.ts")));
    assert.equal(first.incomplete, false);
    assert.ok(first.continuation);

    const second = await runFileTool(
      "read_search_results",
      JSON.stringify({ continuation: first.continuation, max_results: 200 }),
      root,
      undefined,
      searches,
    ) as { matches: unknown[]; continuation: string | null };
    assert.equal(second.matches.length, 200);
    assert.ok(second.continuation);
    const third = await runFileTool(
      "read_search_results",
      JSON.stringify({ continuation: second.continuation, max_results: 200 }),
      root,
      undefined,
      searches,
    ) as { matches: unknown[]; continuation: string | null };
    assert.equal(third.matches.length, 50);
    assert.equal(third.continuation, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("search continuations evict oldest retained searches by count and UTF-8 payload bytes", () => {
  const countBounded = new FileSearchSession();
  const references: string[] = [];
  for (let index = 0; index < fileSearchLimits.maxRetainedSearches + 1; index += 1) {
    const page = countBounded.page("files", [`${index}-first`, `${index}-second`], 1, false);
    references.push(page.continuation!);
  }
  assert.throws(() => countBounded.next(references[0]!, 1), /unknown or expired/iu);
  assert.deepEqual(countBounded.next(references.at(-1)!, 1).items, [`${fileSearchLimits.maxRetainedSearches}-second`]);

  const byteBounded = new FileSearchSession();
  const bytesPerSearch = Math.floor(fileSearchLimits.maxRetainedSearchBytes / 4);
  const byteReferences = Array.from({ length: 5 }, (_, index) => byteBounded.page(
    "files",
    [`${index}-${"界".repeat(Math.ceil(bytesPerSearch / 3))}`, `${index}-tail`],
    1,
    false,
  ).continuation!);
  assert.throws(() => byteBounded.next(byteReferences[0]!, 1), /unknown or expired/iu);
  assert.deepEqual(byteBounded.next(byteReferences.at(-1)!, 1).items, ["4-tail"]);
});

test("search bounds a long unterminated ripgrep record and reports incomplete results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-files-long-search-"));
  try {
    await fs.writeFile(path.join(root, "long.txt"), `needle ${"x".repeat(fileSearchLimits.maxSearchBytes + 128 * 1024)}`, "utf8");
    const result = await runFileTool("search_files", JSON.stringify({ query: "needle" }), root, undefined, new FileSearchSession()) as {
      matches: unknown[];
      incomplete: boolean;
      has_more: boolean;
    };
    assert.equal(result.incomplete, true);
    assert.equal(result.has_more, false);
    assert.deepEqual(result.matches, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
