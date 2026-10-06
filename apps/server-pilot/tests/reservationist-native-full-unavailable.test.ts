import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createExistingOwnerNativeQuoteReader } from '../src/ai/reservationist-evaluation-composition.js';
import { ReservationistTaskEvidenceUnavailable } from '../src/ai/reservationist-execution.js';

it.each(['business_gap', 'invalid_audit', 'wrong_request', 'wrong_group', 'source_issue', 'incomplete_detail'] as const)(
  'classifies a full native capture only after its integrity and coverage checks: %s', async mode => {
    const contract = '../tooling/playwright-quote/quote-contract.mjs';
    const { normalizeQuoteRequest, composeAllocation } = await import(contract);
    const root = await mkdtemp(join(process.cwd(), '../../.private/playwright-quote/full-gap-synthetic-'));
    try {
      const request = { propertyCode: 'HRCEN', arrivalDate: '2026-10-12', departureDate: '2026-10-13', requestedCurrency: 'ZAR', details: 'full', rooms: ['A', 'B'].map(id => ({ id, quantity: 1, adults: 1, children: 0, childAges: [], required: { roomCodes: ['STWN'], rateCodes: ['BLRB'] } })) };
      const normalized = normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
      const groups = normalized.rooms.map((room: any) => ({ id: room.id, request: room, outcome: 'partial', completeness: { search: 'complete', requiredFacts: 'complete' }, issues: [], options: [{ id: 'HRCEN:STWN:BLRB', room: { code: 'STWN', buildingCode: null }, rate: { code: 'BLRB' }, rateScope: 'unknown', eligibility: 'conditional', availability: 'available', matchStatus: 'match', held: false, issues: [], details: { status: 'complete' }, nightly: [{ date: '2026-10-12', inventory: 64, price: { amount: '1780.00', currency: 'ZAR' } }] }] }));
      const evidence = join(root, 'capture'); await mkdir(evidence);
      const capture: any = { schemaVersion: 2, outcome: 'partial', observedAt: new Date().toISOString(), requested: normalized, groups, allocation: composeAllocation(groups, 'HRCEN'), issues: [], searchCompleteness: { status: 'complete' }, audit: { status: 'complete' }, evidenceDirectory: evidence };
      if (mode === 'invalid_audit') capture.audit.status = 'partial';
      if (mode === 'wrong_request') capture.requested = { ...normalized, arrivalDate: '2026-10-11' };
      if (mode === 'wrong_group') capture.groups[0].request = { ...capture.groups[0].request, adults: 2 };
      if (mode === 'source_issue') capture.issues.push({ code: 'SEARCH_EXECUTION_FAILED' });
      if (mode === 'incomplete_detail') capture.groups[0].options[0].details.status = 'partial';
      await writeFile(join(evidence, 'result.json'), JSON.stringify(capture));
      const dispatch = vi.fn(async () => ({ stdout: `Evidence: ${evidence}\n` }));
      const read = createExistingOwnerNativeQuoteReader({ owner: { cdpUrl: 'http://127.0.0.1:9222', browserOwnership: 'borrowed', propertyCode: 'HRCEN', secretPath: '/unused/test-secret' }, outputDir: root, dispatch });
      let failure: unknown;
      try { await read(request, new AbortController().signal); } catch (error) { failure = error; }
      if (mode === 'business_gap') { expect(failure).toBeInstanceOf(ReservationistTaskEvidenceUnavailable); expect(failure).toMatchObject({ code: 'native_quote_business_evidence_unavailable' }); }
      else { expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(ReservationistTaskEvidenceUnavailable); expect(String(failure)).toContain('native_quote_capture_scope_or_completeness_invalid'); }
      expect(dispatch).toHaveBeenCalledOnce();
      expect(capture.outcome).toBe('partial');
    } finally { await rm(root, { recursive: true, force: true }); }
  },
);
