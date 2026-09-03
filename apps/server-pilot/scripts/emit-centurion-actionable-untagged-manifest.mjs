/**
 * Emit a bound Centurion retag manifest for actionable inbound-untagged threads.
 *
 * Usage (EC2, with DATABASE_URL):
 *   node scripts/emit-centurion-actionable-untagged-manifest.mjs \
 *     --out-snapshot snap.json --out-targets targets.json
 *
 * Pure helpers are exported for Vitest (no DB).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isActionableInboundUntagged,
  isFixtureAllowlistedUntagged,
} from '../src/ops/centurion-actionable-untagged.ts';
import {
  TRANSPORT_ID,
  DEFAULT_MODEL_ID,
  DEFAULT_PROMPT_VERSION,
  computeCanonicalManifestHash,
  computePreStateHash,
  computeTriggerHash,
  validateBoundApprovedRolloutManifest,
  createPostgresRetagDriver,
} from './retag-centurion-triage.mjs';
import {
  assertValidSnapshot,
  computeCanonicalSnapshotHash,
  writePrivateJson,
} from './snapshot-centurion-triage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * @typedef {object} ActionableRow
 * @property {string} threadId
 * @property {string|null} spamAt
 * @property {string|null} spamUserLockedAt
 * @property {boolean} hasInbound
 * @property {string|null} latestInboundId
 * @property {string|null} latestInboundFrom
 * @property {string|null} latestInboundCreatedAt
 * @property {string|null} subject
 * @property {string[]} aiCategorySlugs
 */

export function selectActionableRows(rows) {
  return rows.filter((row) =>
    isActionableInboundUntagged({
      threadId: row.threadId,
      spamAt: row.spamAt,
      hasInbound: Boolean(row.hasInbound && row.latestInboundId),
      hasCategory: (row.aiCategorySlugs ?? []).length > 0,
      latestInboundFrom: row.latestInboundFrom,
      subject: row.subject,
    }),
  );
}

/**
 * Build snapshot + bound retag manifest for repair (re-classify via worker).
 * Approved folder is placeholder unknown-review; model output wins at apply.
 */
export function buildActionableUntaggedRepairArtifacts(opts) {
  const {
    rows,
    generatedAt = new Date().toISOString(),
    modelId = DEFAULT_MODEL_ID,
    promptVersion = DEFAULT_PROMPT_VERSION,
    promptHash,
    sourceLabel = 'deadletter-untagged-repair',
  } = opts;
  if (!promptHash || !/^[a-f0-9]{64}$/i.test(promptHash)) {
    throw new Error('promptHash must be sha256 hex');
  }

  const actionable = selectActionableRows(rows);
  const eligible = actionable.map((row) => {
    const triggerCreatedAt = row.latestInboundCreatedAt;
    const triggerMessageId = row.latestInboundId;
    if (!triggerMessageId || !triggerCreatedAt) {
      throw new Error(`actionable row missing trigger: ${row.threadId}`);
    }
    const spamAt = row.spamAt ?? null;
    const spamUserLockedAt = row.spamUserLockedAt ?? null;
    const aiCategorySlugs = [...(row.aiCategorySlugs ?? [])].map(String).sort();
    return {
      threadId: row.threadId,
      cohort: 'eligible',
      triggerMessageId,
      triggerCreatedAt,
      latestSender: row.latestInboundFrom ?? null,
      policyState: 'none',
      spamAt,
      spamUserLockedAt,
      aiCategorySlugs,
      customCategoryPresenceHash: createHash('sha256').update('[]').digest('hex'),
      triggerHash: computeTriggerHash({
        threadId: row.threadId,
        triggerMessageId,
        createdAt: triggerCreatedAt,
      }),
      preStateHash: computePreStateHash({
        spamAt,
        spamUserLockedAt,
        aiCategorySlugs,
      }),
    };
  });

  const snapshotBody = {
    version: 1,
    transportId: TRANSPORT_ID,
    generatedAt,
    cohorts: {
      eligible,
      locked: [],
      blocked: [],
      allowed: [],
      outboundOnly: [],
    },
  };
  const snapshot = {
    ...snapshotBody,
    snapshotHash: computeCanonicalSnapshotHash(snapshotBody),
  };
  assertValidSnapshot(snapshot);

  const sourceHash = createHash('sha256').update(sourceLabel).digest('hex');
  const unboundTargets = eligible.map((row) => ({
    threadId: row.threadId,
    triggerMessageId: row.triggerMessageId,
    triggerHash: row.triggerHash,
    preStateHash: row.preStateHash,
  }));

  const unboundBody = {
    version: 1,
    transportId: TRANSPORT_ID,
    generatedAt,
    modelId,
    promptVersion,
    promptHash: promptHash.toLowerCase(),
    snapshotHash: snapshot.snapshotHash,
    targets: unboundTargets,
  };

  const targets = unboundTargets.map((target) => {
    const rehearsalResultHash = createHash('sha256')
      .update(`rehearsal:${target.threadId}:${sourceHash}`)
      .digest('hex');
    return {
      ...target,
      approvedCategory: 'unknown-review',
      approvedPrimaryFolder: 'unknown-review',
      approvedIsSpam: false,
      approvedUrgent: false,
      sourceHash,
      rehearsalResultHash,
    };
  });

  const boundBody = {
    ...unboundBody,
    sourceHash,
    targets,
  };
  const manifest = {
    ...boundBody,
    manifestHash: computeCanonicalManifestHash(boundBody),
  };
  validateBoundApprovedRolloutManifest(manifest);

  return {
    snapshot,
    manifest,
    actionableCount: actionable.length,
    skippedFixtureCount: rows.filter((r) =>
      isFixtureAllowlistedUntagged({
        latestInboundFrom: r.latestInboundFrom,
        subject: r.subject,
      }),
    ).length,
  };
}

function parseArgs(argv) {
  let outSnapshot = null;
  let outTargets = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out-snapshot') {
      outSnapshot = argv[++i];
      continue;
    }
    if (arg === '--out-targets') {
      outTargets = argv[++i];
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (!outSnapshot || !outTargets) {
    throw new Error('require --out-snapshot <path> and --out-targets <path>');
  }
  return { outSnapshot, outTargets };
}

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

function isoOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export function createPostgresActionableDriver(sql) {
  const retagDriver = createPostgresRetagDriver(sql);
  return {
    async listCandidateRows() {
      const idRows = await sql`
        SELECT t.id AS thread_id, t.subject
        FROM mail_thread t
        WHERE t.transport_id = ${TRANSPORT_ID}
          AND t.spam_at IS NULL
          AND EXISTS (
            SELECT 1 FROM message m
            WHERE m.thread_id = t.id AND m.direction = 'inbound'
          )
          AND NOT EXISTS (
            SELECT 1 FROM mail_thread_category mtc WHERE mtc.thread_id = t.id
          )
      `;
      if (idRows.length === 0) return [];
      const threadIds = idRows.map((r) => String(r.thread_id));
      const subjectById = new Map(
        idRows.map((r) => [String(r.thread_id), r.subject != null ? String(r.subject) : null]),
      );
      const live = await retagDriver.listThreads({ threadIds });
      return live.map((row) => ({
        threadId: String(row.threadId),
        spamAt: row.spamAt != null ? isoOrNull(row.spamAt) : null,
        spamUserLockedAt:
          row.spamUserLockedAt != null ? isoOrNull(row.spamUserLockedAt) : null,
        hasInbound: Boolean(row.hasInbound),
        latestInboundId: row.latestInboundId ? String(row.latestInboundId) : null,
        latestInboundFrom: row.latestInboundFrom ? String(row.latestInboundFrom) : null,
        latestInboundCreatedAt:
          row.latestInboundCreatedAt != null ? isoOrNull(row.latestInboundCreatedAt) : null,
        subject: subjectById.get(String(row.threadId)) ?? null,
        aiCategorySlugs: Array.isArray(row.aiCategorySlugs)
          ? row.aiCategorySlugs.map(String)
          : [],
      }));
    },
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
  const promptHash =
    process.env.SNAPSHOT_PROMPT_HASH ??
    createHash('sha256').update('triage-v6-deadletter-repair').digest('hex');

  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { ssl: sslOptions(), max: 1, connect_timeout: 30 });
  try {
    const driver = createPostgresActionableDriver(sql);
    const rows = await driver.listCandidateRows();
    const artifacts = buildActionableUntaggedRepairArtifacts({
      rows,
      promptHash,
      modelId: process.env.SNAPSHOT_MODEL_ID ?? DEFAULT_MODEL_ID,
      promptVersion: process.env.SNAPSHOT_PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION,
    });
    writePrivateJson(args.outSnapshot, artifacts.snapshot);
    writePrivateJson(args.outTargets, artifacts.manifest);
    console.log(
      JSON.stringify({
        outSnapshot: args.outSnapshot,
        outTargets: args.outTargets,
        actionableCount: artifacts.actionableCount,
        skippedFixtureCount: artifacts.skippedFixtureCount,
        snapshotHash: artifacts.snapshot.snapshotHash,
        manifestHash: artifacts.manifest.manifestHash,
        keyPrefixHint: `inbound-triage-retag-v6-dl-repair-${new Date()
          .toISOString()
          .replace(/[-:TZ.]/g, '')
          .slice(0, 12)}`,
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
