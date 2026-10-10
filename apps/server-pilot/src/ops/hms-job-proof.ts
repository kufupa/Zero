/**
 * AE5 ops entry: prove a queued "Find booking" survives the pane and the worker, on our Labtest booking only.
 * queue = the pane's queueFind (queueUserHmsJob); status = the pane's jobStatus (readHmsJobView by run id), plus a
 * check that the pane's remount read (latest find for the confirmation on the thread) resumes the same run.
 * Nothing here writes to the database except queueUserHmsJob. Output is one JSON line.
 *
 * Labtest only. The find is a read, but a proof must not pull a real guest's stay into the database. queue refuses
 * unless the arrival passes the lab floor (2027-01-01, checkCancelInput) and the product already holds this
 * confirmation and arrival as a Labtest stay (assertLabStayGuard): a U26 form on a work item (the H2 attach proof made
 * one), or an earlier succeeded find of it. If neither exists, run the U26 prepare first (hms-attach-once.ts prepare).
 *
 * Pick a thread: an internal, non-guest inbound thread on the transport with no work item, so the job anchors to mail
 * that is not a booking. Read-only, on EC2 via SSM with the prod env loaded:
 *
 *   select t.id as thread_id, m.subject, m.from_address, m.received_at
 *     from mail_thread t
 *     join message m on m.thread_id = t.id and m.direction = 'inbound'
 *     join mailbox_transport mt on mt.id = t.transport_id
 *    where t.transport_id = '<transportId>' and t.spam_at is null
 *      and split_part(lower(m.from_address), '@', 2) = split_part(lower(mt.email), '@', 2)
 *      and not exists (select 1 from work_item w where w.thread_id = t.id)
 *    order by m.received_at desc limit 10;
 *
 * EC2 proof (HMS_JOB_QUEUE=on in the ai-worker and in this shell; HMS_LANE_PAUSED unset; cwd apps/server-pilot):
 *
 *   1. Queue:   HMS_JOB_QUEUE=on node --import tsx src/ops/hms-job-proof.ts queue --transport <transportId> \
 *                 --thread <threadId> --user <userId> --confirmation <conf> --arrival <YYYY-MM-DD>
 *               -> {"runId":"<runId>"}
 *   2. Status:  HMS_JOB_QUEUE=on node --import tsx src/ops/hms-job-proof.ts status --transport <transportId> \
 *                 --thread <threadId> --run <runId>
 *               -> the jobStatus view: status queued (with position) or running.
 *   3. While status is running: pm2 restart ai-worker. Then repeat step 2 every ~10 s.
 *               At start the worker sends a read whose claim heartbeat is over 60 s old to retrying (LEASE_LOST) at
 *               once. A restart inside 60 s of the last heartbeat leaves it running until the stale-claim timeout
 *               (AI_STALE_RUN_TIMEOUT_MS, 15 min by default), then it is reclaimed. Either way nothing is lost.
 *   4. Repeat step 2 until status is done or failed. Save the line.
 *   5. Step 2 again (a new process). The line must equal step 4's: same runId, status, attempts, asOf and result.
 *
 * Exit codes: 0 printed a line, 1 status printed null (HMS_JOB_QUEUE off), 2 refused or failed (message on stderr).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import {
  hmsJobQueueEnabled,
  hmsJobRequestSchema,
  queueUserHmsJob,
  readHmsJobView,
  type HmsJobView,
} from '../ai/hms-jobs.js';
import { parseHmsWriteForm } from '../ai/pane-hms-write.js';
import { checkCancelInput } from '../ai/pane-stay-cancel.js';
import { assertLabStayGuard } from '../ai/pane-stay-save.js';
import { HMS_JOB_PROMPT_VERSION } from '../ai/run-ledger.js';
import { resolveMailboxContext } from '../trpc/context.js';

const FLAGS = {
  queue: new Set(['--transport', '--thread', '--user', '--confirmation', '--arrival']),
  status: new Set(['--transport', '--thread', '--run']),
} as const;

export type JobProofArgs =
  | {
      command: 'queue';
      transportId: string;
      threadId: string;
      userId: string;
      confirmation: string;
      arrival: string;
    }
  | { command: 'status'; transportId: string; threadId: string; runId: string };

export function parseJobProofArgs(argv: string[]): JobProofArgs {
  const [command, ...rest] = argv;
  if (command !== 'queue' && command !== 'status') {
    throw new Error('usage: hms-job-proof.ts queue|status --flags');
  }
  const allowed: ReadonlySet<string> = FLAGS[command];
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const value = rest[index + 1];
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (value === undefined || value.startsWith('--') || value.trim() === '') {
      throw new Error(`missing value for ${flag}`);
    }
    if (values.has(flag)) throw new Error(`repeated argument: ${flag}`);
    values.set(flag, value);
  }
  const missing = [...allowed].find((flag) => !values.has(flag));
  if (missing) throw new Error(`required: ${missing}`);
  const transportId = values.get('--transport')!;
  const threadId = values.get('--thread')!;
  if (command === 'status') {
    const runId = values.get('--run')!;
    if (!z.string().uuid().safeParse(runId).success) throw new Error('--run must be a run id (uuid)');
    return { command, transportId, threadId, runId };
  }
  // The pane's own find request shape: confirmation digits-dash-digits, arrival YYYY-MM-DD.
  const request = hmsJobRequestSchema.safeParse({
    kind: 'find',
    confirmation: values.get('--confirmation'),
    arrival: values.get('--arrival'),
  });
  if (!request.success || request.data.kind !== 'find' || !request.data.arrival) {
    throw new Error('--confirmation must look like 1234567-1 and --arrival like YYYY-MM-DD');
  }
  return {
    command,
    transportId,
    threadId,
    userId: values.get('--user')!,
    confirmation: request.data.confirmation,
    arrival: request.data.arrival,
  };
}

function isLabStay(stay: { lastName: unknown; arrival: unknown }, arrival: string): boolean {
  if (typeof stay.lastName !== 'string' || stay.arrival !== arrival) return false;
  try {
    assertLabStayGuard({ lastName: stay.lastName, arrival });
    return true;
  } catch {
    return false;
  }
}

/**
 * Null when the confirmation is our Labtest booking: the lab arrival floor, and a Labtest record of it already in the
 * product (a U26 form on a work item, or an earlier succeeded find). Otherwise the refusal code.
 */
export async function labtestFindRefusal(
  input: { transportId: string; confirmation: string; arrival: string },
  db: DB = getDb(),
): Promise<string | null> {
  const shape = checkCancelInput({ confirmation: input.confirmation, arrival: input.arrival });
  if (shape) return shape;
  const forms = await db
    .select({ state: workItem.state })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, input.transportId),
        sql`${workItem.state}->>'confirmation' = ${input.confirmation}`,
      ),
    )
    .limit(20);
  if (forms.some(({ state }) => {
    const form = parseHmsWriteForm(state);
    return form !== null && isLabStay(form, input.arrival);
  })) {
    return null;
  }
  const finds = await db
    .select({ stay: sql<Record<string, unknown> | null>`${aiWorkflowRun.readResult}->'stay'` })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, input.transportId),
        eq(aiWorkflowRun.runKind, 'read_tool'),
        eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
        eq(aiWorkflowRun.state, 'succeeded'),
        sql`${aiWorkflowRun.readResult}->'stay'->>'confirmation' = ${input.confirmation}`,
      ),
    )
    .limit(20);
  return finds.some(({ stay }) => stay !== null && isLabStay(stay as { lastName: unknown; arrival: unknown }, input.arrival))
    ? null
    : 'refused_not_lab_booking';
}

export async function hmsJobProof(
  args: JobProofArgs,
  db: DB = getDb(),
  env: NodeJS.Dict<string> = process.env,
): Promise<{ runId: string } | HmsJobView | null> {
  if (args.command === 'status') {
    // The pane's jobStatus: null while the queue is off.
    if (!hmsJobQueueEnabled(env)) return null;
    const view = await readHmsJobView({ transportId: args.transportId, runId: args.runId }, db);
    if (!view) throw new Error('no hms job with that run id on this transport');
    // The pane's remount read must resume this same run from the thread.
    const remount =
      view.request?.kind === 'find'
        ? await readHmsJobView(
            {
              transportId: args.transportId,
              threadId: args.threadId,
              kind: 'find',
              confirmation: view.request.confirmation,
            },
            db,
          )
        : null;
    if (remount?.runId !== view.runId) {
      throw new Error('the thread does not resume this run (another thread, or a newer find of the confirmation)');
    }
    return view;
  }
  if (!hmsJobQueueEnabled(env)) throw new Error('HMS_JOB_QUEUE=on is required: off, the pane runs the find in place');
  // The access check the pane's mailboxProcedure makes for this user and transport.
  await resolveMailboxContext(args.userId, args.transportId, db);
  const refusal = await labtestFindRefusal(args, db);
  if (refusal) throw new Error(refusal);
  const run = await queueUserHmsJob(
    {
      transportId: args.transportId,
      userId: args.userId,
      threadId: args.threadId,
      request: { kind: 'find', confirmation: args.confirmation, arrival: args.arrival },
    },
    db,
  );
  if (!run) throw new Error('thread has no inbound mail');
  return { runId: run.id };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  Promise.resolve()
    .then(() => hmsJobProof(parseJobProofArgs(process.argv.slice(2))))
    .then(
      (result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exit(result === null ? 1 : 0);
      },
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(2);
      },
    );
}
