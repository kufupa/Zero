/**
 * Centurion triage retag: insert-before-mutate idempotent unsettle + enqueue.
 *
 * Note: no shebang — Windows CRLF + shebang breaks Vitest/Vite transform.
 * Invoke via `node scripts/retag-centurion-triage.mjs`.
 *
 * Default: dry-run. Mutate with --apply.
 * Full v6 rollout requires --targets <approved-rollout-manifest.json>.
 * --from-domain is subset repair only (never with --targets).
 *
 * Usage:
 *   node scripts/retag-centurion-triage.mjs --targets approved.json --key-prefix inbound-triage-retag-v6-...
 *   node scripts/retag-centurion-triage.mjs --apply --targets approved.json --key-prefix inbound-triage-retag-v6-...
 *   node scripts/retag-centurion-triage.mjs --from-domain example.com
 *   node scripts/retag-centurion-triage.mjs --apply --from-domain example.com --key-prefix inbound-triage-retag-v6-repair
 *   node scripts/retag-centurion-triage.mjs --from-domain synxis.com --include-non-spam
 *   node scripts/retag-centurion-triage.mjs --apply --from-domain synxis.com --include-non-spam --key-prefix inbound-triage-retag-v6-quality
 *
 * Env: DATABASE_URL (+ deploy/rds-ca-global.pem for SSL when present)
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// postgres is loaded lazily in main() so unit tests can import pure helpers
// without Vitest transforming the native/esm postgres package.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export const TRANSPORT_ID = 'transport-centurion';
export const DEFAULT_MODEL_ID = 'global.openai.gpt-6-luna';
export const DEFAULT_PROMPT_VERSION = 'triage-v6';
export const DEFAULT_KEY_PREFIX = 'inbound-triage-retag-v6';

export const LEGACY_PRIMARY_SLUGS = [
  'new-bookings',
  'groups-events',
  'at-risk',
  'ops',
];

export const WORKFLOW_PRIMARY_SLUGS = [
  'bookings',
  'groups-events',
  'manage-stay',
  'confirm-reconcile',
  'money-billing',
  'documents-delivery',
  'exceptions-recovery',
  'guest-experience',
  'internal-partner',
  'automated-channel',
  'unknown-review',
];

/** Legacy + workflow primaries stay managed during v6 cutover; urgent is overlay. */
export const AI_MANAGED_SLUGS = [
  ...new Set([
    ...LEGACY_PRIMARY_SLUGS,
    ...WORKFLOW_PRIMARY_SLUGS,
    'urgent',
  ]),
];

// Legacy invent-WHO slugs - unsettle-only during retag (clear stale joins before triage-v6).
export const LEGACY_INVENT_WHO_SLUGS = [
  'internal',
  'individual',
  'group',
  'travel-agents',
];

/**
 * All joins cleared before a newly inserted v6 run. Snapshot/restore uses the
 * same set so rollback can recover legacy invent-WHO joins; other categories
 * remain custom and untouched.
 */
export const RETAG_UNSETTLE_SLUGS = [
  ...new Set([
    ...AI_MANAGED_SLUGS,
    ...LEGACY_INVENT_WHO_SLUGS,
  ]),
];

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function computeCanonicalManifestHash(manifestWithoutHash) {
  return sha256Hex(stableStringify(manifestWithoutHash));
}

export function computeTriggerHash(input) {
  return sha256Hex(
    stableStringify({
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
      createdAt: input.createdAt,
    }),
  );
}

export function computePreStateHash(input) {
  const slugs = [...(input.aiCategorySlugs ?? [])].map(String).sort();
  return sha256Hex(
    stableStringify({
      spamAt: input.spamAt ?? null,
      spamUserLockedAt: input.spamUserLockedAt ?? null,
      aiCategorySlugs: slugs,
    }),
  );
}

export function retagIdempotencyKey(messageId, keyPrefix) {
  return `${keyPrefix}:${messageId}`;
}

export function parseArgs(argv) {
  let keyPrefix = DEFAULT_KEY_PREFIX;
  let fromDomain = null;
  let targetsPath = null;
  let dryRun = true;
  let includeNonSpam = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      dryRun = false;
      continue;
    }
    if (arg === '--include-non-spam') {
      includeNonSpam = true;
      continue;
    }
    if (arg === '--key-prefix') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--key-prefix requires a value');
      }
      keyPrefix = value;
      continue;
    }
    if (arg === '--from-domain') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--from-domain requires a value');
      }
      fromDomain = value.toLowerCase();
      continue;
    }
    if (arg === '--targets') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--targets requires a path');
      }
      targetsPath = value;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  if (!dryRun && !targetsPath && !fromDomain) {
    throw new Error('full v6 --apply requires --targets <approved-rollout-manifest.json>');
  }
  if (targetsPath && fromDomain) {
    throw new Error('full rollout --targets must not use --from-domain (subset repair only)');
  }
  if (!targetsPath && !fromDomain && dryRun) {
    // Exploratory dry-run without scope is unsafe for full rollout; require explicit mode.
    throw new Error('require --targets <manifest> (full rollout) or --from-domain <domain> (subset repair)');
  }
  if (includeNonSpam && !fromDomain) {
    throw new Error('--include-non-spam requires --from-domain (quality domain repair)');
  }

  return { dryRun, keyPrefix, fromDomain, targetsPath, includeNonSpam };
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function validateApprovedRolloutManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('manifest must be an object');
  }
  if (manifest.transportId !== TRANSPORT_ID) {
    throw new Error(`manifest transportId must be ${TRANSPORT_ID}`);
  }
  if (typeof manifest.modelId !== 'string' || !manifest.modelId) {
    throw new Error('manifest modelId required');
  }
  if (typeof manifest.promptVersion !== 'string' || !manifest.promptVersion) {
    throw new Error('manifest promptVersion required');
  }
  if (!isSha256Hex(manifest.promptHash)) {
    throw new Error('manifest promptHash must be sha256 hex');
  }
  if (!Array.isArray(manifest.targets)) {
    throw new Error('manifest targets must be an array');
  }

  const seen = new Set();
  for (const target of manifest.targets) {
    if (!target?.threadId || !target?.triggerMessageId) {
      throw new Error('each target requires threadId and triggerMessageId');
    }
    if (!isSha256Hex(target.triggerHash)) {
      throw new Error(`target ${target.threadId}: triggerHash must be sha256 hex`);
    }
    if (!isSha256Hex(target.preStateHash)) {
      throw new Error(`target ${target.threadId}: preStateHash must be sha256 hex`);
    }
    if (seen.has(target.threadId)) {
      throw new Error(`duplicate target threadId: ${target.threadId}`);
    }
    seen.add(target.threadId);
  }

  const { manifestHash: _ignored, ...withoutHash } = manifest;
  const expected = computeCanonicalManifestHash(withoutHash);
  if (manifest.manifestHash !== expected) {
    throw new Error(`manifestHash mismatch: expected ${expected}`);
  }
  return manifest;
}

/**
 * Full-apply manifests must be bound to an approved decision artifact. The
 * snapshot emitter intentionally creates an unbound target manifest for
 * rehearsal/dry-run; only the adjudicated binding may authorize mutation.
 */
export function validateBoundApprovedRolloutManifest(manifest) {
  validateApprovedRolloutManifest(manifest);
  if (!isSha256Hex(manifest.sourceHash)) {
    throw new Error('bound manifest sourceHash must be sha256 hex');
  }
  if (!isSha256Hex(manifest.snapshotHash)) {
    throw new Error('bound manifest snapshotHash must be sha256 hex');
  }
  const allowedPrimaryFolders = new Set([...WORKFLOW_PRIMARY_SLUGS, 'spam']);
  for (const target of manifest.targets) {
    if (
      target.approvedCategory != null &&
      target.approvedPrimaryFolder != null &&
      target.approvedCategory !== target.approvedPrimaryFolder
    ) {
      throw new Error(`target ${target.threadId}: approved category binding mismatch`);
    }
    const primary = target.approvedPrimaryFolder ?? target.approvedCategory;
    if (typeof primary !== 'string' || primary.length === 0) {
      throw new Error(`target ${target.threadId}: approved canonical decision required`);
    }
    if (!allowedPrimaryFolders.has(primary)) {
      throw new Error(`target ${target.threadId}: invalid approved canonical folder ${primary}`);
    }
    if (typeof target.approvedIsSpam !== 'boolean') {
      throw new Error(`target ${target.threadId}: approvedIsSpam boolean required`);
    }
    if (target.approvedIsSpam !== (primary === 'spam')) {
      throw new Error(`target ${target.threadId}: approved spam/folder decision mismatch`);
    }
    if (typeof target.approvedUrgent !== 'boolean') {
      throw new Error(`target ${target.threadId}: approved urgent boolean required`);
    }
    if (!isSha256Hex(target.sourceHash) || target.sourceHash !== manifest.sourceHash) {
      throw new Error(`target ${target.threadId}: sourceHash binding mismatch`);
    }
    if (!isSha256Hex(target.rehearsalResultHash)) {
      throw new Error(`target ${target.threadId}: rehearsalResultHash required`);
    }
  }
  return manifest;
}

export function loadApprovedRolloutManifest(targetsPath) {
  const raw = fs.readFileSync(targetsPath, 'utf8');
  const parsed = JSON.parse(raw);
  return validateApprovedRolloutManifest(parsed);
}

function emptyCounts() {
  return {
    scanned: 0,
    eligible: 0,
    skippedLocked: 0,
    skippedBlocked: 0,
    skippedAllowed: 0,
    skippedOutboundOnly: 0,
    skippedNotSpam: 0,
    collisions: 0,
    wouldInsert: 0,
    inserted: 0,
    mutated: 0,
  };
}

function isoOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

/**
 * @typedef {object} RetagThreadRow
 * @property {string} threadId
 * @property {Date|string|null} spamAt
 * @property {Date|string|null} spamUserLockedAt
 * @property {string|null} latestInboundId
 * @property {string|null} latestInboundFrom
 * @property {Date|string|null} latestInboundCreatedAt
 * @property {string[]} aiCategorySlugs
 * @property {boolean} hasInbound
 */

/**
 * @typedef {object} RetagDriver
 * @property {() => Promise<string[]>} listAiManagedCategoryIds
 * @property {(opts: { threadIds?: string[]|null }) => Promise<RetagThreadRow[]>} listThreads
 * @property {(emails: string[]) => Promise<Map<string, 'block'|'allow'>>} listSenderPreferences
 * @property {(keys: string[]) => Promise<Set<string>>} probeKeys
 * @property {(work: (tx: {
 *   insertRunReturning: (row: object) => Promise<string|null>,
 *   lockThreadForUpdate: (threadId: string) => Promise<RetagThreadRow|null>,
 *   getSenderPreference: (email: string) => Promise<'block'|'allow'|null>,
 * }) => Promise<any>) => Promise<any>} transaction
 */

export function createPostgresRetagDriver(sql) {
  return {
    async listAiManagedCategoryIds() {
      const rows = await sql`
        SELECT id
        FROM mail_category
        WHERE transport_id = ${TRANSPORT_ID}
          AND slug = ANY(${RETAG_UNSETTLE_SLUGS})
      `;
      return rows.map((row) => row.id);
    },

    async listThreads({ threadIds = null } = {}) {
      const rows = threadIds
        ? await sql`
            SELECT
              t.id AS thread_id,
              t.spam_at,
              t.spam_user_locked_at,
              (
                SELECT m.id
                FROM message m
                WHERE m.thread_id = t.id
                  AND m.direction = 'inbound'
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
              ) AS latest_inbound_id,
              (
                SELECT lower(m.from_address)
                FROM message m
                WHERE m.thread_id = t.id
                  AND m.direction = 'inbound'
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
              ) AS latest_inbound_from,
              (
                SELECT m.created_at
                FROM message m
                WHERE m.thread_id = t.id
                  AND m.direction = 'inbound'
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
              ) AS latest_inbound_created_at,
              COALESCE((
                SELECT array_agg(c.slug ORDER BY c.slug)
                FROM mail_thread_category mtc
                JOIN mail_category c ON c.id = mtc.category_id
                WHERE mtc.thread_id = t.id
                  AND mtc.transport_id = ${TRANSPORT_ID}
                  AND c.slug = ANY(${RETAG_UNSETTLE_SLUGS})
              ), '{}') AS ai_category_slugs,
              EXISTS (
                SELECT 1
                FROM message m2
                WHERE m2.thread_id = t.id
                  AND m2.direction = 'inbound'
              ) AS has_inbound
            FROM mail_thread t
            WHERE t.transport_id = ${TRANSPORT_ID}
              AND t.id = ANY(${threadIds})
            ORDER BY t.id
          `
        : await sql`
            SELECT
              t.id AS thread_id,
              t.spam_at,
              t.spam_user_locked_at,
              (
                SELECT m.id
                FROM message m
                WHERE m.thread_id = t.id
                  AND m.direction = 'inbound'
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
              ) AS latest_inbound_id,
              (
                SELECT lower(m.from_address)
                FROM message m
                WHERE m.thread_id = t.id
                  AND m.direction = 'inbound'
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
              ) AS latest_inbound_from,
              (
                SELECT m.created_at
                FROM message m
                WHERE m.thread_id = t.id
                  AND m.direction = 'inbound'
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
              ) AS latest_inbound_created_at,
              COALESCE((
                SELECT array_agg(c.slug ORDER BY c.slug)
                FROM mail_thread_category mtc
                JOIN mail_category c ON c.id = mtc.category_id
                WHERE mtc.thread_id = t.id
                  AND mtc.transport_id = ${TRANSPORT_ID}
                  AND c.slug = ANY(${RETAG_UNSETTLE_SLUGS})
              ), '{}') AS ai_category_slugs,
              EXISTS (
                SELECT 1
                FROM message m2
                WHERE m2.thread_id = t.id
                  AND m2.direction = 'inbound'
              ) AS has_inbound
            FROM mail_thread t
            WHERE t.transport_id = ${TRANSPORT_ID}
            ORDER BY t.id
          `;

      return rows.map((row) => ({
        threadId: row.thread_id,
        spamAt: row.spam_at,
        spamUserLockedAt: row.spam_user_locked_at,
        latestInboundId: row.latest_inbound_id,
        latestInboundFrom: row.latest_inbound_from,
        latestInboundCreatedAt: row.latest_inbound_created_at,
        aiCategorySlugs: row.ai_category_slugs ?? [],
        hasInbound: Boolean(row.has_inbound),
      }));
    },

    async listSenderPreferences(emails) {
      const out = new Map();
      if (emails.length === 0) return out;
      const rows = await sql`
        SELECT email, kind
        FROM mail_sender_preference
        WHERE transport_id = ${TRANSPORT_ID}
          AND email = ANY(${emails})
      `;
      for (const row of rows) {
        out.set(row.email, row.kind);
      }
      return out;
    },

    async probeKeys(keys) {
      const out = new Set();
      if (keys.length === 0) return out;
      const rows = await sql`
        SELECT idempotency_key
        FROM ai_workflow_run
        WHERE idempotency_key = ANY(${keys})
      `;
      for (const row of rows) {
        out.add(row.idempotency_key);
      }
      return out;
    },

    async transaction(work) {
      return sql.begin(async (tx) => {
        return work({
          async lockThreadForUpdate(threadId) {
            const rows = await tx`
              SELECT
                t.id AS thread_id,
                t.spam_at,
                t.spam_user_locked_at,
                (
                  SELECT m.id
                  FROM message m
                  WHERE m.thread_id = t.id
                    AND m.direction = 'inbound'
                  ORDER BY m.created_at DESC, m.id DESC
                  LIMIT 1
                ) AS latest_inbound_id,
                (
                  SELECT lower(m.from_address)
                  FROM message m
                  WHERE m.thread_id = t.id
                    AND m.direction = 'inbound'
                  ORDER BY m.created_at DESC, m.id DESC
                  LIMIT 1
                ) AS latest_inbound_from,
                (
                  SELECT m.created_at
                  FROM message m
                  WHERE m.thread_id = t.id
                    AND m.direction = 'inbound'
                  ORDER BY m.created_at DESC, m.id DESC
                  LIMIT 1
                ) AS latest_inbound_created_at,
                COALESCE((
                  SELECT array_agg(c.slug ORDER BY c.slug)
                  FROM mail_thread_category mtc
                  JOIN mail_category c ON c.id = mtc.category_id
                  WHERE mtc.thread_id = t.id
                    AND mtc.transport_id = ${TRANSPORT_ID}
                    AND c.slug = ANY(${RETAG_UNSETTLE_SLUGS})
                ), '{}') AS ai_category_slugs,
                EXISTS (
                  SELECT 1
                  FROM message m2
                  WHERE m2.thread_id = t.id
                    AND m2.direction = 'inbound'
                ) AS has_inbound
              FROM mail_thread t
              WHERE t.transport_id = ${TRANSPORT_ID}
                AND t.id = ${threadId}
              FOR UPDATE
            `;
            const row = rows[0];
            if (!row) return null;
            return {
              threadId: row.thread_id,
              spamAt: row.spam_at,
              spamUserLockedAt: row.spam_user_locked_at,
              latestInboundId: row.latest_inbound_id,
              latestInboundFrom: row.latest_inbound_from,
              latestInboundCreatedAt: row.latest_inbound_created_at,
              aiCategorySlugs: row.ai_category_slugs ?? [],
              hasInbound: Boolean(row.has_inbound),
            };
          },
          async getSenderPreference(email) {
            const rows = await tx`
              SELECT kind
              FROM mail_sender_preference
              WHERE transport_id = ${TRANSPORT_ID}
                AND email = ${email}
              LIMIT 1
            `;
            return rows[0]?.kind ?? null;
          },
          async insertRunReturning(row) {
            const inserted = await tx`
              INSERT INTO ai_workflow_run (
                id,
                transport_id,
                thread_id,
                trigger_message_id,
                run_kind,
                idempotency_key,
                model_id,
                prompt_version,
                prompt_hash,
                metrics,
                state,
                created_at,
                updated_at
              )
              SELECT
                ${row.id},
                ${TRANSPORT_ID},
                ${row.threadId},
                ${row.triggerMessageId},
                'inbound_triage',
                ${row.idempotencyKey},
                ${row.modelId},
                ${row.promptVersion},
                ${row.promptHash ?? null},
                ${JSON.stringify(row.metrics ?? { retagPending: true })}::jsonb,
                'queued',
                ${row.now},
                ${row.now}
              WHERE EXISTS (
                SELECT 1
                FROM mail_thread
                WHERE id = ${row.threadId}
                  AND transport_id = ${TRANSPORT_ID}
                  AND spam_user_locked_at IS NULL
              )
              ON CONFLICT (idempotency_key) DO UPDATE
              SET
                state = 'queued',
                claim_owner = NULL,
                claim_token = NULL,
                attempts = 0,
                next_run_at = NULL,
                started_at = NULL,
                finished_at = NULL,
                heartbeat_at = NULL,
                last_error = NULL,
                failure_class = NULL,
                metrics = EXCLUDED.metrics,
                updated_at = ${row.now}
              WHERE ai_workflow_run.state IN ('retry_wait', 'dead_letter')
              RETURNING id
            `;
            return inserted[0]?.id ?? null;
          },
          async clearAiManagedCategories(threadId, categoryIds) {
            if (categoryIds.length === 0) return;
            await tx`
              DELETE FROM mail_thread_category mtc
              USING mail_thread t
              WHERE mtc.thread_id = ${threadId}
                AND mtc.transport_id = ${TRANSPORT_ID}
                AND mtc.category_id = ANY(${categoryIds})
                AND t.id = mtc.thread_id
                AND t.transport_id = ${TRANSPORT_ID}
                AND t.spam_user_locked_at IS NULL
            `;
          },
          async clearSpamAt(threadId) {
            await tx`
              UPDATE mail_thread
              SET spam_at = NULL, updated_at = now()
              WHERE id = ${threadId}
                AND transport_id = ${TRANSPORT_ID}
                AND spam_user_locked_at IS NULL
            `;
          },
        });
      });
    },
  };
}

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

/**
 * @param {{
 *   driver: RetagDriver,
 *   dryRun: boolean,
 *   keyPrefix: string,
 *   fromDomain: string|null,
 *   includeNonSpam?: boolean,
 *   manifest: object|null,
 *   now?: Date,
 * }} opts
 */
export async function runCenturionRetag(opts) {
  const {
    driver,
    dryRun,
    keyPrefix,
    fromDomain,
    includeNonSpam = false,
    manifest,
    now = new Date(),
  } = opts;

  const counts = emptyCounts();
  const modelId = manifest?.modelId ?? DEFAULT_MODEL_ID;
  const promptVersion = manifest?.promptVersion ?? DEFAULT_PROMPT_VERSION;

  const targetByThread = new Map();
  if (manifest) {
    validateApprovedRolloutManifest(manifest);
    if (!dryRun) validateBoundApprovedRolloutManifest(manifest);
    for (const target of manifest.targets) {
      targetByThread.set(target.threadId, target);
    }
  }

  const threadIds = manifest ? [...targetByThread.keys()] : null;
  const threads = await driver.listThreads({ threadIds });
  const byId = new Map(threads.map((t) => [t.threadId, t]));

  if (manifest) {
    for (const threadId of targetByThread.keys()) {
      if (!byId.has(threadId)) {
        throw new Error(`manifest target missing from database / absent from live rows: ${threadId}`);
      }
    }
  }

  const emails = [
    ...new Set(
      threads
        .map((t) => (t.latestInboundFrom ? String(t.latestInboundFrom).toLowerCase() : null))
        .filter(Boolean),
    ),
  ];
  const preferences = await driver.listSenderPreferences(emails);

  /** @type {RetagThreadRow[]} */
  let candidates = threads;
  if (fromDomain) {
    candidates = threads.filter((row) => {
      if (!row.hasInbound) return true; // keep outbound-only for skip counting
      const from = row.latestInboundFrom ?? '';
      return from.endsWith(`@${fromDomain}`);
    });
  }

  counts.scanned = candidates.length;

  for (const row of candidates) {
    if (!row.hasInbound || !row.latestInboundId) {
      counts.skippedOutboundOnly += 1;
      continue;
    }

    if (row.spamUserLockedAt) {
      counts.skippedLocked += 1;
      continue;
    }

    const from = row.latestInboundFrom ? String(row.latestInboundFrom).toLowerCase() : '';
    const pref = from ? preferences.get(from) : null;
    if (pref === 'block') {
      counts.skippedBlocked += 1;
      continue;
    }
    if (pref === 'allow') {
      counts.skippedAllowed += 1;
      continue;
    }

    if (fromDomain && !row.spamAt && !includeNonSpam) {
      // subset repair historically only retagged spam-tagged domain mail;
      // --include-non-spam opens quality Automate/domain repair for Bookings misfiles
      counts.skippedNotSpam += 1;
      continue;
    }

    if (manifest) {
      const target = targetByThread.get(row.threadId);
      if (!target) {
        throw new Error(`row absent from the manifest: ${row.threadId}`);
      }
      const triggerHash = computeTriggerHash({
        threadId: row.threadId,
        triggerMessageId: row.latestInboundId,
        createdAt: isoOrNull(row.latestInboundCreatedAt),
      });
      if (
        target.triggerMessageId !== row.latestInboundId ||
        target.triggerHash !== triggerHash
      ) {
        throw new Error(
          `trigger drift for thread ${row.threadId}: manifest=${target.triggerMessageId} live=${row.latestInboundId}`,
        );
      }
      const preStateHash = computePreStateHash({
        spamAt: isoOrNull(row.spamAt),
        spamUserLockedAt: isoOrNull(row.spamUserLockedAt),
        aiCategorySlugs: row.aiCategorySlugs ?? [],
      });
      if (target.preStateHash !== preStateHash) {
        throw new Error(`pre-state drift for thread ${row.threadId}`);
      }
    }

    counts.eligible += 1;
    const idempotencyKey = retagIdempotencyKey(row.latestInboundId, keyPrefix);

    if (dryRun) {
      const existing = await driver.probeKeys([idempotencyKey]);
      if (existing.has(idempotencyKey)) {
        counts.collisions += 1;
      } else {
        counts.wouldInsert += 1;
      }
      continue;
    }

    await driver.transaction(async (tx) => {
      // The preflight row above is only a candidate list. Re-read and lock the
      // thread here so trigger/pre-state/lock checks and both mutations share
      // one serialization point.
      const live = await tx.lockThreadForUpdate(row.threadId);
      if (!live) {
        throw new Error(`manifest target missing from database: ${row.threadId}`);
      }
      if (!live.hasInbound || !live.latestInboundId) {
        counts.skippedOutboundOnly += 1;
        return;
      }
      if (live.spamUserLockedAt) {
        counts.skippedLocked += 1;
        return;
      }
      const liveFrom = live.latestInboundFrom ? String(live.latestInboundFrom).toLowerCase() : '';
      const livePreference = liveFrom ? await tx.getSenderPreference(liveFrom) : null;
      if (livePreference === 'block') {
        counts.skippedBlocked += 1;
        return;
      }
      if (livePreference === 'allow') {
        counts.skippedAllowed += 1;
        return;
      }
      if (fromDomain && !live.spamAt && !includeNonSpam) {
        counts.skippedNotSpam += 1;
        return;
      }
      if (manifest) {
        const target = targetByThread.get(live.threadId);
        if (!target) throw new Error(`row absent from the manifest: ${live.threadId}`);
        const triggerHash = computeTriggerHash({
          threadId: live.threadId,
          triggerMessageId: live.latestInboundId,
          createdAt: isoOrNull(live.latestInboundCreatedAt),
        });
        if (target.triggerMessageId !== live.latestInboundId || target.triggerHash !== triggerHash) {
          throw new Error(`trigger drift for thread ${live.threadId}: manifest=${target.triggerMessageId} live=${live.latestInboundId}`);
        }
        const preStateHash = computePreStateHash({
          spamAt: isoOrNull(live.spamAt),
          spamUserLockedAt: isoOrNull(live.spamUserLockedAt),
          aiCategorySlugs: live.aiCategorySlugs ?? [],
        });
        if (target.preStateHash !== preStateHash) {
          throw new Error(`pre-state drift for thread ${live.threadId}`);
        }
      }

      const liveIdempotencyKey = retagIdempotencyKey(live.latestInboundId, keyPrefix);
      const insertedId = await tx.insertRunReturning({
        id: randomUUID(),
        threadId: live.threadId,
        triggerMessageId: live.latestInboundId,
        idempotencyKey: liveIdempotencyKey,
        modelId,
        promptVersion,
        promptHash: manifest?.promptHash ?? null,
        metrics: { retagPending: true },
        now,
      });

      if (!insertedId) {
        counts.collisions += 1;
        return;
      }

      counts.inserted += 1;
      counts.mutated += 1;
    });
  }

  return {
    mode: dryRun ? 'dry-run' : 'apply',
    transportId: TRANSPORT_ID,
    promptVersion,
    modelId,
    keyPrefix,
    fromDomain,
    includeNonSpam: Boolean(includeNonSpam),
    targets: manifest ? manifest.targets.length : null,
    manifestHash: manifest?.manifestHash ?? null,
    ...counts,
  };
}

function isMain() {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
  return import.meta.url === entry;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }

  const manifest = args.targetsPath ? loadApprovedRolloutManifest(args.targetsPath) : null;
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { ssl: sslOptions(), max: 1, connect_timeout: 30 });
  try {
    const summary = await runCenturionRetag({
      driver: createPostgresRetagDriver(sql),
      dryRun: args.dryRun,
      keyPrefix: args.keyPrefix,
      fromDomain: args.fromDomain,
      includeNonSpam: args.includeNonSpam,
      manifest,
    });
    console.log(JSON.stringify(summary));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
