import path from "node:path";
import { DEFAULT_MEMORY_CONFIG, parseMemoryConfig, prepareMemoryCampaign, preflightMemoryCampaign, runMemoryCampaign } from "./memory-campaign.js";
import { readJson } from "./memory-evidence.js";
import { memoryReport } from "./memory-report.js";

const [command, rootArg, ...args] = process.argv.slice(2).filter(a => a !== "--");
if (!rootArg || !path.isAbsolute(rootArg) || !["prepare", "preflight", "run", "resume", "report"].includes(command ?? "")) throw Error("Usage: pnpm benchmark:memory-batch <prepare|preflight|run|resume|report> <absolute evidence root> [--config file] [--live]");
const root = path.resolve(rootArg);
if (command === "prepare") {
  const index = args.indexOf("--config");
  const config = index < 0 ? DEFAULT_MEMORY_CONFIG : parseMemoryConfig(await readJson(args[index + 1]!));
  const cacheIndex = args.indexOf("--data-cache");
  const parentIndex = args.indexOf("--continue-from");
  if (parentIndex >= 0 && !path.isAbsolute(args[parentIndex + 1] ?? "")) throw Error("--continue-from requires an absolute stopped campaign root");
  await prepareMemoryCampaign(root, config, cacheIndex < 0 ? undefined : args[cacheIndex + 1], parentIndex < 0 ? undefined : args[parentIndex + 1], args.includes("--continue-unrun"));
} else if (command === "preflight") await preflightMemoryCampaign(root);
else if (command === "report") await memoryReport(root);
else {
  if (!args.includes("--live")) throw Error("Live execution requires explicit --live");
  await runMemoryCampaign(root, command === "resume");
}
