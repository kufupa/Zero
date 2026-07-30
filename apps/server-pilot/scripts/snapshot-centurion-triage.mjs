/**
 * Centurion triage snapshot + hashed target-manifest emitter.
 *
 * Note: no shebang — Windows CRLF + shebang breaks Vitest/Vite transform.
 * Invoke via `node scripts/snapshot-centurion-triage.mjs`.
 *
 * Usage:
 *   node scripts/snapshot-centurion-triage.mjs --out snap.json --targets-out targets.json
 *
 * Env: DATABASE_URL (+ deploy/rds-ca-global.pem for SSL when present)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AI_MANAGED_SLUGS,
  TRANSPORT_ID,
  computeCanonicalManifestHash,
  computePreStateHash,
  computeTriggerHash,
  validateApprovedRolloutManifest,
} from './retag-centurion-triage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

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

function isoOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function computeCustomCategoryPresenceHash(slugs) {
  const sorted = [...(slugs ?? [])].map(String).sort();
  return sha256Hex(stableStringify({ customCategorySlugs: sorted }));
}

export function computeCanonicalSnapshotHash(snapshot) {
  const { snapshotHash: _ignored, ...withoutHash } = snapshot;
  return sha256Hex(stableStringify(withoutHash));
}

export function parseSnapshotArgs(argv) {
  let outPath = null;
  let targetsOutPath = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--out requires a path');
      }
      outPath = value;
      continue;
    }
    if (arg === '--targets-out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--targets-out requires a path');
      }
      targetsOutPath = value;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  if (!outPath) {
    throw new Error('--out <snapshot.json> required');
  }

  return { outPath, targetsOutPath };
}

/**
 * SNAPSHOT_PROMPT_HASH required only when emitting targets (--targets-out / bind emit path).
 * Snapshot-only runs may omit it.
 * @param {string|null|undefined} promptHash
 * @param {{ emitTargets: boolean }} opts
 * @returns {string|null}
 */
export function requireSnapshotPromptHash(promptHash, opts) {
  if (!opts?.emitTargets) {
    return null;
  }
  if (!promptHash || !isSha256Hex(promptHash)) {
    throw new Error('SNAPSHOT_PROMPT_HASH (sha256 hex) required to emit targets');
  }
  return promptHash;
}

/**
 * @param {{
 *   threadId: string,
 *   spamAt: string|null,
 *   spamUserLockedAt: string|null,
 *   latestInboundId: string|null,
 *   latestInboundFrom: string|null,
 *   latestInboundCreatedAt: string|null,
 *   aiCategorySlugs: string[],
 *   customCategorySlugs: string[],
 *   hasInbound: boolean,
 * }} row
 * @param {Map<string, 'block'|'allow'>} preferences
 */
export function classifyThreadCohort(row, preferences) {
  if (!row.hasInbound || !row.latestInboundId) {
    return 'outboundOnly';
  }
  if (row.spamUserLockedAt) {
    return 'locked';
  }
  const from = row.latestInboundFrom ? String(row.latestInboundFrom).toLowerCase() : '';
  const pref = from ? preferences.get(from) : null;
  if (pref === 'block') return 'blocked';
  if (pref === 'allow') return 'allowed';
  return 'eligible';
}

function buildThreadRecord(row, preferences) {
  const cohort = classifyThreadCohort(row, preferences);
  const from = row.latestInboundFrom ? String(row.latestInboundFrom).toLowerCase() : null;
  const pref = from ? preferences.get(from) ?? null : null;
  let policyState = 'none';
  if (cohort === 'outboundOnly') policyState = 'outbound_only';
  else if (cohort === 'locked') policyState = 'locked';
  else if (pref === 'block') policyState = 'block';
  else if (pref === 'allow') policyState = 'allow';

  const spamAt = isoOrNull(row.spamAt);
  const spamUserLockedAt = isoOrNull(row.spamUserLockedAt);
  const aiCategorySlugs = [...(row.aiCategorySlugs ?? [])].map(String).sort();
  const customCategorySlugs = [...(row.customCategorySlugs ?? [])].map(String).sort();
  const triggerMessageId = row.latestInboundId ?? null;
  const triggerCreatedAt = isoOrNull(row.latestInboundCreatedAt);

  return {
    threadId: row.threadId,
    cohort,
    triggerMessageId,
    triggerCreatedAt,
    latestSender: from,
    policyState,
    spamAt,
    spamUserLockedAt,
    aiCategorySlugs,
    customCategoryPresenceHash: computeCustomCategoryPresenceHash(customCategorySlugs),
    triggerHash:
      triggerMessageId && triggerCreatedAt
        ? computeTriggerHash({
            threadId: row.threadId,
            triggerMessageId,
            createdAt: triggerCreatedAt,
          })
        : null,
    preStateHash: computePreStateHash({
      spamAt,
      spamUserLockedAt,
      aiCategorySlugs,
    }),
  };
}

/**
 * @param {{
 *   driver: {
 *     listThreads: () => Promise<any[]>,
 *     listSenderPreferences: (emails: string[]) => Promise<Map<string, 'block'|'allow'>>,
 *   },
 *   generatedAt?: string,
 * }} opts
 */
export async function buildCenturionTriageSnapshot(opts) {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const threads = await opts.driver.listThreads();
  const emails = [
    ...new Set(
      threads
        .map((t) => (t.latestInboundFrom ? String(t.latestInboundFrom).toLowerCase() : null))
        .filter(Boolean),
    ),
  ];
  const preferences = await opts.driver.listSenderPreferences(emails);

  const cohorts = {
    eligible: [],
    locked: [],
    blocked: [],
    allowed: [],
    outboundOnly: [],
  };

  for (const row of threads) {
    const record = buildThreadRecord(row, preferences);
    cohorts[record.cohort].push(record);
  }

  for (const key of Object.keys(cohorts)) {
    cohorts[key].sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
  }

  const snapshot = {
    version: 1,
    transportId: TRANSPORT_ID,
    generatedAt,
    cohorts,
  };
  return {
    ...snapshot,
    snapshotHash: computeCanonicalSnapshotHash(snapshot),
  };
}

export function assertValidSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('snapshot must be an object');
  }
  if (snapshot.transportId !== TRANSPORT_ID) {
    throw new Error(`snapshot transportId must be ${TRANSPORT_ID}`);
  }
  if (!snapshot.cohorts || typeof snapshot.cohorts !== 'object') {
    throw new Error('snapshot cohorts required');
  }
  const expected = computeCanonicalSnapshotHash(snapshot);
  if (snapshot.snapshotHash !== expected) {
    throw new Error(`snapshotHash mismatch: expected ${expected}`);
  }
  return snapshot;
}

/**
 * Emit hashed target manifest for eligible cohort only. No raw body.
 * @param {object} snapshot
 * @param {{ modelId: string, promptVersion: string, promptHash: string }} meta
 */
export function emitTargetManifestFromSnapshot(snapshot, meta) {
  assertValidSnapshot(snapshot);
  if (!meta?.modelId || !meta?.promptVersion || !isSha256Hex(meta.promptHash)) {
    throw new Error('emitTargetManifestFromSnapshot requires modelId, promptVersion, promptHash');
  }

  const targets = snapshot.cohorts.eligible.map((row) => ({
    threadId: row.threadId,
    triggerMessageId: row.triggerMessageId,
    triggerHash: row.triggerHash,
    preStateHash: row.preStateHash,
  }));

  const body = {
    version: 1,
    transportId: TRANSPORT_ID,
    generatedAt: snapshot.generatedAt,
    modelId: meta.modelId,
    promptVersion: meta.promptVersion,
    promptHash: meta.promptHash,
    snapshotHash: snapshot.snapshotHash,
    targets,
  };

  const manifest = {
    ...body,
    manifestHash: computeCanonicalManifestHash(body),
  };
  validateApprovedRolloutManifest(manifest);
  return manifest;
}

/**
 * Bind approved refined category/urgent + rehearsal hashes after adjudication.
 * @param {object} manifest
 * @param {{
 *   sourceHash: string,
 *   approvals: Array<{
 *     threadId: string,
 *     approvedCategory: string,
 *     approvedUrgent: boolean,
 *     rehearsalResultHash: string,
 *     sourceHash?: string,
 *   }>,
 * }} binding
 */
export function bindApprovedTargetManifest(manifest, binding) {
  validateApprovedRolloutManifest(manifest);
  if (!isSha256Hex(binding.sourceHash)) {
    throw new Error('sourceHash must be sha256 hex');
  }
  const byThread = new Map(binding.approvals.map((a) => [a.threadId, a]));
  if (byThread.size !== binding.approvals.length) {
    throw new Error('duplicate approval threadId');
  }
  for (const target of manifest.targets) {
    if (!byThread.has(target.threadId)) {
      throw new Error(`missing approval for target ${target.threadId}`);
    }
  }
  for (const threadId of byThread.keys()) {
    if (!manifest.targets.some((t) => t.threadId === threadId)) {
      throw new Error(`approval for non-target thread ${threadId}`);
    }
  }

  const { manifestHash: _ignored, ...withoutHash } = manifest;
  const targets = withoutHash.targets.map((target) => {
    const approval = byThread.get(target.threadId);
    if (!isSha256Hex(approval.rehearsalResultHash)) {
      throw new Error(`rehearsalResultHash must be sha256 hex for ${target.threadId}`);
    }
    return {
      ...target,
      approvedCategory: approval.approvedCategory,
      approvedUrgent: Boolean(approval.approvedUrgent),
      sourceHash: approval.sourceHash ?? binding.sourceHash,
      rehearsalResultHash: approval.rehearsalResultHash,
    };
  });

  const body = {
    ...withoutHash,
    sourceHash: binding.sourceHash,
    targets,
  };
  const bound = {
    ...body,
    manifestHash: computeCanonicalManifestHash(body),
  };
  validateApprovedRolloutManifest(bound);
  return bound;
}

/**
 * Recompute live snapshot-shaped state and compare to frozen snapshot.
 * Detects lock / sender-preference / AI / custom-presence drift.
 */
export async function verifySnapshotAgainstLive(opts) {
  const snapshot = assertValidSnapshot(opts.snapshot);
  const live = await buildCenturionTriageSnapshot({
    driver: opts.driver,
    generatedAt: snapshot.generatedAt,
  });

  for (const cohort of ['eligible', 'locked', 'blocked', 'allowed', 'outboundOnly']) {
    const snapRows = snapshot.cohorts[cohort] ?? [];
    const liveRows = live.cohorts[cohort] ?? [];
    if (snapRows.length !== liveRows.length) {
      throw new Error(
        `cohort ${cohort} count mismatch: snapshot=${snapRows.length} live=${liveRows.length}`,
      );
    }
    const liveById = new Map(liveRows.map((r) => [r.threadId, r]));
    for (const row of snapRows) {
      const liveRow = liveById.get(row.threadId);
      if (!liveRow) {
        throw new Error(`cohort ${cohort} missing live thread ${row.threadId}`);
      }
      if (liveRow.policyState !== row.policyState) {
        throw new Error(
          `policy/preference mismatch for ${row.threadId}: snapshot=${row.policyState} live=${liveRow.policyState}`,
        );
      }
      if (liveRow.spamUserLockedAt !== row.spamUserLockedAt) {
        throw new Error(`lock mismatch for ${row.threadId}`);
      }
      if (liveRow.spamAt !== row.spamAt) {
        throw new Error(`spam mismatch for ${row.threadId}`);
      }
      if (liveRow.preStateHash !== row.preStateHash) {
        throw new Error(`pre-state mismatch for ${row.threadId}`);
      }
      if (liveRow.customCategoryPresenceHash !== row.customCategoryPresenceHash) {
        throw new Error(`custom-category presence mismatch for ${row.threadId}`);
      }
      if (liveRow.triggerHash !== row.triggerHash) {
        throw new Error(`trigger mismatch for ${row.threadId}`);
      }
    }
  }

  if (live.snapshotHash !== snapshot.snapshotHash) {
    throw new Error(
      `snapshotHash mismatch after verify: expected ${snapshot.snapshotHash} live=${live.snapshotHash}`,
    );
  }
  return true;
}

export function createPostgresSnapshotDriver(sql) {
  return {
    async listThreads() {
      const rows = await sql`
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
              AND c.slug = ANY(${AI_MANAGED_SLUGS})
          ), '{}') AS ai_category_slugs,
          COALESCE((
            SELECT array_agg(c.slug ORDER BY c.slug)
            FROM mail_thread_category mtc
            JOIN mail_category c ON c.id = mtc.category_id
            WHERE mtc.thread_id = t.id
              AND mtc.transport_id = ${TRANSPORT_ID}
              AND NOT (c.slug = ANY(${AI_MANAGED_SLUGS}))
          ), '{}') AS custom_category_slugs,
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
        customCategorySlugs: row.custom_category_slugs ?? [],
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
  };
}

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

function isMain() {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
  return import.meta.url === entry;
}

async function main() {
  const args = parseSnapshotArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }

  const modelId = process.env.SNAPSHOT_MODEL_ID ?? 'amazon.nova-lite-v1:0';
  const promptVersion = process.env.SNAPSHOT_PROMPT_VERSION ?? 'triage-v5';
  let promptHash = null;
  try {
    promptHash = requireSnapshotPromptHash(process.env.SNAPSHOT_PROMPT_HASH, {
      emitTargets: Boolean(args.targetsOutPath),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { ssl: sslOptions(), max: 1, connect_timeout: 30 });
  try {
    const driver = createPostgresSnapshotDriver(sql);
    const snapshot = await buildCenturionTriageSnapshot({ driver });
    fs.mkdirSync(path.dirname(path.resolve(args.outPath)), { recursive: true });
    fs.writeFileSync(args.outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

    let targetsPath = args.targetsOutPath;
    if (targetsPath) {
      const manifest = emitTargetManifestFromSnapshot(snapshot, {
        modelId,
        promptVersion,
        promptHash,
      });
      fs.mkdirSync(path.dirname(path.resolve(targetsPath)), { recursive: true });
      fs.writeFileSync(targetsPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }

    console.log(
      JSON.stringify({
        outPath: args.outPath,
        targetsOutPath: targetsPath,
        snapshotHash: snapshot.snapshotHash,
        cohorts: {
          eligible: snapshot.cohorts.eligible.length,
          locked: snapshot.cohorts.locked.length,
          blocked: snapshot.cohorts.blocked.length,
          allowed: snapshot.cohorts.allowed.length,
          outboundOnly: snapshot.cohorts.outboundOnly.length,
        },
      }),
    );
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
