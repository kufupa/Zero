import { readFileSync } from 'node:fs';
import {
  askNavaHermes,
  ensureNavaCorpusChat,
  NAVA_HERMES_ASK_TIMEOUT_MS,
} from '../apps/server-pilot/src/ops/nava-hermes-bridge.ts';
import type { NavaDashboard } from '../apps/server-pilot/src/ops/nava-fte-dashboard.ts';
import {
  NAVA_CORPUS_SESSION_DEFAULT,
  hermesCorpusPosturePrompt,
} from '../apps/server-pilot/src/ops/nava-live-context.ts';

async function main(): Promise<void> {
  const dash = JSON.parse(
    readFileSync('docs/infor-hms/nava-fte-dashboard.json', 'utf8'),
  ) as NavaDashboard;
  const hermesHome = '/home/ubuntu/.hermes/profiles/zero';
  const sessionFile = '.private/connected-mailbox-corpus/nava-hermes-session.id';
  const corpusId =
    process.env.NAVA_HERMES_SESSION?.trim() || NAVA_CORPUS_SESSION_DEFAULT;

  const seed = await ensureNavaCorpusChat({
    hermesHome,
    cwd: process.cwd(),
    corpusSessionId: corpusId,
    posturePrompt: hermesCorpusPosturePrompt(dash),
    sessionFile,
    timeoutMs: NAVA_HERMES_ASK_TIMEOUT_MS,
  });
  console.log('SEED_OK', seed.ok, 'SID', seed.sessionId);
  console.log('SEED_TEXT', seed.text.slice(0, 300));
  if (!seed.sessionId) process.exit(1);

  const ans = await askNavaHermes({
    hermesHome,
    cwd: process.cwd(),
    sessionId: seed.sessionId,
    question: 'In one sentence: why is security quarantine not spam?',
    timeoutMs: NAVA_HERMES_ASK_TIMEOUT_MS,
  });
  console.log('ASK_OK', ans.ok);
  console.log('ASK_TEXT', ans.text.slice(0, 500));
  if (!ans.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
