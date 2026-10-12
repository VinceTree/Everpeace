import {localizeHostReport} from '../../localization/reports.js';
import {uiText,UI_CATALOGS} from '../../localization/messages.js';
import { SessionStore } from "../../storage/session-store.js";
import { SessionPrivacy } from "../../storage/session-privacy.js";

export const PRIVACY_HELP=UI_CATALOGS.en['help.privacy'];

export async function runPrivacyCommand(args: string[], privacy = new SessionPrivacy(new SessionStore()), output: (text: string) => void = (text) => { process.stdout.write(text + "\n"); }): Promise<number> {
  try {
    const [command, value, target] = args;
    if (!command || command === "--help" || command === "-h") { output(uiText('help.privacy')); return 0; }
    if (command === "status" && args.length === 1) output(localizeHostReport(await privacy.describe()));
    else if (command === "preview" && args.length === 2 && (value === "forever" || /^[1-9]\d*$/u.test(value!))) output(JSON.stringify(await privacy.preview(value === "forever" ? null : Number(value)), null, 2));
    else if (command === "configure" && args.length === 2) { await privacy.configure(value!); output(uiText('m8f6d63376f82')); }
    else if (command === "cleanup" && args.length === 2) output(JSON.stringify(await privacy.cleanup(value!)));
    else if (command === "scan" && args.length === 2) output(JSON.stringify(await privacy.scan(value!)));
    else if (command === "export" && args.length === 3) { await privacy.export(value!, target!); output(uiText('mb6a3990be654')); }
    else { output(uiText('help.privacy')); return 2; }
    return 0;
  } catch { output(uiText('mafb20a1a7a4e')); return 1; }
}
