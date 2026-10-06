import { expect, it } from 'vitest';
import { assessReply } from '../src/ai/reply-assessment.js';
import { runReservationistRuntime, type ReservationistRuntimeInput, type RuntimeWorkResult } from '../src/ai/reservationist-runtime.js';
import type { PreparedFact } from '../src/ai/prepared-draft-input.js';
import { buildRevisionProposalPdf, type RevisionProposalHeader } from '../src/quote-proposal/proposal-pdf.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

const text = 'Please see the attached quotation. The total is ZAR 8500.00. No rooms are currently being held.';
const fact: PreparedFact = { key: 'quote_total_task-1', label: 'Selected quotation total', value: { total: 'ZAR 8500.00', amount: '8500.00', currency: 'ZAR' }, source: 'hms', status: 'known', authority: 'authorized', disclosure: 'guest', evidenceRef: 'native-quote:source', scopeVerified: true };
it('covers opaque task IDs with the exact authorized structured quotation total', () => {
  const assessment = assessReply({ replyText: text, asks: [{ code: 'quote_total_task-1', label: 'task-1', required: true }], facts: [fact], authorizedAttachmentRefs: ['pdf'] });
  expect(assessment.coverage).toEqual({ answered: 1, total: 1 });
  expect(assessment.issues).toEqual([]);
});
it.each(['other-task', 'unknown', 'staff-only', 'wrong-amount'] as const)('does not cover a quotation using %s evidence', mode => {
  const f: PreparedFact = { ...fact, ...(mode === 'other-task' ? { key: 'quote_total_task-2' } : {}), ...(mode === 'unknown' ? { authority: 'unknown' } : {}), ...(mode === 'staff-only' ? { disclosure: 'staff_only' } : {}), ...(mode === 'wrong-amount' ? { value: { amount: '8600.00', currency: 'ZAR', total: 'ZAR 8600.00' } } : {}) };
  const assessment = assessReply({ replyText: text, asks: [{ code: 'quote_total_task-1', label: 'task-1', required: true }], facts: [f], authorizedAttachmentRefs: ['pdf'] });
  if (mode === 'wrong-amount') {
    expect(assessment.ok).toBe(false);
    expect(assessment.issues.map(i => i.code)).toContain('AMOUNT_OR_CURRENCY_MISMATCH');
  } else {
    expect(assessment.coverage).toEqual({ answered: 0, total: 1 });
    expect(assessment.issues.map(i => i.code)).toContain('MISSING_BRACKET');
  }
});
it('maps an opaque runtime quotation task to its exact prepared total', async () => {
  const at = '2026-10-05T13:30:00Z';
  const input: ReservationistRuntimeInput = { version: 1, requestId: 'request', propertyCode: 'HRCEN', trigger: { id: 'message', at }, messages: [{ id: 'message', at, direction: 'inbound', text: 'Please prepare a quotation.' }], authorizedArtifacts: [], clock: { causalAt: at, sourceAt: at, deadlineAt: Date.now() + 60000 }, capabilities: { pmsWrite: false, emailSend: false } };
  const work: RuntimeWorkResult = { tasks: [{ id: 'task-1', status: 'complete', guestText: text, evidenceRefs: ['native-quote:source', 'pdf'] }], approvedGuestClauses: { 'task-1': text }, preparedFacts: [fact], artifacts: [{ ref: 'pdf', sha256: 'a'.repeat(64), sizeBytes: 100, fileName: 'synthetic.pdf', mimeType: 'application/pdf' }], quoteRefs: [], packets: [], errors: [] };
  const dependencies: Parameters<typeof runReservationistRuntime>[1] = { plan: async () => ({ tasks: [{ id: 'task-1', kind: 'quote', required: true }], facts: [] }), execute: async () => work, verifyArtifact: async () => true, verifyGuestClause: async () => true };
  const result = await runReservationistRuntime(input, dependencies);
  expect(result.assessment.coverage).toEqual({ answered: 1, total: 1 });
  expect(result.assessment.issues).toEqual([]);
  const { runPreparedWorkerCandidateReply } = await import('../src/ai/worker.js');
  const prepared = await runPreparedWorkerCandidateReply({ requestId: input.requestId, requestText: input.messages[0].text, qualifiedReservationist: { input, dependencies }, route: {
    route: { routeId: 'synthetic', modelId: 'synthetic', purpose: 'draft', protocol: 'in_process', access: 'current_app', egress: 'none', retention: 'bounded', usage: 'reported' },
    transport: async () => { throw new Error('No model calls in reply revalidation'); },
    release: { releaseId: 'synthetic', releaseVersion: '1', sourceRevision: 'synthetic', fingerprint: 'a'.repeat(64), purpose: 'draft', capabilityFamilyVersions: { reservationist: 'reservationist-runtime-v1' }, issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', withdrawn: false },
  } });
  expect(prepared.outcome).toBe('complete');
  expect(prepared.assessment.coverage).toEqual({ answered: 1, total: 1 });
  expect(prepared.assessment.issues).toEqual([]);
  expect(prepared.textBody).toBe(result.textBody);
});
it.each(['', '   ', 'Causal Agency'])('uses source-backed company when quotation agency is blank: %j', async agency => {
  const revision = await syntheticRevision();
  const header: RevisionProposalHeader = { attention: '', company: 'Causal Department', clientEmail: '', clientTelephone: '', agency, signerName: '', signerEmail: '' };
  let rendered = '';
  const result = await buildRevisionProposalPdf(revision, header, { url: 'http://synthetic.invalid', fetchImpl: async (_url, init) => {
    const file = (init!.body as FormData).get('files');
    if (!(file instanceof Blob)) throw new Error('expected proposal HTML');
    rendered = await file.text();
    return new Response('%PDF-synthetic-filename-only', { headers: { 'content-type': 'application/pdf' } });
  } });
  expect(result.fileName).toBe(`Quote - ${agency.trim() || 'Causal Department'} ${revision.authoredDate}.pdf`);
  expect(rendered).toContain('<strong>Attention:</strong> <br>');
  expect(header.attention).toBe('');
  expect(rendered).toContain('<strong>Company:</strong> Causal Department');
});
