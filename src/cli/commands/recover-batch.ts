import { createInterface } from 'node:readline/promises';
import { listFileBatches, describeFileBatch, recoverFileBatch } from '../../tools/file-batch.js';
import { uiText } from '../../localization/messages.js';
import { safeApprovalText } from '../../permissions/sensitive-access.js';

export async function runRecoverBatch(args: string[]): Promise<number> {
  if (args.length < 1 || args.length > 2) { process.stderr.write(uiText('reliability.batchUsage') + '\n'); return 2; }
  const [workspace, id] = args;
  try {
    if (!id) { process.stdout.write(JSON.stringify(await listFileBatches(workspace!), null, 2) + '\n'); return 0; }
    const preview = await describeFileBatch(workspace!, id);
    process.stdout.write(safeApprovalText(JSON.stringify(preview, null, 2)) + '\n');
    if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write(uiText('reliability.batchInteractive') + '\n'); return 2; }
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try { answer = await input.question(uiText('reliability.batchConfirm')); } finally { input.close(); }
    if (answer.trim().toLowerCase() !== 'yes') return 1;
    if (preview.digest !== (await describeFileBatch(workspace!, id)).digest) throw new Error(uiText('reliability.batchChanged'));
    const result = await recoverFileBatch(workspace!, id);
    process.stdout.write(JSON.stringify({ id: result.id, state: result.state, conflicts: result.conflicts }) + '\n');
    return result.state === 'committed' || result.state === 'rolled_back' ? 0 : 1;
  } catch (error) { process.stderr.write(safeApprovalText(error instanceof Error ? error.message : uiText('security.recoveryFailed')) + '\n'); return 1; }
}
