import type { DB } from '../db/client.js';
import { runCloudPaneAmendOnce } from './pane-cloud-amend-runner.js';
import { HMS_LABTEST_AMEND_PROMPT_VERSION, labtestAmendWorkerEnabled } from './pane-cloud-amend-readiness.js';
import { claimNextAiRun, HMS_WRITE_RUN_KIND, toAiRunFence } from './run-ledger.js';

/** Only the opt-in Labtest amend queue is claimed; generic hms_write jobs remain untouched. */
export async function runLabtestAmendOnce(options: {
  ownerId: string; db?: DB; env?: NodeJS.Dict<string>; signal?: AbortSignal;
  recovery?: { mayClaim(): Promise<boolean> };
  claim?: typeof claimNextAiRun; run?: typeof runCloudPaneAmendOnce;
}): Promise<boolean> {
  if (!labtestAmendWorkerEnabled(options.env) || options.signal?.aborted ||
      (options.recovery && !(await options.recovery.mayClaim()))) return false;
  const claimed = await (options.claim ?? claimNextAiRun)({ ownerId: options.ownerId, lane: 'hms',
    runKind: HMS_WRITE_RUN_KIND, promptVersion: HMS_LABTEST_AMEND_PROMPT_VERSION, ...(options.db ? { db: options.db } : {}) });
  if (!claimed) return false;
  const fence = toAiRunFence(claimed);
  if (!fence) return true; // The lost-lease sweep handles this claim; never retry a write.
  await (options.run ?? runCloudPaneAmendOnce)({ runId: claimed.id, fence, db: options.db, env: options.env, signal: options.signal });
  return true;
}
