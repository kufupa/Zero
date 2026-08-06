/** Private, aggregate-only artifact backtest contract. Never accepts raw values. */
import { z } from 'zod';

export const MAIL_ARTIFACT_BACKTEST_PHASE = 'private_aggregate_v1' as const;
export const MAIL_ARTIFACT_BACKTEST_CUTOFF =
  '2026-08-03T23:59:59.999Z' as const;
export const MAIL_ARTIFACT_BACKTEST_CAP = 1_000;

const reasonSchema = z.enum([
  'readable',
  'no_embedded_text',
  'encrypted',
  'malformed',
  'too_large',
  'too_many_pages',
  'timeout',
  'parser_failure',
  'unsupported',
]);

export const mailArtifactBacktestReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    cutoff: z.literal(MAIL_ARTIFACT_BACKTEST_CUTOFF),
    eligible: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
    readable: z.number().int().nonnegative(),
    manualRequired: z.number().int().nonnegative(),
    unprocessed: z.number().int().nonnegative(),
    truncatedByCap: z.boolean(),
    truncatedByDeadline: z.boolean(),
    byReason: z.record(reasonSchema, z.number().int().nonnegative()),
    latencyMs: z.object({
      p50: z.number().int().nonnegative().nullable(),
      p95: z.number().int().nonnegative().nullable(),
    }).strict(),
  })
  .strict();

export type MailArtifactBacktestSample = {
  reason: z.infer<typeof reasonSchema>;
  latencyMs: number;
};

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

export function aggregateMailArtifactBacktest(input: {
  eligible: number;
  samples: readonly MailArtifactBacktestSample[];
  truncatedByDeadline: boolean;
}): z.infer<typeof mailArtifactBacktestReportSchema> {
  const attempted = input.samples.length;
  if (
    !Number.isInteger(input.eligible) ||
    input.eligible < attempted ||
    input.eligible < 0 ||
    attempted > MAIL_ARTIFACT_BACKTEST_CAP
  ) {
    throw new Error('MAIL_ARTIFACT_BACKTEST_INVALID_DENOMINATOR');
  }
  const byReason = Object.fromEntries(
    reasonSchema.options.map((reason) => [reason, 0]),
  ) as Record<z.infer<typeof reasonSchema>, number>;
  const latencies: number[] = [];
  for (const sample of input.samples) {
    const parsed = reasonSchema.parse(sample.reason);
    if (!Number.isInteger(sample.latencyMs) || sample.latencyMs < 0) {
      throw new Error('MAIL_ARTIFACT_BACKTEST_INVALID_LATENCY');
    }
    byReason[parsed] += 1;
    latencies.push(sample.latencyMs);
  }
  const readable = byReason.readable;
  return mailArtifactBacktestReportSchema.parse({
    schemaVersion: 1,
    cutoff: MAIL_ARTIFACT_BACKTEST_CUTOFF,
    eligible: input.eligible,
    attempted,
    readable,
    manualRequired: attempted - readable,
    unprocessed: input.eligible - attempted,
    truncatedByCap:
      input.eligible > MAIL_ARTIFACT_BACKTEST_CAP &&
      attempted === MAIL_ARTIFACT_BACKTEST_CAP,
    truncatedByDeadline: input.truncatedByDeadline,
    byReason,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
  });
}
