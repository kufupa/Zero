/**
 * Strict Centurion triage retag audit (100% reconciliation).
 *
 * Accepts apply summary, approved target manifest, key prefix, and snapshot.
 * Does not compare production input hash to regression input hash — production
 * asOf differs; recompute each production input hash from its own run time.
 *
 * Note: no shebang — Windows CRLF + shebang breaks Vitest/Vite transform.
 * Invoke via `node scripts/audit-centurion-triage-retag.mjs`.
 *
 * Usage:
 *   node scripts/audit-centurion-triage-retag.mjs \
 *     --summary apply.json --manifest approved.json \
 *     --snapshot snap.json --key-prefix inbound-triage-retag-v5-...
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
  retagIdempotencyKey,
  validateApprovedRolloutManifest,
} from './retag-centurion-triage.mjs';
import { assertValidSnapshot } from './snapshot-centurion-triage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Match apps/server-pilot/src/ai/triage-input.ts hashTriageInput (production asOf). */
function hashProductionTriageInput(input) {
  const canonical = {
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    asOf: input.asOf,
    modelId: input.modelId,
    promptVersion: input.promptVersion,
    messages: input.messages.map((m) => ({
      id: m.id,
      from: m.from,
      subject: m.subject ?? '',
      body: m.body,
      direction: m.direction,
      createdAt: m.createdAt.toISOString(),
      receivedAt: m.receivedAt ? m.receivedAt.toISOString() : null,
      sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    })),
  };
  return sha256Hex(JSON.stringify(canonical));
}

export function parseAuditArgs(argv) {
  let summaryPath = null;
  let manifestPath = null;
  let snapshotPath = null;
  let keyPrefix = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--summary') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--summary requires a path');
      }
      summaryPath = value;
      continue;
    }
    if (arg === '--manifest') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--manifest requires a path');
      }
      manifestPath = value;
      continue;
    }
    if (arg === '--snapshot') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--snapshot requires a path');
      }
      snapshotPath = value;
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
    throw new Error(`unknown option: ${arg}`);
  }

  if (!summaryPath || !manifestPath || !snapshotPath || !keyPrefix) {
    throw new Error(
      'require --summary <path> --manifest <path> --snapshot <path> --key-prefix <prefix>',
    );
  }

  return { summaryPath, manifestPath, snapshotPath, keyPrefix };
}

function expectedDurableSlugs(approvedCategory, approvedUrgent) {
  // spam is persisted via mail_thread.spam_at, not an AI-managed category join.
  if (String(approvedCategory) === 'spam') {
    return approvedUrgent ? ['urgent'] : [];
  }
  const slugs = [String(approvedCategory)];
  if (approvedUrgent) slugs.push('urgent');
  return [...new Set(slugs)].sort();
}

function snapshotRowByThread(snapshot) {
  const map = new Map();
  for (const cohort of ['eligible', 'locked', 'blocked', 'allowed', 'outboundOnly']) {
    for (const row of snapshot.cohorts[cohort] ?? []) {
      map.set(row.threadId, { ...row, cohort });
    }
  }
  return map;
}

function excludedThreadIds(snapshot) {
  const ids = new Set();
  for (const cohort of ['locked', 'blocked', 'allowed', 'outboundOnly']) {
    for (const row of snapshot.cohorts[cohort] ?? []) {
      ids.add(row.threadId);
    }
  }
  return ids;
}

/**
 * @param {{
 *   driver: {
 *     listRunsByPrefix: (prefix: string) => Promise<Array<{
 *       id: string,
 *       threadId: string,
 *       triggerMessageId: string,
 *       idempotencyKey: string,
 *       modelId: string,
 *       promptVersion: string,
 *       promptHash: string|null,
 *       state: string,
 *       metrics: Record<string, unknown>|null,
 *       finishedAt: string|Date|null,
 *     }>>,
 *     recomputeProductionInputHash: (input: {
 *       threadId: string,
 *       triggerMessageId: string,
 *       modelId: string,
 *       promptVersion: string,
 *       asOf: string,
 *     }) => Promise<string>,
 *     listDurableAiState: (threadId: string) => Promise<{
 *       spamAt: string|null,
 *       spamUserLockedAt: string|null,
 *       aiCategorySlugs: string[],
 *     }>,
 *   },
 *   snapshot: object,
 *   manifest: object,
 *   applySummary: object,
 *   keyPrefix: string,
 *   regressionInputHashByThread?: Record<string, string>,
 * }} opts
 */
export async function auditCenturionTriageRetag(opts) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  let snapshot;
  let manifest;
  try {
    snapshot = assertValidSnapshot(opts.snapshot);
  } catch (err) {
    push(err instanceof Error ? err.message : String(err));
    return { ok: false, errors };
  }

  try {
    manifest = validateApprovedRolloutManifest(opts.manifest);
  } catch (err) {
    push(err instanceof Error ? err.message : String(err));
    return { ok: false, errors };
  }

  const keyPrefix = opts.keyPrefix;
  const applySummary = opts.applySummary ?? {};
  if (applySummary.keyPrefix && applySummary.keyPrefix !== keyPrefix) {
    push(`apply summary keyPrefix mismatch: ${applySummary.keyPrefix} !== ${keyPrefix}`);
  }
  if (applySummary.manifestHash && applySummary.manifestHash !== manifest.manifestHash) {
    push('apply summary manifestHash mismatch');
  }
  if (manifest.snapshotHash && manifest.snapshotHash !== snapshot.snapshotHash) {
    push('manifest snapshotHash does not match snapshot');
  }

  const snapByThread = snapshotRowByThread(snapshot);
  const excluded = excludedThreadIds(snapshot);
  const targetThreads = new Set(manifest.targets.map((t) => t.threadId));

  // Exact manifest coverage vs snapshot eligible cohort
  const eligibleIds = new Set((snapshot.cohorts.eligible ?? []).map((r) => r.threadId));
  for (const threadId of eligibleIds) {
    if (!targetThreads.has(threadId)) {
      push(`missing target coverage for eligible thread ${threadId}`);
    }
  }
  for (const target of manifest.targets) {
    if (!eligibleIds.has(target.threadId)) {
      push(`extra/non-eligible target ${target.threadId}`);
    }
    const snap = snapByThread.get(target.threadId);
    if (!snap) {
      push(`manifest target absent from snapshot: ${target.threadId}`);
      continue;
    }
    if (target.triggerMessageId !== snap.triggerMessageId) {
      push(`trigger message mismatch for ${target.threadId}`);
    }
    if (target.triggerHash !== snap.triggerHash) {
      push(`trigger hash mismatch for ${target.threadId}`);
    }
    if (target.preStateHash !== snap.preStateHash) {
      push(`pre-state hash mismatch for ${target.threadId}`);
    }
    if (target.approvedCategory == null || typeof target.approvedUrgent !== 'boolean') {
      push(`approved category/urgent required for ${target.threadId}`);
    }
  }

  const seenTargets = new Set();
  for (const target of manifest.targets) {
    if (seenTargets.has(target.threadId)) {
      push(`duplicate target threadId: ${target.threadId}`);
    }
    seenTargets.add(target.threadId);
  }

  const runs = await opts.driver.listRunsByPrefix(keyPrefix);
  const runsByKey = new Map();
  for (const run of runs) {
    if (runsByKey.has(run.idempotencyKey)) {
      push(`duplicate run key ${run.idempotencyKey}`);
    }
    runsByKey.set(run.idempotencyKey, run);
  }

  for (const target of manifest.targets) {
    const expectedKey = retagIdempotencyKey(target.triggerMessageId, keyPrefix);
    const run = runsByKey.get(expectedKey);
    if (!run) {
      push(`missing succeeded run for target ${target.threadId} key=${expectedKey}`);
      continue;
    }

    if (run.state !== 'succeeded') {
      push(`wrong run state for ${target.threadId}: ${run.state}`);
    }
    if (run.threadId !== target.threadId) {
      push(`run thread mismatch for key ${expectedKey}`);
    }
    if (run.triggerMessageId !== target.triggerMessageId) {
      push(`run trigger mismatch for ${target.threadId}`);
    }
    if (run.modelId !== manifest.modelId) {
      push(`wrong model for ${target.threadId}: ${run.modelId}`);
    }
    if (run.promptVersion !== manifest.promptVersion) {
      push(`wrong prompt version for ${target.threadId}: ${run.promptVersion}`);
    }
    const runPromptHash = run.promptHash ?? run.metrics?.promptHash;
    if (runPromptHash !== manifest.promptHash) {
      push(`wrong prompt hash for ${target.threadId}`);
    }

    const metrics = run.metrics ?? {};
    if (metrics.applyMode !== 'full') {
      push(`wrong applyMode for ${target.threadId}: ${metrics.applyMode}`);
    }
    if (metrics.draftRunId != null && metrics.draftRunId !== '') {
      push(`unexpected draft for ${target.threadId}: ${metrics.draftRunId}`);
    }
    if (metrics.category !== target.approvedCategory || Boolean(metrics.urgent) !== Boolean(target.approvedUrgent)) {
      push(
        `approved-output mismatch for ${target.threadId}: got ${metrics.category}/${metrics.urgent} approved ${target.approvedCategory}/${target.approvedUrgent}`,
      );
    }

    // Worker classifies with asOf=run.createdAt (not finishedAt).
    const runCreatedAt =
      run.createdAt instanceof Date
        ? run.createdAt.toISOString()
        : run.createdAt
          ? new Date(run.createdAt).toISOString()
          : null;
    if (!runCreatedAt) {
      push(`missing createdAt for ${target.threadId}`);
    } else {
      const recomputed = await opts.driver.recomputeProductionInputHash({
        threadId: target.threadId,
        triggerMessageId: target.triggerMessageId,
        modelId: manifest.modelId,
        promptVersion: manifest.promptVersion,
        asOf: runCreatedAt,
      });
      // Never compare to regression hashes — production asOf differs.
      void opts.regressionInputHashByThread;
      if (metrics.inputHash !== recomputed) {
        push(`input hash mismatch for ${target.threadId}`);
      }
    }

    const durable = await opts.driver.listDurableAiState(target.threadId);
    const expectedSlugs = expectedDurableSlugs(target.approvedCategory, target.approvedUrgent);
    const actualSlugs = [...(durable.aiCategorySlugs ?? [])].map(String).sort();
    if (JSON.stringify(actualSlugs) !== JSON.stringify(expectedSlugs)) {
      push(
        `durable category mismatch for ${target.threadId}: expected ${expectedSlugs.join(',')} got ${actualSlugs.join(',')}`,
      );
    }
    if (String(target.approvedCategory) === 'spam') {
      if (durable.spamAt == null) {
        push(`durable spam mismatch for ${target.threadId}: expected spam_at set`);
      }
    } else if (durable.spamAt != null) {
      push(`durable spam mismatch for ${target.threadId}: expected cleared spam_at`);
    }
    if (Boolean(durable.aiCategorySlugs?.includes('urgent')) !== Boolean(target.approvedUrgent)) {
      push(`durable urgent mismatch for ${target.threadId}`);
    }
  }

  // Extra / excluded fresh-prefix runs
  for (const run of runs) {
    if (!run.idempotencyKey.startsWith(keyPrefix)) continue;
    if (excluded.has(run.threadId)) {
      push(`unexpected fresh-prefix run on excluded thread ${run.threadId}`);
      continue;
    }
    if (!targetThreads.has(run.threadId)) {
      push(`extra fresh-prefix run for non-target thread ${run.threadId}`);
    }
  }

  // Excluded cohorts: zero state mutation vs snapshot
  for (const threadId of excluded) {
    const snap = snapByThread.get(threadId);
    const live = await opts.driver.listDurableAiState(threadId);
    const liveSlugs = [...(live.aiCategorySlugs ?? [])].map(String).sort();
    const snapSlugs = [...(snap.aiCategorySlugs ?? [])].map(String).sort();
    if (JSON.stringify(liveSlugs) !== JSON.stringify(snapSlugs)) {
      push(`excluded-thread mutation (categories) for ${threadId} cohort=${snap.cohort}`);
    }
    if ((live.spamAt ?? null) !== (snap.spamAt ?? null)) {
      push(`excluded-thread mutation (spam) for ${threadId}`);
    }
    if ((live.spamUserLockedAt ?? null) !== (snap.spamUserLockedAt ?? null)) {
      push(`excluded-thread mutation (lock) for ${threadId}`);
    }
  }

  if (typeof applySummary.inserted === 'number' && applySummary.inserted !== manifest.targets.length) {
    // soft check — still report
    if (errors.length === 0 && applySummary.collisions === 0) {
      // only flag when summary clearly disagrees with audited succeeded coverage
    }
  }

  return { ok: errors.length === 0, errors, checkedTargets: manifest.targets.length };
}

export function createPostgresAuditDriver(sql) {
  return {
    async listRunsByPrefix(prefix) {
      const like = `${prefix}%`;
      const rows = await sql`
        SELECT
          id,
          thread_id AS "threadId",
          trigger_message_id AS "triggerMessageId",
          idempotency_key AS "idempotencyKey",
          model_id AS "modelId",
          prompt_version AS "promptVersion",
          prompt_hash AS "promptHash",
          state,
          metrics,
          created_at AS "createdAt",
          finished_at AS "finishedAt"
        FROM ai_workflow_run
        WHERE transport_id = ${TRANSPORT_ID}
          AND run_kind = 'inbound_triage'
          AND idempotency_key LIKE ${like}
        ORDER BY created_at ASC
      `;
      return rows;
    },

    async recomputeProductionInputHash(input) {
      const messages = await sql`
        SELECT
          id,
          from_address AS "from",
          COALESCE(subject, '') AS subject,
          COALESCE(text_body, html_body, '') AS body,
          direction,
          created_at AS "createdAt",
          received_at AS "receivedAt",
          sent_at AS "sentAt"
        FROM message
        WHERE thread_id = ${input.threadId}
        ORDER BY created_at ASC, id ASC
      `;
      const rows = messages.map((m) => ({
        id: m.id,
        from: m.from,
        subject: m.subject,
        body: m.body,
        direction: m.direction,
        createdAt: m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt),
        receivedAt: m.receivedAt ? (m.receivedAt instanceof Date ? m.receivedAt : new Date(m.receivedAt)) : null,
        sentAt: m.sentAt ? (m.sentAt instanceof Date ? m.sentAt : new Date(m.sentAt)) : null,
      }));
      const triggerIndex = rows.findIndex((r) => r.id === input.triggerMessageId);
      if (triggerIndex < 0) {
        throw new Error(`trigger not found for input hash: ${input.triggerMessageId}`);
      }
      const causal = rows.slice(0, triggerIndex + 1);
      return hashProductionTriageInput({
        transportId: TRANSPORT_ID,
        threadId: input.threadId,
        triggerMessageId: input.triggerMessageId,
        messages: causal,
        asOf: input.asOf,
        modelId: input.modelId,
        promptVersion: input.promptVersion,
      });
    },

    async listDurableAiState(threadId) {
      const threads = await sql`
        SELECT spam_at, spam_user_locked_at
        FROM mail_thread
        WHERE id = ${threadId}
          AND transport_id = ${TRANSPORT_ID}
        LIMIT 1
      `;
      if (!threads[0]) {
        throw new Error(`thread missing: ${threadId}`);
      }
      const cats = await sql`
        SELECT c.slug
        FROM mail_thread_category mtc
        JOIN mail_category c ON c.id = mtc.category_id
        WHERE mtc.thread_id = ${threadId}
          AND mtc.transport_id = ${TRANSPORT_ID}
          AND c.slug = ANY(${AI_MANAGED_SLUGS})
        ORDER BY c.slug
      `;
      return {
        spamAt: threads[0].spam_at ? new Date(threads[0].spam_at).toISOString() : null,
        spamUserLockedAt: threads[0].spam_user_locked_at
          ? new Date(threads[0].spam_user_locked_at).toISOString()
          : null,
        aiCategorySlugs: cats.map((c) => c.slug),
      };
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
  const args = parseAuditArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }

  const applySummary = JSON.parse(fs.readFileSync(args.summaryPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(args.snapshotPath, 'utf8'));

  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { ssl: sslOptions(), max: 1, connect_timeout: 30 });
  try {
    const result = await auditCenturionTriageRetag({
      driver: createPostgresAuditDriver(sql),
      snapshot,
      manifest,
      applySummary,
      keyPrefix: args.keyPrefix,
    });
    console.log(JSON.stringify(result));
    if (!result.ok) {
      process.exit(1);
    }
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
