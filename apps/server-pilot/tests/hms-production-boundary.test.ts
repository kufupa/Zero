import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_MUTATION_ENABLE_KEYS,
  SECURITY_MARKERS,
  assertHmsDbTestPrerequisite,
  assertSecurityMarkersAbsentOrRedacted,
  auditProductionBoundary,
  buildSecurityMarkerSurfacesFromInjectedPayloads,
  collectBusinessNotFoundAssignments,
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

  it('security marker matrix: injected payloads redacted across serialization surfaces', () => {
    const surfaces = buildSecurityMarkerSurfacesFromInjectedPayloads({
      emailBody: `Guest wrote ${SECURITY_MARKERS.email} in thread`,
      fixtureDomPostData: new URLSearchParams({
        action: 'search',
        tenant: 'FIXTURE',
        property: 'centurion',
        surname: SECURITY_MARKERS.fixtureDom,
      }).toString(),
      pdfText: `Confirmation PDF contains ${SECURITY_MARKERS.pdf}`,
      secretLoaderError: `secret load failed password=${SECURITY_MARKERS.secretMeta}`,
    });

    const check = assertSecurityMarkersAbsentOrRedacted(surfaces);
    expect(check.leaks, JSON.stringify(check.leaks)).toEqual([]);
    expect(check.passed).toBe(true);

    // Evidence / health must not carry raw PDF or secret markers.
    expect(surfaces.evidenceJson).not.toContain(SECURITY_MARKERS.pdf);
    expect(surfaces.healthJson).not.toContain(SECURITY_MARKERS.secretMeta);
    expect(surfaces.healthJson).toContain('redacted_error');
    // DOM body values must not appear in request-policy decision serialization.
    expect(surfaces.dbRowsJson).not.toContain(SECURITY_MARKERS.fixtureDom);
    // Email marker only allowed as explicit redaction token in logs.
    expect(surfaces.logs).toContain(`[REDACTED:${SECURITY_MARKERS.email}]`);
    expect(surfaces.logs.replaceAll(`[REDACTED:${SECURITY_MARKERS.email}]`, '')).not.toContain(
      SECURITY_MARKERS.email,
    );

    // Control: raw injection without redaction path still fails the assert helper.
    const leak = assertSecurityMarkersAbsentOrRedacted({
      logs: `leaked ${SECURITY_MARKERS.secretMeta}`,
    });
    expect(leak.passed).toBe(false);
    expect(leak.leaks.some((l) => l.includes(SECURITY_MARKERS.secretMeta))).toBe(true);
  });

  it('API fixture journeys cover Task 9 draft pipeline matrix', async () => {
    const wallPastHardcodedExpiry =
      Date.now() > Date.parse('2026-07-30T13:00:00.000Z');
    expect(wallPastHardcodedExpiry).toBe(true);

    const journeys = await runHmsDraftPipelineJourneys(new Date());
    expect(journeys).toHaveLength(10);
    const failed = journeys.filter((j) => !j.passed);
    expect(failed, JSON.stringify(failed)).toEqual([]);

    const byId = Object.fromEntries(journeys.map((j) => [j.id, j]));
    expect(byId.reservation_exact_candidate?.passed).toBe(true);
    expect(byId.refresh_failure_keeps_prior?.detail).toMatch(/visible=draft-prior/);
    expect(byId.outbound_before_send_stale?.detail).toMatch(/freshness=stale_thread/);
    expect(byId.off_mode_skeleton_promotable?.detail).toMatch(/enriched=false/);
  });

  it('HMS shadow terminal modules cannot import src/ai/drafts.ts', () => {
    const hits = collectForbiddenImports();
    const draftHits = hits.filter((h) => /ai\/drafts/.test(h.match) || /ai\/drafts/.test(h.file));
    expect(draftHits).toEqual([]);
    // Syntax-aware scan must reject drafts.ts on shadow terminal path when present.
    const shadowDraftHits = collectForbiddenImports().filter((h) =>
      h.match.includes('ai/drafts'),
    );
    expect(shadowDraftHits).toEqual([]);
  });

  it('sole path: parser/driver/receipt/claim/worker/proof cannot assign business not_found', () => {
    expect(collectBusinessNotFoundAssignments()).toEqual([]);
  });
});
