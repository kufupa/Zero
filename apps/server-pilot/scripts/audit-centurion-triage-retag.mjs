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
 *     --snapshot snap.json --key-prefix inbound-triage-retag-v6-...
 *
 * Env: DATABASE_URL (+ deploy/rds-ca-global.pem for SSL when present)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RETAG_UNSETTLE_SLUGS,
  WORKFLOW_PRIMARY_SLUGS,
  TRANSPORT_ID,
  retagIdempotencyKey,
  validateBoundApprovedRolloutManifest,
} from './retag-centurion-triage.mjs';
import { assertValidSnapshot } from './snapshot-centurion-triage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

const RESERVE_CLOUD_PENNY_EMAIL = 'pmbobo@eu.mail.reservecloud.com';
const LEGACY_PENNY_EMAIL = 'pmbobo@legacyhotels.co.za';

function normalizeEmailAddress(raw) {
  const trimmed = String(raw ?? '').trim();
  const angleMatch = trimmed.match(/<([^>]+)>/);
  const email = angleMatch ? angleMatch[1].trim() : trimmed;
  return email.toLowerCase();
}

function canonicalAddresses(value) {
  const values = typeof value === 'string' ? value.split(/[,;]/) : (value ?? []);
  return values
    .map((address) => String(address ?? '').trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function canonicalThreadSignals(signals) {
  return {
    legacyHotelsOutboundResponse: signals?.legacyHotelsOutboundResponse === true,
    reserveCloudStaffOutbound: signals?.reserveCloudStaffOutbound === true,
    reserveCloudStaffOutboundFrom:
      signals?.reserveCloudStaffOutboundFrom?.trim().toLowerCase() ?? null,
    reserveCloudStaffOutboundRecipients: canonicalAddresses(
      signals?.reserveCloudStaffOutboundRecipients,
    ),
  };
}

/** Match apps/server-pilot/src/ai/triage-input.ts hashTriageInput (production asOf). */
export function hashProductionTriageInput(input) {
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
      to: canonicalAddresses(m.to),
      cc: canonicalAddresses(m.cc),
      bcc: canonicalAddresses(m.bcc),
    })),
    threadSignals: canonicalThreadSignals(input.threadSignals),
  };
  return sha256Hex(JSON.stringify(canonical));
}

function recipientAddresses(value) {
  const values = typeof value === 'string' ? value.split(/[,;]/) : (value ?? []);
  return values.map((address) => normalizeEmailAddress(address)).filter(Boolean);
}

/** Match worker deriveThreadSignals for the causal production message window. */
function deriveProductionThreadSignals(messages) {
  const legacyHotelsOutboundResponse = messages.some((message) => {
    if (message.direction !== 'outbound') return false;
    const from = normalizeEmailAddress(message.from ?? '');
    const domain = from.slice(from.lastIndexOf('@') + 1);
    return domain === 'legacyhotels.co.za' || domain === 'mail.legacyhotels.com';
  });

  const rcStaff = messages.find((message) => {
    if (message.direction !== 'outbound') return false;
    if (normalizeEmailAddress(message.from ?? '') !== RESERVE_CLOUD_PENNY_EMAIL) {
      return false;
    }
    const recipients = [
      ...recipientAddresses(message.to),
      ...recipientAddresses(message.cc),
      ...recipientAddresses(message.bcc),
    ];
    return recipients.some((recipient) => recipient !== LEGACY_PENNY_EMAIL);
  });

  if (!rcStaff) return { legacyHotelsOutboundResponse };
  return {
    legacyHotelsOutboundResponse,
    reserveCloudStaffOutbound: true,
    reserveCloudStaffOutboundFrom: RESERVE_CLOUD_PENNY_EMAIL,
    reserveCloudStaffOutboundRecipients: [
      ...recipientAddresses(rcStaff.to),
      ...recipientAddresses(rcStaff.cc),
      ...recipientAddresses(rcStaff.bcc),
    ],
  };
}

function compareCausalOrder(a, b) {
  const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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

function approvedTargetDecision(target) {
  const primaryFolder = target.approvedPrimaryFolder ?? target.approvedCategory ?? null;
  const isSpam =
    typeof target.approvedIsSpam === 'boolean'
      ? target.approvedIsSpam
      : String(primaryFolder) === 'spam';
  return {
    primaryFolder: isSpam ? null : primaryFolder,
    isSpam,
    urgent: Boolean(target.approvedUrgent),
  };
}

const AUTO_TRIAGE_NEVER_SPAM_DOMAINS = new Set([
  'legacyhotels.co.za',
  'mail.legacyhotels.com',
]);
const AUTO_TRIAGE_NEVER_SPAM_EMAILS = new Set([
  'aroransh17@gmail.com',
  'coleddofficial@gmail.com',
  RESERVE_CLOUD_PENNY_EMAIL,
]);

function isHotelNeverSpamAddress(fromRaw) {
  const email = normalizeEmailAddress(fromRaw);
  const atIndex = email.lastIndexOf('@');
  return atIndex !== -1 && AUTO_TRIAGE_NEVER_SPAM_DOMAINS.has(email.slice(atIndex + 1));
}

function isPilotNeverSpamAddress(fromRaw) {
  const email = normalizeEmailAddress(fromRaw);
  return (
    AUTO_TRIAGE_NEVER_SPAM_EMAILS.has(email) &&
    !isHotelNeverSpamAddress(fromRaw) &&
    email !== RESERVE_CLOUD_PENNY_EMAIL
  );
}

function workflowApplyExceptionFolder(requested, fromRaw, staff) {
  if (isPilotNeverSpamAddress(fromRaw)) return 'bookings';
  const from = normalizeEmailAddress(fromRaw);
  if (from === RESERVE_CLOUD_PENNY_EMAIL && requested === 'groups-events') {
    return requested;
  }
  if (isHotelNeverSpamAddress(fromRaw) || from === RESERVE_CLOUD_PENNY_EMAIL) {
    return 'internal-partner';
  }
  if (staff && (requested === 'unknown-review' || requested === 'automated-channel')) {
    return 'internal-partner';
  }
  return requested;
}

function hasStaffConversationSignal(metrics) {
  const signals = metrics?.threadSignals;
  if (!signals || typeof signals !== 'object') return false;
  if (signals.legacyHotelsOutboundResponse === true) return true;
  if (signals.reserveCloudStaffOutbound !== true) return false;
  if (normalizeEmailAddress(signals.reserveCloudStaffOutboundFrom ?? '') !== RESERVE_CLOUD_PENNY_EMAIL) {
    return false;
  }
  const recipients = recipientAddresses(signals.reserveCloudStaffOutboundRecipients);
  return recipients.some((recipient) => recipient !== LEGACY_PENNY_EMAIL);
}

/** Apply the same workflow exception remap used by applyDurableTriageResult. */
export function effectiveDurableDecision(target, metrics, snapshotRow, canonicalV6) {
  const approved = approvedTargetDecision(target);
  if (!canonicalV6 || approved.isSpam || !approved.primaryFolder) return approved;
  return {
    ...approved,
    primaryFolder: workflowApplyExceptionFolder(
      approved.primaryFolder,
      snapshotRow?.latestSender ?? '',
      hasStaffConversationSignal(metrics),
    ),
  };
}

function runOutputDecision(metrics) {
  const canonical =
    metrics?.canonicalOutput && typeof metrics.canonicalOutput === 'object'
      ? metrics.canonicalOutput
      : null;
  const primaryFolder = canonical?.primaryFolder ?? metrics?.primaryFolder ?? metrics?.category ?? null;
  const isSpam =
    typeof canonical?.isSpam === 'boolean'
      ? canonical.isSpam
      : typeof metrics?.isSpam === 'boolean'
        ? metrics.isSpam
        : String(metrics?.category) === 'spam';
  return {
    primaryFolder: isSpam ? null : primaryFolder,
    isSpam,
    urgent: Boolean(canonical?.urgent ?? metrics?.urgent),
    rawPrimaryFolder: primaryFolder,
  };
}

function expectedDurableSlugs(decision) {
  // spam is persisted via mail_thread.spam_at, not an AI-managed category join.
  if (decision.isSpam) {
    return [];
  }
  if (!decision.primaryFolder) return decision.urgent ? ['urgent'] : [];
  const slugs = [String(decision.primaryFolder)];
  if (decision.urgent) slugs.push('urgent');
  return [...new Set(slugs)].sort();
}

function isCanonicalWorkflowPrimary(slug) {
  return WORKFLOW_PRIMARY_SLUGS.includes(String(slug));
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
    manifest = validateBoundApprovedRolloutManifest(opts.manifest);
  } catch (err) {
    push(err instanceof Error ? err.message : String(err));
    return { ok: false, errors };
  }

  const keyPrefix = opts.keyPrefix;
  const applySummary = opts.applySummary ?? {};
  if (applySummary.keyPrefix !== keyPrefix) {
    push(`apply summary keyPrefix mismatch: ${applySummary.keyPrefix} !== ${keyPrefix}`);
  }
  if (applySummary.manifestHash !== manifest.manifestHash) {
    push('apply summary manifestHash mismatch');
  }
  if (manifest.snapshotHash !== snapshot.snapshotHash) {
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
    if (target.approvedCategory == null && target.approvedPrimaryFolder == null) {
      push(`approved category/urgent required for ${target.threadId}`);
    }
    if (typeof target.approvedUrgent !== 'boolean') {
      push(`approved urgent must be boolean for ${target.threadId}`);
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
    // ai_workflow_run.prompt_hash is the static rollout artifact binding set
    // by retag enqueue. The metrics promptHash is input-specific (it includes
    // the causal user prompt/asOf), so it must not be compared to manifest
    // promptHash or used as the rollout binding.
    if (!isSha256Hex(run.promptHash) || run.promptHash !== manifest.promptHash) {
      push(`prompt hash artifact binding mismatch with manifest for ${target.threadId}`);
    }

    const metrics = run.metrics ?? {};
    if (metrics.applyMode !== 'full') {
      push(`wrong applyMode for ${target.threadId}: ${metrics.applyMode}`);
    }
    if (metrics.draftRunId != null && metrics.draftRunId !== '') {
      push(`unexpected draft for ${target.threadId}: ${metrics.draftRunId}`);
    }
    const snap = snapByThread.get(target.threadId);
    const approved = approvedTargetDecision(target);
    const actual = runOutputDecision(metrics);
    if (
      actual.isSpam !== approved.isSpam ||
      (!actual.isSpam && actual.primaryFolder !== approved.primaryFolder) ||
      actual.urgent !== approved.urgent
    ) {
      push(
        `approved-output mismatch for ${target.threadId}: got ${
          actual.isSpam ? 'spam' : actual.primaryFolder
        }/${actual.urgent} approved ${
          approved.isSpam ? 'spam' : approved.primaryFolder
        }/${approved.urgent}`,
      );
    }
    const canonicalV6 =
      (metrics?.canonicalOutput && typeof metrics.canonicalOutput === 'object') ||
      metrics?.primaryFolder != null ||
      metrics?.isSpam != null ||
      target.approvedPrimaryFolder != null ||
      target.approvedIsSpam != null;
    if (
      canonicalV6 &&
      !actual.isSpam &&
      actual.rawPrimaryFolder != null &&
      !isCanonicalWorkflowPrimary(actual.rawPrimaryFolder)
    ) {
      push(`invalid workflow primary for ${target.threadId}: ${actual.rawPrimaryFolder}`);
    }
    if (canonicalV6 && !approved.isSpam && !isCanonicalWorkflowPrimary(approved.primaryFolder)) {
      push(`invalid approved workflow primary for ${target.threadId}: ${approved.primaryFolder}`);
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
    const durableDecision = effectiveDurableDecision(target, metrics, snap, canonicalV6);
    const expectedSlugs = expectedDurableSlugs(durableDecision);
    const actualSlugs = [...(durable.aiCategorySlugs ?? [])].map(String).sort();
    if (JSON.stringify(actualSlugs) !== JSON.stringify(expectedSlugs)) {
      push(
        `durable category mismatch for ${target.threadId}: expected ${expectedSlugs.join(',')} got ${actualSlugs.join(',')}`,
      );
    }
    if (durableDecision.isSpam) {
      if (durable.spamAt == null) {
        push(`durable spam mismatch for ${target.threadId}: expected spam_at set`);
      }
      if (actualSlugs.some((slug) => slug !== 'urgent')) {
        push(`durable primary mismatch for spam target ${target.threadId}: ${actualSlugs.join(',')}`);
      }
    } else if (durable.spamAt != null) {
      push(`durable spam mismatch for ${target.threadId}: expected cleared spam_at`);
    } else if (canonicalV6 && !actualSlugs.some((slug) => isCanonicalWorkflowPrimary(slug))) {
      push(`durable workflow primary missing for ${target.threadId}`);
    }
    const expectedUrgent = !durableDecision.isSpam && durableDecision.urgent;
    if (Boolean(durable.aiCategorySlugs?.includes('urgent')) !== expectedUrgent) {
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
    // Snapshot intentionally excludes spam joins; audit driver includes them
    // so target spam-primary mutations remain visible. Compare retag-managed
    // joins only for excluded threads to avoid false mutation failures from a
    // pre-existing spam join.
    const liveSlugs = [...(live.aiCategorySlugs ?? [])]
      .map(String)
      .filter((slug) => slug !== 'spam')
      .sort();
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
          sent_at AS "sentAt",
          to_addresses AS "to",
          cc_addresses AS "cc",
          bcc_addresses AS "bcc"
        FROM message
        WHERE thread_id = ${input.threadId}
        ORDER BY created_at ASC, id ASC
      `;
      const rows = messages.map((m) => ({
        id: m.id,
        from: m.from ?? '',
        subject: m.subject,
        body: m.body,
        direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
        createdAt: m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt),
        receivedAt: m.receivedAt ? (m.receivedAt instanceof Date ? m.receivedAt : new Date(m.receivedAt)) : null,
        sentAt: m.sentAt ? (m.sentAt instanceof Date ? m.sentAt : new Date(m.sentAt)) : null,
        to: m.to ?? [],
        cc: m.cc ?? [],
        bcc: m.bcc ?? [],
      }));
      rows.sort(compareCausalOrder);
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
        threadSignals: deriveProductionThreadSignals(causal),
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
          AND c.slug = ANY(${[...RETAG_UNSETTLE_SLUGS, 'spam']})
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
