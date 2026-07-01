/**
 * Ingest worker singleton.
 *
 * One `ingestOnce()` cycle:
 *   1. Connect POP3 (real or fake).
 *   2. UIDL — list pending message ids.
 *   3. For each message (bounded by `POP3_MAX_MESSAGES_PER_CYCLE`):
 *        a. RETR — fetch raw MIME.
 *        b. PUT raw MIME to S3 (`raw-mime/...`).
 *        c. Parse with streaming MailParser; attachments stream to S3
 *           (`attachments/...`) during parse.
 *        d. PG transaction — insert `message` + `attachment` (or quarantine)
 *           and commit.
 *        e. DELE the POP3 message **only after** S3 + PG commit succeed
 *           (or the message is a duplicate / already safely stored).
 *   4. QUIT — commit pending DELEs and close the session.
 *
 * Safety invariants:
 *   - Never DELE unless S3 raw MIME PUT + PG commit succeed, OR the UIDL is
 *     already stored (duplicate — safe to drain).
 *   - If any step fails for one message, log + continue to the next; the
 *     message is NOT DELEd and will be retried on the next cycle.
 *   - If the POP3 client is a fake, DELE is a no-op recorded in the fake
 *     (still calls dele so the contract is exercised and tests can assert
 *     order).
 *
 * Singleton loop: `runWorker(opts)` calls `ingestOnce()` on
 * `POP3_POLL_INTERVAL_MS`. SIGTERM triggers a graceful stop after the
 * current cycle finishes. Exits 0 on SIGTERM/SIGINT.
 *
 * Entry: `node dist/mail/ingest/worker.js` (package script `worker`).
 */
import { parseEnv } from '../../env.js';
import { getDb, closeDb } from '../../db/client.js';
import {
  createPop3Client,
  type Pop3Client,
  type FakePop3Client,
  FakePop3Client as FakePop3ClientCtor,
  type FakePop3Message,
} from './pop3-client.js';
import { parseRawMessage, generateMessageId } from './parse-message.js';
import { IngestTooLargeError } from './limits.js';
import {
  persistInboundMessage,
  quarantineOversizedMessage,
  type PersistResult,
} from './store.js';
import { rawMimeKey, getS3Storage } from '../../storage/s3.js';

export interface IngestOnceOptions {
  /** Injected POP3 client (real or fake). If absent, built from env. */
  pop3?: Pop3Client;
  /** Injected DB handle. If absent, uses the module-level getDb(). */
  db?: import('../../db/client.js').DB;
  /** Ingest mailbox id to scope raw-mime S3 keys and quarantine rows. */
  ingestMailboxId?: string;
  /** Max messages per cycle. Defaults to env `POP3_MAX_MESSAGES_PER_CYCLE`. */
  maxMessages?: number;
}

export type ItemOutcome =
  | { uidl: string; result: PersistResult; status: 'ok' }
  | { uidl: string; status: 'error'; error: string };

export interface IngestCycleResult {
  /** Number of messages UIDL-listed. */
  listed: number;
  /** Number of messages processed (RETR + persist attempted). */
  processed: number;
  /** Number of messages DELEd (committed for deletion). */
  deled: number;
  /** Per-message outcomes. */
  items: ItemOutcome[];
  /** Whether the POP3 client was the fake/fixture path. */
  usedFakePop3: boolean;
  /** Error that aborted the whole cycle, if any. */
  cycleError?: string;
}

/**
 * Run one ingest cycle. Returns a structured result; never throws
 * (cycle-level errors are captured in `cycleError`).
 *
 * Safety order per message:
 *   UIDL -> RETR -> raw MIME S3 PUT -> attachment S3 PUT (during parse)
 *          -> PG tx -> DELE
 * Final QUIT commits the DELEs.
 */
export async function ingestOnce(
  opts: IngestOnceOptions = {},
): Promise<IngestCycleResult> {
  // Parse env defensively — when POP3 is injected (tests/fake path) we do not
  // require the full production env surface.
  let env: ReturnType<typeof parseEnv> | null = null;
  try {
    env = parseEnv(process.env);
  } catch {
    env = null;
  }
  const ingestMailboxId = opts.ingestMailboxId ?? 'ingest-nava-legacy';
  const maxMessages =
    opts.maxMessages ?? env?.POP3_MAX_MESSAGES_PER_CYCLE ?? 500;

  const pop3 = opts.pop3 ?? (env ? createPop3Client(env) : null);
  const usedFakePop3 = pop3?.kind === 'fake';

  // No real POP3 configured and no fake injected -> nothing to do.
  if (!pop3) {
    return {
      listed: 0,
      processed: 0,
      deled: 0,
      items: [],
      usedFakePop3: false,
      cycleError: 'no pop3 client configured',
    };
  }

  const items: ItemOutcome[] = [];
  let listed = 0;
  let processed = 0;
  let deled = 0;

  try {
    await pop3.connect();
    const uidls = await pop3.listUidl();
    listed = uidls.length;

    const storage = getS3Storage();
    const db = opts.db ?? getDb();

    for (const uidl of uidls.slice(0, maxMessages)) {
      let rawKey: string | undefined;
      try {
        // RETR
        const msg = await pop3.retr(uidl);

        // Pre-generate a message id for attachment keying.
        const messageId = generateMessageId();

        // Pre-upload raw MIME to S3 BEFORE parsing/attachments.
        rawKey = rawMimeKey({
          ingestMailboxId,
          pop3Uidl: uidl,
          receivedAt: new Date(),
        });
        await storage.putObject({
          key: rawKey,
          body: msg.raw,
          contentType: 'message/rfc822',
        });

        // Parse (attachments stream to S3 during parse). The same `messageId`
        // namespaces the attachment S3 keys (`attachments/{messageId}/...`).
        const parsed = await parseRawMessage(msg.raw, {
          messageId,
          storage,
        });

        // PG transaction (the commit that authorizes DELE). Thread the SAME
        // messageId into meta so store.ts reuses it as the DB `message.id`
        // (S3 attachment key prefix == DB message.id).
        const result = await persistInboundMessage(parsed, msg.raw, {
          ingestMailboxId,
          pop3Uidl: uidl,
          messageId,
          rawMimeS3Key: rawKey,
        }, { db, storage });

        // DELE only after S3 + PG commit (or duplicate).
        await pop3.dele(uidl);
        deled += 1;
        items.push({ uidl, result, status: 'ok' });
        processed += 1;
      } catch (err) {
        if (err instanceof IngestTooLargeError && rawKey) {
          const result = await quarantineOversizedMessage(
            { ingestMailboxId, pop3Uidl: uidl },
            rawKey,
            { db },
          );
          await pop3.dele(uidl);
          deled += 1;
          items.push({ uidl, result, status: 'ok' });
          processed += 1;
          continue;
        }
        const error = err instanceof Error ? err.message : String(err);
        items.push({ uidl, status: 'error', error });
        processed += 1;
        // Do NOT DELE — message stays on server for next cycle.
      }
    }

    await pop3.quit();
    return { listed, processed, deled, items, usedFakePop3 };
  } catch (err) {
    const cycleError = err instanceof Error ? err.message : String(err);
    await pop3.close().catch(() => undefined);
    return { listed, processed, deled, items, usedFakePop3, cycleError };
  }
}

/**
 * Build a `FakePop3Client` from fixture messages. Exported so the worker
 * entry script can run the fixture/fake path when `POP3_HOST` is unset.
 */
export function fakePop3FromMessages(
  messages: FakePop3Message[],
): FakePop3Client {
  return new FakePop3ClientCtor({ messages });
}

/* --------------------------------------------------------------------- */
/* Singleton loop                                                        */
/* --------------------------------------------------------------------- */

let stopping = false;

/**
 * Run the worker loop until SIGTERM/SIGINT. Calls `ingestOnce()` on
 * `POP3_POLL_INTERVAL_MS`. Exits 0 on signal.
 *
 * If no real POP3 is configured (`POP3_HOST` unset) AND no fixtures are
 * provided, the worker logs once and exits 0 (graceful skip per the brief).
 *
 * If fixtures are passed (via `opts.fixtures`), the worker uses the fake
 * POP3 client for the first cycle and then exits 0 after one cycle. This is
 * the "run briefly against fixtures on EC2" verification path.
 */
export async function runWorker(opts: {
  /** Fixture path: run one cycle against a fake POP3 with these messages, then exit. */
  fixtures?: FakePop3Message[];
  /** Override poll interval. Defaults to env. */
  pollIntervalMs?: number;
} = {}): Promise<void> {
  let env: ReturnType<typeof parseEnv> | null = null;
  try {
    env = parseEnv(process.env);
  } catch {
    env = null;
  }
  const interval = opts.pollIntervalMs ?? env?.POP3_POLL_INTERVAL_MS ?? 30000;

  const onSignal = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`worker: received ${sig}, stopping after current cycle`);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  // Fixture mode: one cycle, then exit.
  if (opts.fixtures && opts.fixtures.length > 0) {
    const pop3 = fakePop3FromMessages(opts.fixtures);
    console.log(
      `worker: fixture mode, ${opts.fixtures.length} message(s), running one cycle`,
    );
    const result = await ingestOnce({ pop3 });
    console.log(JSON.stringify(result, null, 2));
    await closeDb().catch(() => undefined);
    console.log('worker: fixture cycle complete, exiting 0');
    return;
  }

  // No real POP3 configured -> graceful skip.
  if (!env || !env.POP3_HOST || !env.POP3_PORT || !env.POP3_USER) {
    console.log(
      'worker: POP3_HOST/PORT/USER unset, no fixtures, skipping ingest',
    );
    return;
  }

  // Real loop.
  console.log(`worker: starting poll loop, interval=${interval}ms`);
  while (!stopping) {
    const start = Date.now();
    try {
      const result = await ingestOnce();
      console.log(
        `worker: cycle listed=${result.listed} processed=${result.processed} deled=${result.deled} fake=${result.usedFakePop3}${
          result.cycleError ? ` error=${result.cycleError}` : ''
        }`,
      );
    } catch (err) {
      console.error(
        'worker: cycle threw:',
        err instanceof Error ? err.message : String(err),
      );
    }
    const elapsed = Date.now() - start;
    const wait = Math.max(0, interval - elapsed);
    if (wait > 0) {
      await sleep(wait);
    }
  }
  await closeDb().catch(() => undefined);
  console.log('worker: stopped, exiting 0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * CLI entry. Reads fixture path from `WORKER_FIXTURE_DIR` env (optional) to
 * run one fixture cycle for EC2 verification; otherwise runs the real loop.
 *
 * `WORKER_FIXTURE_GLOB` may be a comma-separated list of `<uidl>:<path>`
 * pairs. If set, the worker runs one fake cycle and exits.
 */
async function main(): Promise<void> {
  const fixtureSpec = process.env.WORKER_FIXTURE_SPEC;
  if (fixtureSpec) {
    const { readFileSync } = await import('node:fs');
    const messages: FakePop3Message[] = fixtureSpec
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [uidl, path] = pair.split(':') as [string, string];
        return { uidl, raw: readFileSync(path) };
      });
    await runWorker({ fixtures: messages });
    return;
  }
  await runWorker();
}

// Run only when invoked directly (`node dist/mail/ingest/worker.js`).
const isMain = (() => {
  const entry = process.env.npm_lifecycle_event;
  if (entry === 'worker') return true;
  // ESM: check import.meta.url ends with worker.js
  try {
    const url = (import.meta as { url?: string }).url;
    if (url && url.endsWith('worker.js')) return true;
  } catch {
    // ignore
  }
  return false;
})();

if (isMain) {
  main().catch((err) => {
    console.error('worker: fatal', err);
    process.exit(1);
  });
}
