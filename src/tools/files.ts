import { constants, promises as fs } from "node:fs";
import path from "node:path";

export const FILE_TOOL_DEFINITIONS = ["read_file", "list_directory"].map((name) => ({
  type: "function" as const,
  name,
  description: name === "read_file"
    ? "Read a UTF-8 text file inside the current workspace (maximum 128 KiB)."
    : "List up to 500 entries in a directory inside the current workspace. Does not recurse.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Workspace-relative path; use . for the workspace directory." } },
    required: ["path"],
    additionalProperties: false,
  },
  strict: true,
}));

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export async function runFileTool(name: string, argumentsJson: string, workspace: string): Promise<unknown> {
  const args: unknown = JSON.parse(argumentsJson);
  if (!args || typeof args !== "object" || !("path" in args) || typeof args.path !== "string" || !args.path.trim() || args.path.includes("\0")) {
    throw new Error("Invalid file tool arguments");
  }
  if (name !== "read_file" && name !== "list_directory") throw new Error("Unsupported file tool");
  // Check both lexical and resolved paths so traversal and symlink escapes fail closed.
  const root = await fs.realpath(workspace);
  const lexical = path.resolve(workspace, args.path);
  if (!inside(path.resolve(workspace), lexical)) throw new Error("File access is limited to the current workspace");
  const target = await fs.realpath(lexical);
  if (!inside(root, target)) throw new Error("File access is limited to the current workspace");
  if (process.platform === "win32" && path.relative(root, target).includes(":")) throw new Error("Alternate data streams are not supported");
  if (name === "list_directory") {
    const entries: Array<{ name: string; type: string }> = [];
    const directory = await fs.opendir(target);
    let truncated = false;
    for await (const entry of directory) {
      if (entries.length === 500) { truncated = true; break; }
      entries.push({ name: entry.name, type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file" });
    }
    return { path: args.path, entries, truncated };
  }
  if (!(await fs.stat(target)).isFile()) throw new Error("Only regular text files can be read");
  const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const handle = await fs.open(target, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Only regular text files can be read");
    if (stat.size > 131072) throw new Error("File exceeds the 128 KiB read limit");
    const buffer = Buffer.alloc(131073);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 131072) throw new Error("File exceeds the 128 KiB read limit");
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) throw new Error("Binary files are not supported");
    return { path: args.path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } finally {
    await handle.close();
  }
}
