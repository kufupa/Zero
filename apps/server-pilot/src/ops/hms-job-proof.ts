/**
 * AE5 ops entry: prove a queued "Find booking" survives the pane and the worker, on our Labtest booking.
 * queue = the pane's queueFind (queueUserHmsJob); status = the pane's jobStatus (readHmsJobView by run id), plus a
 * check that the pane's remount read (latest find for the confirmation on the thread) resumes the same run.
 * Nothing here writes to the database except queueUserHmsJob. Output is one JSON line.
 *
 * A find is a read, which the pane already runs for staff without approval. queue checks the user's mailbox access
 * (the pane's mailboxProcedure) and refuses an arrival before the lab floor (2027-01-01, checkCancelInput). status
 * never prints guest fields: only state, timestamps, attempts, found yes/no, confirmation, arrival and
 * lastNameIsLabtest. When the found booking is not Labtest it prints {"labtest":false} and nothing else.
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
 * EC2 proof (HMS_JOB_QUEUE=on in the ai-worker, which claims pane jobs, and in this shell; HMS_LANE_PAUSED unset;
 * cwd apps/server-pilot):
 *
 *   1. Queue:   HMS_JOB_QUEUE=on node --import tsx src/ops/hms-job-proof.ts queue --transport <transportId> \
 *                 --thread <threadId> --user <userId> --confirmation <conf> --arrival <YYYY-MM-DD>
 *               -> {"runId":"<runId>"}
 *   2. Status:  HMS_JOB_QUEUE=on node --import tsx src/ops/hms-job-proof.ts status --transport <transportId> \
 *                 --thread <threadId> --run <runId>
 *               -> {"runId",status,position,attempts,failureClass,asOf,found,confirmation,arrival,lastNameIsLabtest}
 *   3. As soon as status is running: pm2 stop ai-worker; sleep 70; pm2 start ai-worker. Then repeat step 2.
 *               The worker heartbeats a running job every 20 s. At start it sends a read whose heartbeat is over 60 s
 *               old back to retrying (failureClass LEASE_LOST, fresh deadline), and it runs again within seconds.
 *               Do not use pm2 restart: the new worker sees a fresh heartbeat and leaves the run alone until the
 *               stale-claim timeout (AI_STALE_RUN_TIMEOUT_MS, 15 min), and by then the claim deadline
 *               (HMS_RUN_DEADLINE_MS, 150 s) has passed, so the reclaim fails it as RUN_DEADLINE.
 *   4. Repeat step 2 until status is done or failed. Save the line.
 *   5. Step 2 again (a new process). The line must equal step 4's.
 *
 * Exit codes: 0 printed a line, 1 status printed null (HMS_JOB_QUEUE off), 2 refused or failed (message on stderr),
 * 3 the found booking is not Labtest (printed {"labtest":false}).
 */
import {
  hmsJobQueueEnabled,
  hmsJobRequestSchema,
  queueUserHmsJob,
  readHmsJobView,
  type HmsJobView,
} from '../ai/hms-jobs.js';
import { checkCancelInput } from '../ai/pane-stay-cancel.js';
import { resolveMailboxContext } from '../trpc/context.js';
import { getDb, type DB } from '../db/client.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';

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
    if (!z.string().uuid().safeParse(runId).success)
      throw new Error('--run must be a run id (uuid)');
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

/** What status prints: the job's state and the find's outcome, never the guest. */
export type ProofStatusLine =
  | { labtest: false }
  | {
      runId: string;
      status: HmsJobView['status'];
      position: number | null;
      attempts: number;
      failureClass: string | null;
      asOf: string | null;
      found: boolean;
      confirmation: string | null;
      arrival: string | null;
      lastNameIsLabtest: boolean;
    };

const LABTEST = /^labtest$/i;

export function proofStatusLine(view: HmsJobView): ProofStatusLine {
  const result = view.result;
  const stay =
    result?.outcome === 'found' && result.stay && typeof result.stay === 'object'
      ? (result.stay as Record<string, unknown>)
      : null;
  const lastNameIsLabtest =
    typeof stay?.lastName === 'string' && LABTEST.test(stay.lastName.trim());
  if (stay && !lastNameIsLabtest) return { labtest: false };
  const request = view.request?.kind === 'find' ? view.request : null;
  const text = (value: unknown, fallback: string | null | undefined) =>
    typeof value === 'string' ? value : (fallback ?? null);
  return {
    runId: view.runId,
    status: view.status,
    position: view.position,
    attempts: view.attempts,
    failureClass: view.failureClass,
    asOf: view.asOf,
    found: stay !== null,
    confirmation: text(stay?.confirmation, request?.confirmation),
    arrival: text(stay?.arrival, request?.arrival),
    lastNameIsLabtest,
  };
}

export async function hmsJobProof(
  args: JobProofArgs,
  db: DB = getDb(),
  env: NodeJS.Dict<string> = process.env,
): Promise<{ runId: string } | ProofStatusLine | null> {
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
      throw new Error(
        'the thread does not resume this run (another thread, or a newer find of the confirmation)',
      );
    }
    return proofStatusLine(view);
  }
  if (!hmsJobQueueEnabled(env))
    throw new Error('HMS_JOB_QUEUE=on is required: off, the pane runs the find in place');
  // The access check the pane's mailboxProcedure makes for this user and transport.
  await resolveMailboxContext(args.userId, args.transportId, db);
  const refusal = checkCancelInput({ confirmation: args.confirmation, arrival: args.arrival });
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
        process.exit(result === null ? 1 : 'labtest' in result ? 3 : 0);
      },
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(2);
      },
    );
}
