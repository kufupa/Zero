/**
 * Registered hms_find_reservation live probe.
 * Read-only; prints only status/counts/error codes and candidate digest.
 */
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  extractLookupCandidates,
  filterExactReservationCandidates,
  normalizeMessageText,
} from '../dist/ai/thread-context.js';
import { createCandidateTools } from '../dist/ai/candidate-draft-agent.js';
import { createDb } from '../dist/db/client.js';
import { message } from '../dist/db/schema/mail.js';
import { TRANSPORT_ID as CENTURION } from '../dist/db/seed.js';
import { requireHmsWorkerRuntimeConfig } from '../dist/env.js';
import { createLiveGuestStayDriver } from '../dist/hms/live-guest-stay-driver.js';
import { createProductionHmsRuntime } from '../dist/hms/production-runtime.js';
import { createReservationCandidateSession } from '../dist/hms/reservation-candidate-session.js';

const HMS_DEPENDENCY_REVISION =
  'playwright-1.52.0-chromium-1169-ffmpeg-1011';

function sha12(v) {
  return createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
}

const { db, conn } = createDb(process.env.DATABASE_URL);
let candidate = null;
try {
  const rows = await db
    .select({
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      subject: message.subject,
    })
    .from(message)
    .where(eq(message.transportId, CENTURION))
    .limit(5000);
  for (const row of rows) {
    const text = [
      row.subject ?? '',
      normalizeMessageText({
        textBody: row.textBody,
        htmlBody: row.htmlBody,
      }),
    ].join('\n');
    const exact = filterExactReservationCandidates(
      extractLookupCandidates(text),
    );
    if (exact.length !== 1) continue;
    if (!/^\d{6,14}-\d{1,4}$/.test(exact[0].value)) continue;
    candidate = exact[0];
    break;
  }
} finally {
  await conn.end().catch(() => undefined);
}

if (!candidate) {
  console.log(JSON.stringify({ ok: false, reason: 'NO_NDEG_CANDIDATE' }));
  process.exit(0);
}

const cfg = requireHmsWorkerRuntimeConfig({
  ...process.env,
  HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
});
const executionClass =
  process.env.PROBE_EXECUTION_CLASS === 'live_proof' ? 'live_proof' : 'normal';
const runtime = await createProductionHmsRuntime(cfg, {
  sourceRevision: process.env.NAVA_PROOF_SOURCE_REVISION || 'registered-probe',
});
const out = {
  ok: false,
  candidateLen: candidate.value.length,
  candidateSha12: sha12(candidate.value.toUpperCase()),
};

try {
  await runtime.start(AbortSignal.timeout(60_000));
  const operationId = randomUUID();
  const driver = createLiveGuestStayDriver({
    runtime,
    transportId: cfg.expectedTransportId,
    auditSpecFor: ({ inputClass }) => ({
      operationId,
      toolId: 'hms_find_reservation',
      toolVersion: '1.1.0',
      dependencyRevision: HMS_DEPENDENCY_REVISION,
      executionClass,
      inputClass,
    }),
  });
  const session = createReservationCandidateSession({
    driver,
    candidates: new Map([[candidate.id, candidate]]),
    close: async () => undefined,
    runId: operationId,
  });
  const tools = createCandidateTools(session);
  const find = tools.tools.hms_find_reservation;
  if (!find?.execute) throw new Error('REGISTERED_TOOL_MISSING');
  const result = await find.execute(
    { candidateId: candidate.id },
    { abortSignal: AbortSignal.timeout(cfg.runDeadlineMs) },
  );
  const receipt = driver.lastAuditReceipt();
  out.ok = true;
  out.status = result.status;
  out.matchCount = Number(result.data?.matchCount ?? 0);
  out.unresolvedCount = result.unresolvedFields?.length ?? 0;
  out.receipt = receipt
    ? {
        complete: receipt.artifactState === 'complete',
        executionClass: receipt.executionClass,
        hasTrace: Boolean(receipt.trace),
        hasVideo: Boolean(receipt.video),
        blocked: receipt.blockedRequests,
        mutation: receipt.mutationRequests,
      }
    : null;
} catch (err) {
  out.errorName = err?.name || 'Error';
  out.errorCode = err?.code || null;
  const errorText = String(err?.message || err);
  out.errorSafe = errorText
    .replaceAll(candidate.value, '<candidate>')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, '<path>')
    .slice(0, 160);
  out.errorCategory = /Execution context was destroyed|navigation/i.test(errorText)
    ? 'navigation_race'
    : /timeout/i.test(errorText)
      ? 'timeout'
      : /Target page, context or browser has been closed/i.test(errorText)
        ? 'target_closed'
        : /policy|blocked|unknown_path/i.test(errorText)
          ? 'policy'
          : 'other';
  out.errorCount =
    err instanceof AggregateError ? Array.from(err.errors ?? []).length : 1;
  if (err instanceof AggregateError) {
    out.inner = Array.from(err.errors ?? []).map((e) => ({
      name: e?.name || 'Error',
      code: e?.code || null,
    }));
  }
} finally {
  await runtime.close().catch(() => undefined);
}

console.log(JSON.stringify(out));
