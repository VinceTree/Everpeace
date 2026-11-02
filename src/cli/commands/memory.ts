import { uiText, UI_CATALOGS } from "../../localization/messages.js";
import { LearnedMemoryStore, memoryEntryRevision, parseMemoryCorrection, type LearnedScope, type MemoryCandidateAction } from "../../memory/learned-memory.js";

export const MEMORY_HELP = UI_CATALOGS.en["help.memory"];
export async function runMemoryCommand(args: string[], store = new LearnedMemoryStore(), workspace = process.cwd(), output: (text: string) => void = text => process.stdout.write(text + "\n")): Promise<number> {
  try {
    const [action, scope, id, revision, correction] = args;
    if (!action || ["--help", "-h"].includes(action)) { output(uiText("help.memory")); return 0; }
    if (action === "list" && args.length === 1) { output(JSON.stringify(await store.status(workspace), null, 2)); return 0; }
    if (action === "candidates") {
      if ((!scope || scope === "list") && args.length <= 2) { output(JSON.stringify(await store.listReviewCandidates(workspace), null, 2)); return 0; }
      if (scope === "inspect" && id && (args.length === 3 || args.length === 4)) {
        output(JSON.stringify(await store.previewCandidate(workspace, id, revision ? parseMemoryCorrection(revision) : undefined), null, 2)); return 0;
      }
      if (!scope || !id || !revision || !["accept", "correct", "reject"].includes(scope) || args.length !== (scope === "correct" ? 5 : 4)) throw new Error(uiText("me39d34adfa7a"));
      await store.reviewCandidate(workspace, id, revision, scope as MemoryCandidateAction, correction ? parseMemoryCorrection(correction) : undefined);
      output(uiText("m739cc90f3dba")); return 0;
    }
    if (!["project", "user"].includes(scope ?? "")) throw new Error(uiText("m5235360f15ec"));
    const learnedScope = scope as LearnedScope;
    const entry = (await store.read(learnedScope, workspace)).find(item => item.id === id);
    if (!entry) throw new Error(uiText("mf36668ddf224"));
    if (action === "inspect" && args.length === 3) { output(JSON.stringify({ entry, revision: memoryEntryRevision(entry) }, null, 2)); return 0; }
    if (!revision || !["renew", "disable", "delete", "correct"].includes(action) || args.length !== (action === "correct" ? 5 : 4)) throw new Error(uiText("me39d34adfa7a"));
    await store.reviewEntry(learnedScope, workspace, id!, revision, action as "renew" | "disable" | "delete" | "correct", correction ? parseMemoryCorrection(correction) : undefined);
    output(uiText("m739cc90f3dba")); return 0;
  } catch { output(uiText("md387a1210a1c")); return 1; }
}
