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
 *        e. Persist mailbox copies (each with its own UIDL + transaction).
 *        f. DELE the POP3 message **only after** S3 + PG commit succeed
 *           for the primary and every copy (or each is duplicate / reconciled).
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
import {
  claimIngestUidl,
  cleanupPartialParseFailureAttachments,
  hasPendingCandidateAttachmentCleanup,
  INGEST_UIDL_CLAIM_LEASE_MS,
  persistInboundMessage,
  quarantineOversizedMessage,
  quarantineParseFailure,
  releaseIngestUidlClaim,
  renewIngestUidlClaim,
  sweepCandidateAttachmentCleanupTasks,
  type PersistResult,
} from './store.js';
import { completeFanoutAfterPrimary } from './fanout.js';
import {
  createPop3Client,
  type Pop3Client,
  type FakePop3Client,
  FakePop3Client as FakePop3ClientCtor,
  type FakePop3Message,
} from './pop3-client.js';
import {
  candidateMessageIdForPop3Uidl,
  parseRawMessage,
  uploadedAttachmentsFromParseFailure,
  type ParsedInboundMessage,
} from './parse-message.js';
import { IngestTooLargeError, assertWithinIngestLimits, getIngestLimits } from './limits.js';
import { rawMimeKey, getS3Storage, archiveQuarantineRawMime } from '../../storage/s3.js';
import { isCliEntry } from '../../lib/is-cli-entry.js';
import { getDb, closeDb } from '../../db/client.js';
import { parseEnv } from '../../env.js';

/** After this many consecutive failures for one UIDL, quarantine + DELE. */
export const POISON_MAX_RETRIES = 3;

/** ORM query errors wrap PostgreSQL/driver failures in one or more causes. */
function databaseInfrastructureCode(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') {
      // Connection, authorization, transaction rollback, schema/permission,
      // resource, operator intervention, system and internal PostgreSQL errors.
      if (/^(08|28|40|42|53|54|55|57|58|XX)[0-9A-Z]{3}$/.test(code)) return code;
      if (
        [
          'ECONNRESET',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'EPIPE',
          'ENOTFOUND',
          'EAI_AGAIN',
          'CONNECTION_CLOSED',
          'CONNECTION_DESTROYED',
          'CONNECTION_ENDED',
          'CONNECT_TIMEOUT',
        ].includes(code)
      )
        return code;
    }
    current = cause;
  }
  return undefined;
}

class IngestUidlClaimLostError extends Error {
  constructor() {
    super('ingest UIDL claim was lost before POP3 processing completed');
    this.name = 'IngestUidlClaimLostError';
  }
}

function startIngestUidlClaimRenewal(
  db: import('../../db/client.js').DB,
  meta: { ingestMailboxId: string; pop3Uidl: string },
  claimToken: string,
): {
  renewNow: () => Promise<void>;
  stop: () => Promise<void>;
} {
  let stopped = false;
  let lost = false;
  let pending = Promise.resolve();
  const renew = async () => {
    if (stopped || lost) return;
    try {
      if (!(await renewIngestUidlClaim(db, meta, claimToken))) lost = true;
    } catch {
      lost = true;
    }
  };
  const tick = async () => {
    pending = pending.then(renew);
    await pending;
  };
  const assertHeld = async () => {
    await tick();
    if (lost) throw new IngestUidlClaimLostError();
  };
  const timer = setInterval(tick, Math.max(1, Math.floor(INGEST_UIDL_CLAIM_LEASE_MS / 3)));

  return {
    renewNow: assertHeld,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}

export interface IngestOnceOptions {
  /** Injected POP3 client (real or fake). If absent, built from env. */
  pop3?: Pop3Client;
  /** Injected DB handle. If absent, uses the module-level getDb(). */
  db?: import('../../db/client.js').DB;
  /** Ingest mailbox id to scope raw-mime S3 keys and quarantine rows. */
  ingestMailboxId?: string;
  /** Max messages per cycle. Defaults to env `POP3_MAX_MESSAGES_PER_CYCLE`. */
  maxMessages?: number;
  /** Per-UIDL failure counts (tests may inject). */
  failureCounts?: Map<string, number>;
  /** Long-lived worker state used to round-robin bounded POP3 batches. */
  uidlCursor?: IngestUidlCursor;
}

export interface IngestUidlCursor {
  lastProcessedUidl?: string;
}

export type ItemOutcome =
  | { uidl: string; result: PersistResult; status: 'deferred' | 'ok' }
  | {
      uidl: string;
      status: 'deferred';
      reason: 'candidate_attachment_cleanup_pending' | 'ingest_uidl_claim_pending';
    }
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
  /** Best-effort duplicate attachment cleanup failures. */
  duplicateAttachmentCleanupFailureCount: number;
}

function selectUidlWindow(
  uidls: string[],
  maxMessages: number,
  cursor: IngestUidlCursor | undefined,
): string[] {
  const limit = Number.isFinite(maxMessages) ? Math.max(0, Math.floor(maxMessages)) : 0;
  if (!cursor || uidls.length <= limit) return uidls.slice(0, limit);
  if (limit === 0 || uidls.length === 0) return [];

  const previousIndex = cursor.lastProcessedUidl ? uidls.indexOf(cursor.lastProcessedUidl) : -1;
  const start = previousIndex >= 0 ? (previousIndex + 1) % uidls.length : 0;
  return Array.from(
    { length: Math.min(limit, uidls.length) },
    (_, offset) => uidls[(start + offset) % uidls.length]!,
  );
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
export async function ingestOnce(opts: IngestOnceOptions = {}): Promise<IngestCycleResult> {
  let env: ReturnType<typeof parseEnv> | null = null;
  try {
    env = parseEnv(process.env);
  } catch {
    env = null;
  }
  const ingestMailboxId = opts.ingestMailboxId ?? 'ingest-nava-legacy';
  const maxMessages = opts.maxMessages ?? env?.POP3_MAX_MESSAGES_PER_CYCLE ?? 500;
  const failureCounts = opts.failureCounts ?? new Map<string, number>();
  let duplicateAttachmentCleanupFailureCount = 0;

  const pop3 = opts.pop3 ?? (env ? createPop3Client(env) : null);
  const usedFakePop3 = pop3?.kind === 'fake';

  if (!pop3) {
    return {
      listed: 0,
      processed: 0,
      deled: 0,
      items: [],
      usedFakePop3: false,
      duplicateAttachmentCleanupFailureCount,
      cycleError:
        env?.MAIL_TRANSPORT_MODE === 'real' || env?.MAIL_TRANSPORT_MODE === 'wire'
          ? 'no real pop3 client configured (host/port/user/secret required)'
          : 'no pop3 client configured',
    };
  }

  const items: ItemOutcome[] = [];
  let listed = 0;
  let processed = 0;
  let deled = 0;
  let scheduledDeletions = 0;
  const claimsHeldUntilQuit: {
    meta: { ingestMailboxId: string; pop3Uidl: string };
    claimToken: string;
    renewal: ReturnType<typeof startIngestUidlClaimRenewal>;
  }[] = [];

  try {
    const storage = getS3Storage();
    const db = opts.db ?? getDb();
    const limits = getIngestLimits(process.env);
    const supportsCleanupQueue =
      typeof (db as unknown as { select?: unknown }).select === 'function';
    if (supportsCleanupQueue) {
      const cleanupSweep = await sweepCandidateAttachmentCleanupTasks({ db, storage });
      if (cleanupSweep.failureCount > 0) {
        console.warn(
          `worker: candidate attachment cleanup sweep failures=${cleanupSweep.failureCount}`,
        );
      }
    }

    await pop3.connect();
    const uidls = await pop3.listUidl();
    listed = uidls.length;

    for (const uidl of selectUidlWindow(uidls, maxMessages, opts.uidlCursor)) {
      if (opts.uidlCursor) opts.uidlCursor.lastProcessedUidl = uidl;
      let rawKey: string | undefined;
      let parsedAttachmentsRequiringCleanup: ParsedInboundMessage['attachments'] = [];
      const claimMeta = { ingestMailboxId, pop3Uidl: uidl };
      let claimToken: string | null = null;
      let claimRenewal: ReturnType<typeof startIngestUidlClaimRenewal> | undefined;
      let retainClaimUntilExpiry = false;
      let retainClaimUntilQuit = false;
      const renewClaim = async (): Promise<void> => {
        await claimRenewal?.renewNow();
      };
      const retainClaimForQuit = () => {
        if (!claimToken || !claimRenewal) return;
        retainClaimUntilQuit = true;
        claimsHeldUntilQuit.push({
          meta: claimMeta,
          claimToken,
          renewal: claimRenewal,
        });
      };
      try {
        if (
          supportsCleanupQueue &&
          (await hasPendingCandidateAttachmentCleanup(db, {
            ingestMailboxId,
            pop3Uidl: uidl,
          }))
        ) {
          failureCounts.delete(uidl);
          items.push({
            uidl,
            status: 'deferred',
            reason: 'candidate_attachment_cleanup_pending',
          });
          continue;
        }
        if (supportsCleanupQueue) {
          claimToken = await claimIngestUidl(db, claimMeta);
          if (!claimToken) {
            failureCounts.delete(uidl);
            items.push({
              uidl,
              status: 'deferred',
              reason: 'ingest_uidl_claim_pending',
            });
            continue;
          }
          claimRenewal = startIngestUidlClaimRenewal(db, claimMeta, claimToken);
          if (await hasPendingCandidateAttachmentCleanup(db, claimMeta)) {
            failureCounts.delete(uidl);
            items.push({
              uidl,
              status: 'deferred',
              reason: 'candidate_attachment_cleanup_pending',
            });
            continue;
          }
        }
        const msg = await pop3.retr(uidl);
        assertWithinIngestLimits(msg.raw.byteLength, 'message', limits);
        const messageId = candidateMessageIdForPop3Uidl(ingestMailboxId, uidl);
        const currentRawKey = rawMimeKey({
          ingestMailboxId,
          pop3Uidl: uidl,
        });
        rawKey = currentRawKey;
        const meta = {
          ingestMailboxId,
          pop3Uidl: uidl,
          messageId,
          rawMimeS3Key: currentRawKey,
        };
        await storage.putObject({
          key: currentRawKey,
          body: msg.raw,
          contentType: 'message/rfc822',
        });
        const parsed = await parseRawMessage(msg.raw, {
          messageId,
          storage,
        });
        parsedAttachmentsRequiringCleanup = parsed.attachments;
        await renewClaim();
        const result = await persistInboundMessage(parsed, msg.raw, meta, {
          db,
          storage,
          ingestSource: 'live-pop3',
          activeIngestUidlClaimToken: claimToken ?? undefined,
        });

        parsedAttachmentsRequiringCleanup = [];

        if (result.kind === 'duplicate') {
          duplicateAttachmentCleanupFailureCount += result.candidateAttachmentCleanupFailureCount;
        }

        if (result.kind === 'deferred') {
          failureCounts.delete(uidl);
          if (result.candidateAttachmentCleanupFailureCount > 0) {
            console.warn(
              `worker: deferred returned-copy attachment cleanup failures=${result.candidateAttachmentCleanupFailureCount}`,
            );
          }
          items.push({ uidl, result, status: 'deferred' });
          processed += 1;
          continue;
        }

        if (result.kind === 'quarantined') {
          const cleanupPending = await hasPendingCandidateAttachmentCleanup(db, {
            ingestMailboxId,
            pop3Uidl: uidl,
          });
          if (cleanupPending) {
            failureCounts.delete(uidl);
            console.warn(
              `worker: quarantine attachment cleanup pending failures=${result.candidateAttachmentCleanupFailureCount}`,
            );
            items.push({ uidl, result, status: 'deferred' });
            processed += 1;
            continue;
          }
          await archiveQuarantineRawMime(storage, rawKey, {
            ingestMailboxId,
            pop3Uidl: uidl,
          });
        }

        if (result.kind === 'failed') {
          items.push({ uidl, result, status: 'deferred' });
          processed += 1;
          continue;
        }

        if (
          !(await completeFanoutAfterPrimary({
            db,
            storage,
            raw: msg.raw,
            meta,
            persistResult: result,
            ingestSource: 'live-pop3',
          }))
        ) {
          failureCounts.delete(uidl);
          items.push({ uidl, result, status: 'deferred' });
          processed += 1;
          continue;
        }

        failureCounts.delete(uidl);
        await renewClaim();
        await pop3.dele(uidl);
        retainClaimForQuit();
        scheduledDeletions += 1;
        items.push({ uidl, result, status: 'ok' });
        processed += 1;
      } catch (err) {
        const infrastructureCode = databaseInfrastructureCode(err);
        if (infrastructureCode) failureCounts.delete(uidl);
        let claimWasLost = err instanceof IngestUidlClaimLostError;
        if (!claimWasLost && claimRenewal) {
          try {
            await claimRenewal.renewNow();
          } catch (renewalError) {
            claimWasLost = renewalError instanceof IngestUidlClaimLostError;
          }
        }
        if (claimWasLost) {
          failureCounts.delete(uidl);
          items.push({
            uidl,
            status: 'deferred',
            reason: 'ingest_uidl_claim_pending',
          });
          processed += 1;
          continue;
        }

        const uploadedAttachments = [
          ...new Map(
            [...parsedAttachmentsRequiringCleanup, ...uploadedAttachmentsFromParseFailure(err)].map(
              (attachment) => [attachment.s3Key, attachment],
            ),
          ).values(),
        ];
        if (uploadedAttachments.length > 0 && rawKey) {
          try {
            await cleanupPartialParseFailureAttachments({
              db,
              storage,
              attachments: uploadedAttachments,
              meta: {
                ingestMailboxId,
                pop3Uidl: uidl,
                messageId: candidateMessageIdForPop3Uidl(ingestMailboxId, uidl),
              },
              activeIngestUidlClaimToken: claimToken ?? undefined,
            });
          } catch (cleanupError) {
            retainClaimUntilExpiry = true;
            const cleanupCode = databaseInfrastructureCode(cleanupError);
            const error = cleanupCode
              ? `database infrastructure failure (${cleanupCode})`
              : cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError);
            items.push({
              uidl,
              status: 'error',
              error: `candidate attachment cleanup registration failed: ${error}`,
            });
            processed += 1;
            continue;
          }

          if (
            await hasPendingCandidateAttachmentCleanup(db, {
              ingestMailboxId,
              pop3Uidl: uidl,
            })
          ) {
            failureCounts.delete(uidl);
            items.push({
              uidl,
              status: 'deferred',
              reason: 'candidate_attachment_cleanup_pending',
            });
            processed += 1;
            continue;
          }
        }

        if (err instanceof IngestTooLargeError && !rawKey) {
          const skippedKey = `quarantine-skipped/${ingestMailboxId}/${uidl.replace(/[^A-Za-z0-9._-]+/g, '_')}.eml`;
          const result = await quarantineOversizedMessage(
            { ingestMailboxId, pop3Uidl: uidl },
            skippedKey,
            { db },
          );
          failureCounts.delete(uidl);
          if (
            await hasPendingCandidateAttachmentCleanup(db, {
              ingestMailboxId,
              pop3Uidl: uidl,
            })
          ) {
            items.push({ uidl, result, status: 'deferred' });
            processed += 1;
            continue;
          }
          await renewClaim();
          await pop3.dele(uidl);
          retainClaimForQuit();
          scheduledDeletions += 1;
          items.push({ uidl, result, status: 'ok' });
          processed += 1;
          continue;
        }

        if (err instanceof IngestTooLargeError && rawKey) {
          const result = await quarantineOversizedMessage(
            { ingestMailboxId, pop3Uidl: uidl },
            rawKey,
            { db },
          );
          if (
            await hasPendingCandidateAttachmentCleanup(db, {
              ingestMailboxId,
              pop3Uidl: uidl,
            })
          ) {
            failureCounts.delete(uidl);
            items.push({ uidl, result, status: 'deferred' });
            processed += 1;
            continue;
          }
          await archiveQuarantineRawMime(storage, rawKey, {
            ingestMailboxId,
            pop3Uidl: uidl,
          });
          failureCounts.delete(uidl);
          await renewClaim();
          await pop3.dele(uidl);
          retainClaimForQuit();
          scheduledDeletions += 1;
          items.push({ uidl, result, status: 'ok' });
          processed += 1;
          continue;
        }

        if (infrastructureCode) {
          failureCounts.delete(uidl);
          // Never include ORM query text/parameters: they can contain private mail.
          items.push({
            uidl,
            status: 'error',
            error: `database infrastructure failure (${infrastructureCode}); POP3 message retained`,
          });
          processed += 1;
          continue;
        }

        const prev = failureCounts.get(uidl) ?? 0;
        const next = prev + 1;
        failureCounts.set(uidl, next);

        if (next >= POISON_MAX_RETRIES && rawKey) {
          const error = err instanceof Error ? err.message : String(err);
          const result = await quarantineParseFailure(
            { ingestMailboxId, pop3Uidl: uidl },
            rawKey,
            { db },
            error,
          );
          if (
            await hasPendingCandidateAttachmentCleanup(db, {
              ingestMailboxId,
              pop3Uidl: uidl,
            })
          ) {
            failureCounts.delete(uidl);
            items.push({ uidl, result, status: 'deferred' });
            processed += 1;
            continue;
          }
          await archiveQuarantineRawMime(storage, rawKey, {
            ingestMailboxId,
            pop3Uidl: uidl,
          });
          failureCounts.delete(uidl);
          await renewClaim();
          await pop3.dele(uidl);
          retainClaimForQuit();
          scheduledDeletions += 1;
          items.push({ uidl, result, status: 'ok' });
          processed += 1;
          continue;
        }

        const error = err instanceof Error ? err.message : String(err);
        items.push({ uidl, status: 'error', error });
        processed += 1;
      } finally {
        if (!retainClaimUntilQuit) {
          try {
            await claimRenewal?.stop();
          } finally {
            if (claimToken && !retainClaimUntilExpiry) {
              await releaseIngestUidlClaim(db, claimMeta, claimToken).catch(() => undefined);
            }
          }
        }
      }
    }

    if (duplicateAttachmentCleanupFailureCount > 0) {
      console.warn(
        `worker: duplicate candidate attachment cleanup failures=${duplicateAttachmentCleanupFailureCount}`,
      );
    }
    try {
      await Promise.all(claimsHeldUntilQuit.map(({ renewal }) => renewal.renewNow()));
      await pop3.quit();
      deled = scheduledDeletions;
      await Promise.all(
        claimsHeldUntilQuit.map(async ({ meta, claimToken, renewal }) => {
          await renewal.stop();
          await releaseIngestUidlClaim(db, meta, claimToken).catch(() => undefined);
        }),
      );
    } catch (err) {
      await Promise.allSettled(claimsHeldUntilQuit.map(({ renewal }) => renewal.stop()));
      throw err;
    }
    return {
      listed,
      processed,
      deled,
      items,
      usedFakePop3,
      duplicateAttachmentCleanupFailureCount,
    };
  } catch (err) {
    const infrastructureCode = databaseInfrastructureCode(err);
    const cycleError = infrastructureCode
      ? `database infrastructure failure (${infrastructureCode}); POP3 mail retained`
      : err instanceof Error
        ? err.message
        : String(err);
    await pop3.close().catch(() => undefined);
    return {
      listed,
      processed,
      deled,
      items,
      usedFakePop3,
      duplicateAttachmentCleanupFailureCount,
      cycleError,
    };
  }
}

/**
 * Build a `FakePop3Client` from fixture messages. Exported so the worker
 * entry script can run the fixture/fake path when `POP3_HOST` is unset.
 */
export function fakePop3FromMessages(messages: FakePop3Message[]): FakePop3Client {
  return new FakePop3ClientCtor({ messages });
}

/* --------------------------------------------------------------------- */
/* Singleton loop                                                        */
/* --------------------------------------------------------------------- */

/**
 * Run the worker loop until SIGTERM/SIGINT. Calls `ingestOnce()` on
 * `POP3_POLL_INTERVAL_MS`. Exits 0 on signal.
 */
export async function runWorker(
  opts: {
    /** Fixture path: run one cycle against a fake POP3 with these messages, then exit. */
    fixtures?: FakePop3Message[];
    /** Override poll interval. Defaults to env. */
    pollIntervalMs?: number;
  } = {},
): Promise<void> {
  const stop = { stopping: false };

  let env: ReturnType<typeof parseEnv> | null = null;
  try {
    env = parseEnv(process.env);
  } catch {
    env = null;
  }
  const interval = opts.pollIntervalMs ?? env?.POP3_POLL_INTERVAL_MS ?? 30000;
  const mode = env?.MAIL_TRANSPORT_MODE ?? 'fixture';
  const oneShot = process.env.WORKER_ONE_SHOT === '1' || process.env.WORKER_ONE_SHOT === 'true';

  const onSignal = (sig: string) => {
    if (stop.stopping) return;
    stop.stopping = true;
    console.log(`worker: received ${sig}, stopping after current cycle`);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  if (opts.fixtures !== undefined) {
    console.log(`worker: transport.mode=fixture (explicit fixtures)`);
    const pop3 = fakePop3FromMessages(opts.fixtures);
    console.log(`worker: fixture mode, ${opts.fixtures.length} message(s), running one cycle`);
    const result = await ingestOnce({ pop3 });
    console.log(JSON.stringify(result, null, 2));
    await closeDb().catch(() => undefined);
    console.log('worker: fixture cycle complete, exiting 0');
    return;
  }

  if (!env) {
    console.log('worker: env parse failed, skipping ingest');
    return;
  }

  console.log(`worker: transport.mode=${mode}`);

  const pop3 = createPop3Client(env);
  if (!pop3) {
    console.log(
      mode === 'real' || mode === 'wire'
        ? 'worker: real/wire mode but POP3_HOST/PORT/USER unset, skipping ingest'
        : 'worker: fixture mode but no POP3 client available, skipping ingest',
    );
    return;
  }

  if (oneShot) {
    const maxMessages = process.env.WORKER_MAX_MESSAGES
      ? Number(process.env.WORKER_MAX_MESSAGES)
      : undefined;
    console.log(
      `worker: one-shot cycle, mode=${mode}, fake=${pop3.kind === 'fake'}${
        maxMessages ? `, maxMessages=${maxMessages}` : ''
      }`,
    );
    const result = await ingestOnce({ pop3, maxMessages });
    console.log(JSON.stringify(result, null, 2));
    await closeDb().catch(() => undefined);
    console.log('worker: one-shot cycle complete, exiting 0');
    return;
  }

  console.log(`worker: starting poll loop, interval=${interval}ms, fake=${pop3.kind === 'fake'}`);
  const failureCounts = new Map<string, number>();
  const uidlCursor: IngestUidlCursor = {};
  while (!stop.stopping) {
    const start = Date.now();
    try {
      const result = await ingestOnce({ pop3, failureCounts, uidlCursor });
      console.log(
        `worker: cycle listed=${result.listed} processed=${result.processed} deled=${result.deled} fake=${result.usedFakePop3}${
          result.cycleError ? ` error=${result.cycleError}` : ''
        }`,
      );
    } catch (err) {
      console.error('worker: cycle threw:', err instanceof Error ? err.message : String(err));
    }
    try {
      const { flushDue } = await import('../send/outbound-queue.js');
      const flushed = await flushDue();
      if (flushed.flushed > 0) {
        console.log(`worker: flushDue flushed=${flushed.flushed}`);
      }
    } catch (err) {
      console.error('worker: flushDue threw:', err instanceof Error ? err.message : String(err));
    }
    const elapsed = Date.now() - start;
    const wait = Math.max(0, interval - elapsed);
    if (wait > 0) {
      await abortableSleep(wait, () => stop.stopping);
    }
  }
  await closeDb().catch(() => undefined);
  console.log('worker: stopped, exiting 0');
}

function abortableSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (shouldStop()) {
      resolve();
      return;
    }
    // Keep timers ref'd: unref'd wait lets Node exit when POP3 cycle leaves no
    // other handles (empty inbox) → PM2 restart storm / worker "errored".
    const timer = setTimeout(() => {
      clearInterval(tick);
      resolve();
    }, ms);
    const tick = setInterval(() => {
      if (shouldStop()) {
        clearTimeout(timer);
        clearInterval(tick);
        resolve();
      }
    }, 100);
  });
}

/**
 * CLI entry. Reads fixture path from `WORKER_FIXTURE_DIR` env (optional) to
 * run one fixture cycle for EC2 verification; otherwise runs the real loop.
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

if (isCliEntry(import.meta.url, 'worker')) {
  main().catch((err) => {
    console.error('worker: fatal', err);
    process.exit(1);
  });
}
