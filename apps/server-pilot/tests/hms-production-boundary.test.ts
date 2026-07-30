import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_MUTATION_ENABLE_KEYS,
  SECURITY_MARKERS,
  assertHmsDbTestPrerequisite,
  assertSecurityMarkersAbsentOrRedacted,
  auditProductionBoundary,
  collectForbiddenImports,
  runHmsDraftPipelineJourneys,
} from '../src/hms/production-boundary.js';
import { candidateToolEffects } from '../src/ai/candidate-draft-agent.js';
import { loadPm2Config } from '../src/deploy/load-pm2-config.js';

describe('HMS production boundary', () => {
  it('every registered tool effect is read', () => {
    const report = auditProductionBoundary();
    expect(report.allToolEffectsRead).toBe(true);
    for (const effect of Object.values(candidateToolEffects)) {
      expect(effect).toBe('read');
    }
  });

  it('production import graph excludes write lab / SMTP / POP3 / MCP / OCR', () => {
    const hits = collectForbiddenImports();
    expect(hits).toEqual([]);
  });

  it('HMS process is only browser owner; default worker cannot claim HMS lane', () => {
    const report = auditProductionBoundary();
    expect(report.hmsBrowserOwnerOnly).toBe(true);
    expect(report.defaultWorkerCannotClaimHms).toBe(true);
    const pm2 = loadPm2Config() as {
      apps: Array<{ name: string; env?: Record<string, string> }>;
    };
    expect(pm2.apps.find((a) => a.name === 'ai-worker')?.env?.AI_WORKER_LANE).toBe('default');
    expect(pm2.apps.find((a) => a.name === 'hms-ai-worker')?.env?.AI_WORKER_LANE).toBe('hms');
  });

  it('built package and PM2 config include no mutation enable flag', () => {
    const report = auditProductionBoundary();
    expect(report.mutationFlagsAbsent).toBe(true);
    expect(report.passed).toBe(true);
    const pm2 = loadPm2Config() as {
      apps: Array<{ env?: Record<string, string> }>;
    };
    for (const app of pm2.apps) {
      for (const key of FORBIDDEN_MUTATION_ENABLE_KEYS) {
        expect(app.env?.[key]).toBeUndefined();
      }
    }
  });

  it('HMS_DB_TEST_REQUIRED fails closed when DATABASE_URL missing', () => {
    const prevRequired = process.env.HMS_DB_TEST_REQUIRED;
    const prevUrl = process.env.DATABASE_URL;
    try {
      process.env.HMS_DB_TEST_REQUIRED = '1';
      delete process.env.DATABASE_URL;
      expect(() => assertHmsDbTestPrerequisite()).toThrow(/fail closed/);
    } finally {
      if (prevRequired === undefined) delete process.env.HMS_DB_TEST_REQUIRED;
      else process.env.HMS_DB_TEST_REQUIRED = prevRequired;
      if (prevUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevUrl;
    }
  });

  it('security marker matrix: raw markers absent or redacted across surfaces', () => {
    const clean = assertSecurityMarkersAbsentOrRedacted({
      dbRowsJson: JSON.stringify({ note: 'ok' }),
      logs: 'request ok',
      metricsJson: '{}',
      healthJson: '{}',
      mastraJson: '{}',
      evidenceJson: JSON.stringify({ claimKeys: [] }),
    });
    expect(clean.passed).toBe(true);

    const redacted = assertSecurityMarkersAbsentOrRedacted({
      logs: `saw [REDACTED:${SECURITY_MARKERS.email}] in mail`,
      evidenceJson: `[REDACTED:${SECURITY_MARKERS.pdf}]`,
    });
    expect(redacted.passed).toBe(true);

    const leak = assertSecurityMarkersAbsentOrRedacted({
      logs: `leaked ${SECURITY_MARKERS.secretMeta}`,
    });
    expect(leak.passed).toBe(false);
    expect(leak.leaks.some((l) => l.includes(SECURITY_MARKERS.secretMeta))).toBe(true);
  });

  it('API fixture journeys cover Task 9 draft pipeline matrix', async () => {
    const journeys = await runHmsDraftPipelineJourneys();
    expect(journeys).toHaveLength(10);
    const failed = journeys.filter((j) => !j.passed);
    expect(failed, JSON.stringify(failed)).toEqual([]);
  });
});
