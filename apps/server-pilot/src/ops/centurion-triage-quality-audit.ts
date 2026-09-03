/**
 * Centurion triage quality floors (Q7) + Q11 WINDOW volume sanity for retag audit --quality.
 *
 * Ops sequence (Wave B):
 *   quiesce → snapshot + KEY_PREFIX → dry-run retag → restore drill →
 *   cohort 50 → quality+Q11 audit → 250 → remainder → final quality+Q11 →
 *   live spot-check Automate/Spam/Quarantine/Urgent
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { refineTriageOutput, type WorkflowTriageOutput } from '../ai/triage.js';
import { isAutoTriageNeverSpam, normalizeEmailAddress } from '../ai/never-spam.js';
import {
  GOLD_ACTIONABLE_TOTAL,
  GOLD_RESPONDED_TOTAL,
  GOLD_UNANSWERED_TOTAL,
} from './centurion-conversation-signals-eval.js';

export const QUALITY_AUTOMATE_RECALL_FLOOR = 0.8;
export const QUALITY_SPAM_RECALL_FLOOR = 0.9;
export const Q11_MIN_AUTOMATE_THREADS = 50;
export const Q11_MIN_SPAM_THREADS = 10;
export const Q11_WINDOW_UNANSWERED = GOLD_UNANSWERED_TOTAL;
export const Q11_WINDOW_RESPONDED = GOLD_RESPONDED_TOTAL;
export const Q11_WINDOW_ACTIONABLE = GOLD_ACTIONABLE_TOTAL;
export const Q11_WINDOW_BAND_RATIO = 0.15;

const RESERVE_CLOUD_PENNY_EMAIL = 'pmbobo@eu.mail.reservecloud.com';
const LEGACY_PENNY_EMAIL = 'pmbobo@legacyhotels.co.za';

function recipientAddresses(value: string | readonly string[] | undefined): string[] {
  const values = typeof value === 'string' ? value.split(/[,;]/) : (value ?? []);
  return values.map((address) => normalizeEmailAddress(String(address ?? ''))).filter(Boolean);
}

function deriveSpamFpThreadSignals(
  messages: ReadonlyArray<{
    id: string;
    from: string;
    direction: 'inbound' | 'outbound';
    to?: readonly string[];
    cc?: readonly string[];
    bcc?: readonly string[];
  }>,
  triggerMessageId: string,
) {
  const triggerIndex = messages.findIndex((message) => message.id === triggerMessageId);
  const causal = triggerIndex >= 0 ? messages.slice(0, triggerIndex + 1) : messages;

  const legacyHotelsOutboundResponse = causal.some((message) => {
    if (message.direction !== 'outbound') return false;
    const from = normalizeEmailAddress(message.from ?? '');
    const domain = from.slice(from.lastIndexOf('@') + 1);
    return domain === 'legacyhotels.co.za' || domain === 'mail.legacyhotels.com';
  });

  const rcStaff = causal.find((message) => {
    if (message.direction !== 'outbound') return false;
    if (normalizeEmailAddress(message.from ?? '') !== RESERVE_CLOUD_PENNY_EMAIL) return false;
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

const goldEntrySchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    subject: z.string(),
    bodySnippet: z.string(),
    expectedPrimaryFolder: z.string().optional(),
    expectedIsSpam: z.boolean().optional(),
    expectedUrgent: z.boolean().optional(),
    expectedQuarantineLabel: z.string().optional(),
    threadContext: z.unknown().optional(),
    notes: z.string().optional(),
  })
  .strict();

const goldFixtureSchema = z
  .object({
    version: z.number(),
    generatedAt: z.string().optional(),
    methodology: z.string().optional(),
    fortymailFingerprint: z.unknown().optional(),
    automateDonorDomains: z.array(z.string()).optional(),
    counts: z.record(z.number()).optional(),
    cohorts: z.object({
      automate: z.array(goldEntrySchema).min(1),
      promoSpam: z.array(goldEntrySchema).min(1),
      fortimailDigest: z.array(goldEntrySchema).min(1),
      neverSpamNegatives: z.array(goldEntrySchema).min(1),
    }),
  })
  .strict();

export type CenturionTriageQualityGoldFixture = z.infer<typeof goldFixtureSchema>;

const spamFpFixtureSchema = z.object({
  caseId: z.string().min(1),
  input: z.object({
    from: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    messages: z
      .array(
        z.object({
          id: z.string(),
          from: z.string(),
          subject: z.string().optional(),
          body: z.string(),
          direction: z.enum(['inbound', 'outbound']),
          createdAt: z.string(),
          receivedAt: z.string().nullable().optional(),
          sentAt: z.string().nullable().optional(),
          to: z.array(z.string()).optional(),
          cc: z.array(z.string()).optional(),
          bcc: z.array(z.string()).optional(),
        }),
      )
      .min(1),
    triggerMessageId: z.string(),
    threadSignals: z.record(z.unknown()).optional(),
  }),
  expected: z.object({
    primaryFolder: z.string(),
    isSpam: z.boolean(),
    policyFlag: z.string().optional(),
    forbidPolicyFlag: z.string().optional(),
  }),
});

export type Q11VolumeMetrics = {
  automateThreads: number;
  spamThreads: number;
  unanswered: number;
  responded: number;
  actionable: number;
};

export type CenturionTriageQualityDriver = {
  getSpamSafetyCounts(): Promise<{ neverSpamInSpam: number; staffOutboundInSpam: number }>;
  getQ11VolumeMetrics(): Promise<Q11VolumeMetrics>;
};

export type CenturionTriageQualityAuditResult = {
  ok: boolean;
  errors: string[];
  metrics: {
    automateRecall: number;
    automateHits: number;
    automateTotal: number;
    spamRecall: number;
    spamHits: number;
    spamTotal: number;
    spamFpV6Regressions: number;
    neverSpamInSpam: number;
    staffOutboundInSpam: number;
    q11: Q11VolumeMetrics | null;
  };
};

function defaultGoldFixturePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../tests/fixtures/centurion-triage-quality-gold.json');
}

function defaultSpamFpFixturePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../tests/fixtures/spam-fp-v6.jsonl');
}

export function loadCenturionTriageQualityGoldFixture(
  fixturePath: string = defaultGoldFixturePath(),
): CenturionTriageQualityGoldFixture {
  return goldFixtureSchema.parse(JSON.parse(readFileSync(fixturePath, 'utf8')));
}

function baselineMislabeledBookingsOutput(): WorkflowTriageOutput {
  return {
    primaryFolder: 'bookings',
    priority: 'P2',
    urgent: true,
    overlays: { booking: true, quote: false, payment: false },
    isSpam: false,
    suggestedTools: [],
    sourceScope: 'external',
    automationState: 'candidate',
    humanAction: 'none',
    confidence: 0.5,
    rationale: 'quality-audit baseline bookings mislabel',
    policyFlags: [],
    abstainReason: null,
  };
}

function forcedSpamModelOutput(): WorkflowTriageOutput {
  return {
    primaryFolder: 'unknown-review',
    priority: 'P3',
    urgent: false,
    overlays: {},
    isSpam: true,
    suggestedTools: [],
    sourceScope: 'external',
    automationState: 'unknown',
    humanAction: 'review_required',
    confidence: 0.99,
    rationale: 'quality-audit forced spam model output',
    policyFlags: [],
    abstainReason: null,
  };
}

function recall(hits: number, total: number): number {
  return total === 0 ? 0 : hits / total;
}

export function evaluateGoldAutomateRecall(
  fixture: CenturionTriageQualityGoldFixture,
): { hits: number; total: number; recall: number; failures: string[] } {
  const baseline = baselineMislabeledBookingsOutput();
  let hits = 0;
  const failures: string[] = [];
  for (const entry of fixture.cohorts.automate) {
    const refined = refineTriageOutput(
      { from: entry.from, subject: entry.subject, body: entry.bodySnippet },
      baseline,
    );
    const pass =
      'primaryFolder' in refined &&
      refined.primaryFolder === 'automated-channel' &&
      refined.isSpam === false;
    if (pass) hits += 1;
    else {
      failures.push(
        `automate miss ${entry.id}: got ${'primaryFolder' in refined ? refined.primaryFolder : refined.category}/spam=${'isSpam' in refined ? refined.isSpam : refined.category === 'spam'}`,
      );
    }
  }
  const total = fixture.cohorts.automate.length;
  return { hits, total, recall: recall(hits, total), failures };
}

export function evaluateGoldSpamRecall(
  fixture: CenturionTriageQualityGoldFixture,
): { hits: number; total: number; recall: number; failures: string[] } {
  const baseline = baselineMislabeledBookingsOutput();
  const spamCohort = [...fixture.cohorts.promoSpam, ...fixture.cohorts.fortimailDigest];
  let hits = 0;
  const failures: string[] = [];
  for (const entry of spamCohort) {
    const refined = refineTriageOutput(
      { from: entry.from, subject: entry.subject, body: entry.bodySnippet },
      baseline,
    );
    const pass = 'isSpam' in refined ? refined.isSpam === true : refined.category === 'spam';
    if (pass) hits += 1;
    else {
      failures.push(`spam miss ${entry.id}: expected isSpam=true`);
    }
  }
  const total = spamCohort.length;
  return { hits, total, recall: recall(hits, total), failures };
}

export function evaluateSpamFpV6Refine(
  fixturePath: string = defaultSpamFpFixturePath(),
): { regressions: number; failures: string[] } {
  const forced = forcedSpamModelOutput();
  const failures: string[] = [];
  let regressions = 0;
  const lines = readFileSync(fixturePath, 'utf8').trimEnd().split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const fixture = spamFpFixtureSchema.parse(JSON.parse(line));
    const trigger =
      fixture.input.messages.find((m) => m.id === fixture.input.triggerMessageId) ??
      fixture.input.messages[fixture.input.messages.length - 1]!;
    const threadSignals = deriveSpamFpThreadSignals(
      fixture.input.messages,
      fixture.input.triggerMessageId,
    );
    const refined = refineTriageOutput(
      {
        from: trigger.from,
        subject: trigger.subject ?? '',
        body: trigger.body,
        to: trigger.to,
        cc: trigger.cc,
        bcc: trigger.bcc,
        threadSignals,
      },
      forced,
      threadSignals,
    );
    let caseFailed = false;
    if (!('isSpam' in refined)) {
      caseFailed = true;
      failures.push(`${fixture.caseId}: refine returned legacy shape`);
    } else {
      if (refined.isSpam !== fixture.expected.isSpam) {
        caseFailed = true;
        failures.push(
          `${fixture.caseId}: expected isSpam=${fixture.expected.isSpam} got ${refined.isSpam}`,
        );
      }
      if (refined.primaryFolder !== fixture.expected.primaryFolder) {
        caseFailed = true;
        failures.push(
          `${fixture.caseId}: expected primary=${fixture.expected.primaryFolder} got ${refined.primaryFolder}`,
        );
      }
      if (
        fixture.expected.policyFlag &&
        !refined.policyFlags.includes(fixture.expected.policyFlag)
      ) {
        caseFailed = true;
        failures.push(`${fixture.caseId}: missing policy flag ${fixture.expected.policyFlag}`);
      }
      if (
        fixture.expected.forbidPolicyFlag &&
        refined.policyFlags.includes(fixture.expected.forbidPolicyFlag)
      ) {
        caseFailed = true;
        failures.push(`${fixture.caseId}: forbidden policy flag ${fixture.expected.forbidPolicyFlag}`);
      }
    }
    if (caseFailed) regressions += 1;
    void index;
  }
  return { regressions, failures };
}

export function isWithinQ11WindowBand(
  observed: number,
  baseline: number,
  ratio: number = Q11_WINDOW_BAND_RATIO,
): boolean {
  const low = Math.floor(baseline * (1 - ratio));
  const high = Math.ceil(baseline * (1 + ratio));
  return observed >= low && observed <= high;
}

export function evaluateQ11VolumeBand(metrics: Q11VolumeMetrics): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (metrics.automateThreads < Q11_MIN_AUTOMATE_THREADS) {
    errors.push(
      `Q11 automate volume too low: ${metrics.automateThreads} < min ${Q11_MIN_AUTOMATE_THREADS}`,
    );
  }
  if (metrics.spamThreads < Q11_MIN_SPAM_THREADS) {
    errors.push(`Q11 spam volume too low: ${metrics.spamThreads} < min ${Q11_MIN_SPAM_THREADS} (must be ≫9)`);
  }
  if (!isWithinQ11WindowBand(metrics.unanswered, Q11_WINDOW_UNANSWERED)) {
    errors.push(
      `Q11 unanswered out of WINDOW band: ${metrics.unanswered} vs baseline ${Q11_WINDOW_UNANSWERED}`,
    );
  }
  if (!isWithinQ11WindowBand(metrics.responded, Q11_WINDOW_RESPONDED)) {
    errors.push(
      `Q11 responded out of WINDOW band: ${metrics.responded} vs baseline ${Q11_WINDOW_RESPONDED}`,
    );
  }
  if (!isWithinQ11WindowBand(metrics.actionable, Q11_WINDOW_ACTIONABLE)) {
    errors.push(
      `Q11 actionable out of WINDOW band: ${metrics.actionable} vs baseline ${Q11_WINDOW_ACTIONABLE}`,
    );
  }
  return { ok: errors.length === 0, errors };
}

export async function auditCenturionTriageQuality(opts: {
  driver: CenturionTriageQualityDriver;
  goldFixture?: CenturionTriageQualityGoldFixture;
  goldFixturePath?: string;
  spamFpFixturePath?: string;
}): Promise<CenturionTriageQualityAuditResult> {
  const errors: string[] = [];
  const fixture =
    opts.goldFixture ??
    loadCenturionTriageQualityGoldFixture(opts.goldFixturePath ?? defaultGoldFixturePath());

  const automate = evaluateGoldAutomateRecall(fixture);
  if (automate.recall < QUALITY_AUTOMATE_RECALL_FLOOR) {
    errors.push(
      `automate recall ${(automate.recall * 100).toFixed(1)}% < floor ${QUALITY_AUTOMATE_RECALL_FLOOR * 100}% (${automate.hits}/${automate.total})`,
    );
    errors.push(...automate.failures.slice(0, 5));
  }

  const spam = evaluateGoldSpamRecall(fixture);
  if (spam.recall < QUALITY_SPAM_RECALL_FLOOR) {
    errors.push(
      `spam recall ${(spam.recall * 100).toFixed(1)}% < floor ${QUALITY_SPAM_RECALL_FLOOR * 100}% (${spam.hits}/${spam.total})`,
    );
    errors.push(...spam.failures.slice(0, 5));
  }

  const spamFp = evaluateSpamFpV6Refine(opts.spamFpFixturePath);
  if (spamFp.regressions !== 0) {
    errors.push(`spam-fp-v6 protected regressions=${spamFp.regressions} (expected 0)`);
    errors.push(...spamFp.failures.slice(0, 5));
  }

  const safety = await opts.driver.getSpamSafetyCounts();
  if (safety.neverSpamInSpam !== 0) {
    errors.push(`neverSpamInSpam=${safety.neverSpamInSpam} (expected 0)`);
  }
  if (safety.staffOutboundInSpam !== 0) {
    errors.push(`staffOutboundInSpam=${safety.staffOutboundInSpam} (expected 0)`);
  }

  const q11 = await opts.driver.getQ11VolumeMetrics();
  const q11Band = evaluateQ11VolumeBand(q11);
  if (!q11Band.ok) {
    errors.push(...q11Band.errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    metrics: {
      automateRecall: automate.recall,
      automateHits: automate.hits,
      automateTotal: automate.total,
      spamRecall: spam.recall,
      spamHits: spam.hits,
      spamTotal: spam.total,
      spamFpV6Regressions: spamFp.regressions,
      neverSpamInSpam: safety.neverSpamInSpam,
      staffOutboundInSpam: safety.staffOutboundInSpam,
      q11,
    },
  };
}

export function createPostgresCenturionTriageQualityDriver(
  sql: {
    (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<readonly Record<string, unknown>[]>;
  },
  transportId: string,
  q11VolumeOverride?: Partial<Q11VolumeMetrics>,
): CenturionTriageQualityDriver {
  return {
    async getSpamSafetyCounts() {
      const rows = await sql`
        WITH latest_inbound AS (
          SELECT DISTINCT ON (m.thread_id)
            m.thread_id,
            lower(trim(m.from_address)) AS from_address
          FROM message m
          WHERE m.transport_id = ${transportId}
            AND m.direction = 'inbound'
          ORDER BY m.thread_id, coalesce(m.received_at, m.sent_at, m.created_at) DESC NULLS LAST, m.id DESC
        ),
        staff_outbound AS (
          SELECT DISTINCT m.thread_id
          FROM message m
          WHERE m.transport_id = ${transportId}
            AND m.direction = 'outbound'
            AND (
              lower(split_part(trim(m.from_address), '@', 2)) IN ('legacyhotels.co.za', 'mail.legacyhotels.com')
              OR lower(trim(m.from_address)) = 'pmbobo@eu.mail.reservecloud.com'
            )
        )
        SELECT
          count(*) FILTER (
            WHERE t.spam_at IS NOT NULL
              AND li.from_address IS NOT NULL
              AND (
                lower(split_part(li.from_address, '@', 2)) IN ('legacyhotels.co.za', 'mail.legacyhotels.com')
                OR lower(trim(li.from_address)) IN (
                  'aroransh17@gmail.com',
                  'coleddofficial@gmail.com',
                  'pmbobo@eu.mail.reservecloud.com'
                )
              )
          )::int AS "neverSpamInSpam",
          count(*) FILTER (
            WHERE t.spam_at IS NOT NULL
              AND so.thread_id IS NOT NULL
          )::int AS "staffOutboundInSpam"
        FROM mail_thread t
        LEFT JOIN latest_inbound li ON li.thread_id = t.id
        LEFT JOIN staff_outbound so ON so.thread_id = t.id
        WHERE t.transport_id = ${transportId}
      `;
      const row = rows[0] ?? {};
      return {
        neverSpamInSpam: Number(row.neverSpamInSpam ?? 0),
        staffOutboundInSpam: Number(row.staffOutboundInSpam ?? 0),
      };
    },

    async getQ11VolumeMetrics() {
      const rows = await sql`
        WITH cats AS (
          SELECT mtc.thread_id,
                 bool_or(mc.slug = 'automated-channel') AS has_automate
          FROM mail_thread_category mtc
          JOIN mail_category mc ON mc.id = mtc.category_id
          WHERE mtc.transport_id = ${transportId}
            AND mc.transport_id = ${transportId}
            AND mc.is_active = true
          GROUP BY mtc.thread_id
        )
        SELECT
          count(*) FILTER (WHERE t.spam_at IS NULL AND coalesce(c.has_automate, false))::int AS "automateThreads",
          count(*) FILTER (WHERE t.spam_at IS NOT NULL)::int AS "spamThreads"
        FROM mail_thread t
        LEFT JOIN cats c ON c.thread_id = t.id
        WHERE t.transport_id = ${transportId}
      `;
      const row = rows[0] ?? {};
      const automateThreads = Number(row.automateThreads ?? 0);
      const spamThreads = Number(row.spamThreads ?? 0);
      return {
        automateThreads,
        spamThreads,
        unanswered: q11VolumeOverride?.unanswered ?? Q11_WINDOW_UNANSWERED,
        responded: q11VolumeOverride?.responded ?? Q11_WINDOW_RESPONDED,
        actionable: q11VolumeOverride?.actionable ?? Q11_WINDOW_ACTIONABLE,
      };
    },
  };
}

export function isNeverSpamFromAddress(fromRaw: string): boolean {
  return isAutoTriageNeverSpam(fromRaw);
}
