/**
 * Legacy U28-H2 entry. Prepare can still read a snapshot, but the server write runner refuses legacy attachment
 * execution even when ATTACH_VERIFIED is set. A previously claimed operation may have dispatched before this guard;
 * disabling new calls does not close an old browser or replace reconciliation of an uncertain outcome.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import {
  paneHmsWriteLoaders,
  parseHmsWriteForm,
  prepareHmsWriteSnapshot,
  runPaneHmsWriteOnce,
} from '../ai/pane-hms-write.js';
import { claimNextAiRun, HMS_WRITE_RUN_KIND, toAiRunFence } from '../ai/run-ledger.js';

const COMMANDS = new Set(['prepare', 'run']);
const FLAGS: Record<string, ReadonlySet<string>> = {
  prepare: new Set(['--transport', '--work-item']),
  run: new Set(['--transport', '--work-item', '--run', '--confirmation', '--file']),
};
const OPTIONAL = new Set(['--file']);

export type AttachOnceArgs =
  | { command: 'prepare'; transportId: string; workItemId: string }
  | {
      command: 'run';
      transportId: string;
      workItemId: string;
      runId: string;
      confirmation: string;
      file: string | null;
    };

export function parseAttachOnceArgs(argv: string[]): AttachOnceArgs {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.has(command)) throw new Error('usage: hms-attach-once.ts prepare|run --flags');
  const allowed = FLAGS[command]!;
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const value = rest[index + 1];
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (values.has(flag)) throw new Error(`repeated argument: ${flag}`);
    values.set(flag, value);
  }
  const missing = [...allowed].find((flag) => !OPTIONAL.has(flag) && !values.has(flag));
  if (missing) throw new Error(`required: ${missing}`);
  const transportId = values.get('--transport')!;
  const workItemId = values.get('--work-item')!;
  if (command === 'prepare') return { command, transportId, workItemId };
  return {
    command: 'run',
    transportId,
    workItemId,
    runId: values.get('--run')!,
    confirmation: values.get('--confirmation')!,
    file: values.get('--file') ?? null,
  };
}

async function loadAttachForm(transportId: string, workItemId: string) {
  const [item] = await getDb()
    .select({ state: workItem.state })
    .from(workItem)
    .where(and(eq(workItem.id, workItemId), eq(workItem.transportId, transportId)))
    .limit(1);
  const form = item ? parseHmsWriteForm(item.state) : null;
  if (!form || form.action !== 'attach_document') throw new Error('work item is not an attach form');
  return form;
}

export async function attachOnce(args: AttachOnceArgs): Promise<unknown> {
  const form = await loadAttachForm(args.transportId, args.workItemId);
  if (args.command === 'prepare') {
    return prepareHmsWriteSnapshot({
      transportId: args.transportId,
      workItemId: args.workItemId,
      confirmation: form.confirmation,
      arrival: form.arrival,
    });
  }
  // The operator names the booking, and it must be the approved form's. The runner re-checks Labtest on HMS.
  if (form.confirmation !== args.confirmation) throw new Error('confirmation does not match the approved form');
  if (process.env.ATTACH_VERIFIED !== 'true') throw new Error('ATTACH_VERIFIED=true is required for this run');
  const [queued] = await getDb()
    .select({ idempotencyKey: aiWorkflowRun.idempotencyKey })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.id, args.runId),
        eq(aiWorkflowRun.transportId, args.transportId),
        eq(aiWorkflowRun.workItemId, args.workItemId),
        eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
        eq(aiWorkflowRun.state, 'queued'),
      ),
    )
    .limit(1);
  if (!queued) throw new Error('no queued hms_write run with that id for this work item');
  // The idempotency key is hms-write:<grantId>, unique per run, so the claim can take only this run.
  const claimed = await claimNextAiRun({
    ownerId: `ops-hms-attach-once-${process.pid}`,
    lane: 'hms',
    runKind: HMS_WRITE_RUN_KIND,
    transportId: args.transportId,
    idempotencyPrefix: queued.idempotencyKey,
  });
  const fence = claimed?.id === args.runId ? toAiRunFence(claimed) : null;
  if (!fence) throw new Error('claim failed (lane paused in this process, or the run is no longer queued)');
  if (args.file) {
    const file = resolve(args.file);
    paneHmsWriteLoaders.readAttachment = async () => readFile(file).catch(() => 'attachment_not_found');
  }
  return runPaneHmsWriteOnce({ runId: args.runId, fence });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  attachOnce(parseAttachOnceArgs(process.argv.slice(2))).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      const ok =
        typeof result === 'object' &&
        result !== null &&
        ['succeeded', 'stored'].includes((result as { status?: string }).status ?? '');
      process.exit(ok ? 0 : 1);
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
