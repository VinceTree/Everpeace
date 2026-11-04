// Offline projection only. No provider, credential store or runtime is created.
import { readFileSync } from 'node:fs';
import { redactSecrets } from '../../src/memory/learned-memory.ts';
import { historyTurn } from '../../src/benchmark/memory-data.ts';
import { memoryIdentity } from '../../src/benchmark/memory-campaign.ts';

const { sessions, identity } = JSON.parse(readFileSync(0, 'utf8'));
const actual = await memoryIdentity();
if (actual.sourceDigest !== identity.sourceDigest || actual.revision !== identity.revision || actual.node !== identity.node) {
  throw new Error('Production projection source identity differs from the frozen campaign');
}
const projected = sessions.map(({ questionId, index, session }) => {
  const turn = historyTurn(session, 'analysis-only', `analysis:${questionId}:${index}`);
  return { questionId, index, user: redactSecrets(turn.userInput), assistant: redactSecrets(turn.assistantText),
    transcript: redactSecrets(turn.transcript, 24000), untrimmedTranscript: redactSecrets(turn.transcript, Number.MAX_SAFE_INTEGER) };
});
process.stdout.write(JSON.stringify(projected));
