import { describe, expect, it } from 'vitest';
import {
  MAIL_ARTIFACT_BACKTEST_PHASE,
  aggregateMailArtifactBacktest,
  mailArtifactBacktestReportSchema,
} from '../src/ops/mail-artifact-backtest.js';

describe('mail artifact aggregate backtest', () => {
  it('emits aggregate private metrics only', () => {
    expect(MAIL_ARTIFACT_BACKTEST_PHASE).toBe('private_aggregate_v1');
    const report = aggregateMailArtifactBacktest({
      eligible: 4,
      samples: [
        { reason: 'readable', latencyMs: 10 },
        { reason: 'encrypted', latencyMs: 20 },
        { reason: 'parser_failure', latencyMs: 30 },
      ],
      truncatedByDeadline: true,
    });
    expect(report).toMatchObject({
      eligible: 4,
      attempted: 3,
      readable: 1,
      manualRequired: 2,
      unprocessed: 1,
      truncatedByDeadline: true,
      latencyMs: { p50: 20, p95: 30 },
    });
    const keys = [
      ...Object.keys(report),
      ...Object.keys(report.byReason),
      ...Object.keys(report.latencyMs),
    ];
    expect(keys.join('|')).not.toMatch(
      /message|thread|attachmentId|filename|s3Key|email|address/i,
    );
  });

  it('rejects private or free-form fields', () => {
    expect(() =>
      mailArtifactBacktestReportSchema.parse({
        ...aggregateMailArtifactBacktest({
          eligible: 0,
          samples: [],
          truncatedByDeadline: false,
        }),
        messageId: 'private',
      }),
    ).toThrow();
  });
});
