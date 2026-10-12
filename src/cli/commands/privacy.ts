import { SessionStore } from "../../storage/session-store.js";
import { SessionPrivacy } from "../../storage/session-privacy.js";

export const PRIVACY_HELP = `Local Session privacy (no model or keyring access)
  everpeace privacy status
  everpeace privacy preview <forever|days>
  everpeace privacy configure <preview-token>
  everpeace privacy cleanup <preview-token>
  everpeace privacy scan <session-id>
  everpeace privacy export <session-id> <new-file>
Preview tokens expire after ten minutes and are consumed once.
Export defaults to metadata only. Use /privacy for reviewed conversation export.`;

export async function runPrivacyCommand(args: string[], privacy = new SessionPrivacy(new SessionStore()), output: (text: string) => void = (text) => { process.stdout.write(text + "\n"); }): Promise<number> {
  try {
    const [command, value, target] = args;
    if (!command || command === "--help" || command === "-h") { output(PRIVACY_HELP); return 0; }
    if (command === "status" && args.length === 1) output(await privacy.describe());
    else if (command === "preview" && args.length === 2 && (value === "forever" || /^[1-9]\d*$/u.test(value!))) output(JSON.stringify(await privacy.preview(value === "forever" ? null : Number(value)), null, 2));
    else if (command === "configure" && args.length === 2) { await privacy.configure(value!); output("Retention configured. Automatic cleanup runs at startup or idle, at most once per day."); }
    else if (command === "cleanup" && args.length === 2) output(JSON.stringify(await privacy.cleanup(value!)));
    else if (command === "scan" && args.length === 2) output(JSON.stringify(await privacy.scan(value!)));
    else if (command === "export" && args.length === 3) { await privacy.export(value!, target!); output("Diagnostic summary exported."); }
    else { output(PRIVACY_HELP); return 2; }
    return 0;
  } catch { output("Privacy operation failed. Preview may have changed, a Session may be active, or storage may be unavailable. No complete-cleanup result was recorded."); return 1; }
}
