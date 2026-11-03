import type { DB } from '../db/client.js';
import { runPaneHmsWriteOnce } from './pane-hms-write.js';
import { claimNextAiRun, HMS_LABTEST_ATTACH_PROMPT_VERSION, HMS_WRITE_RUN_KIND, labtestAttachEnabled, toAiRunFence } from './run-ledger.js';

/** Separate opt-in and Labtest-only switch; neither enables real-guest writes. */
export function labtestAttachWorkerEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return labtestAttachEnabled(env);
}

export async function runLabtestAttachOnce(options: {
  ownerId: string;
  db?: DB;
  env?: NodeJS.Dict<string>;
  signal?: AbortSignal;
  recovery?: { mayClaim(): Promise<boolean> };
  claim?: typeof claimNextAiRun;
  run?: typeof runPaneHmsWriteOnce;
}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!labtestAttachWorkerEnabled(env) || options.signal?.aborted ||
      (options.recovery && !(await options.recovery.mayClaim()))) return false;
  const claimed = await (options.claim ?? claimNextAiRun)({
    ownerId: options.ownerId, lane: 'hms', runKind: HMS_WRITE_RUN_KIND,
    promptVersion: HMS_LABTEST_ATTACH_PROMPT_VERSION, ...(options.db ? { db: options.db } : {}),
  });
  if (!claimed) return false;
  const fence = toAiRunFence(claimed);
  if (!fence) return true; // The lost-lease sweep handles an unusable claim; never retry it here.
  await (options.run ?? runPaneHmsWriteOnce)({ runId: claimed.id, fence, db: options.db, env });
  return true;
}
