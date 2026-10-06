import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {extractReservationistPlan} from '../src/ai/reservationist-extraction.js';

const at = '2026-10-01T10:00:00Z';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function source(id: string, ownerMessage: string) {
  const body = Buffer.from('%PDF-1.7 synthetic reference fixture');
  const sourceHash = sha(body);
  return {
    status: 'admitted',
    metadata: {attachmentId: id, messageId: ownerMessage, ownerRef: 'owner', threadId: 'thread', messageAt: at, mimeType: 'application/pdf', sizeBytes: body.length, sourceHash, disclosure: 'guest'},
    source: {attachmentId: id, sourceHash, disclosure: 'guest', pages: ['Confirmation Number: 12345678-1'], pageCount: 1},
    bytes: {body, sha256: sourceHash},
  };
}

function setup(messageBatching: 'grouped' | 'per_source' = 'grouped') {
  const text = 'Please confirm the reservation status?';
  const messages = [{id: 'prior', at, text: 'Earlier reference context', direction: 'inbound'}, {id: 'm', at, text, direction: 'inbound'}];
  const admissions = [source('pdf-prior', 'prior'), source('pdf-current', 'm')];
  const tasks = [{id: 'status', kind: 'question', factIds: [], source: {attachmentId: 'message:m', sourceHash: sha(text), page: 1, quote: text}}];
  let call = 0;
  const invoke = vi.fn(async (_request: any): Promise<any> => ({
    output: call++ === 0 ? {facts: [], tasks, unresolvedAsks: []} : {facts: [], assignments: [{taskId: 'status', factIds: []}], unresolvedAsks: []},
    modelId: 'synthetic-only', usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0, rateTableVersion: 'synthetic-only'},
  }));
  const reserveCalls = vi.fn(async () => {});
  return {input: {adapter: {reserveCalls, invoke}, mode: 'task_first', factEnrichmentMode: 'source_batches', ...(messageBatching === 'per_source' ? {messageBatching} : {}), triggerMessageId: 'm', messages, causalAt: at, admissions, signal: new AbortController().signal}, invoke, reserveCalls};
}

describe('delivery extraction failure characterization', () => {
  it.each(['grouped', 'per_source'] as const)('retains every identical-PDF occurrence binding under %s message batching', async batching => {
    const s = setup(batching);
    const plan: any = await extractReservationistPlan(s.input as never);
    const prompts = s.invoke.mock.calls.slice(1).map(([request]) => JSON.parse(request.userPrompt));
    expect(plan.extractionDiagnostics.batches.every((batch: any) => batch.status === 'completed')).toBe(true);
    for (const prompt of prompts) {
      expect(prompt.sourceManifest.filter((item: any) => item.attachmentId.startsWith('pdf-')).map((item: any) => [item.attachmentId, item.sourceHash])).toEqual([
        ['pdf-prior', s.input.admissions[0]!.source.sourceHash],
        ['pdf-current', s.input.admissions[1]!.source.sourceHash],
      ]);
      expect([...prompt.sources, ...prompt.contextSources].filter((item: any) => item.attachmentId.startsWith('message:')).map((item: any) => [item.attachmentId, item.pages])).toEqual(expect.arrayContaining(s.input.messages.map(message => ['message:' + message.id, [message.text]])));
    }
    expect(plan.tasks[0].source.quote).toBe(s.input.messages[1]!.text);
    expect(s.input.admissions.map(admission => admission.metadata.messageId)).toEqual(['prior', 'm']);
  });

  it('compares existing grouping without invoking a model service or changing the source inventory', async () => {
    const grouped = setup(), perSource = setup('per_source');
    await extractReservationistPlan(grouped.input as never);
    await extractReservationistPlan(perSource.input as never);
    expect(grouped.invoke.mock.calls.length).toBe(3);
    expect(perSource.invoke.mock.calls.length).toBe(4);
    expect(grouped.input.admissions).toEqual(perSource.input.admissions);
  });

  it('uses the existing unique exact-text resolver without model offsets', async () => {
    const s = setup();
    let call = 0;
    s.invoke.mockImplementation(async () => ({output: call++ === 0 ? {facts: [], tasks: [{id: 'status', kind: 'question', factIds: [], source: {attachmentId: 'message:m', sourceHash: sha(s.input.messages[1]!.text), page: 1, quote: s.input.messages[1]!.text}}], unresolvedAsks: []} : call === 3 ? {facts: [{id: 'ref', kind: 'reservation_reference', value: '12345678-1', disclosure: 'guest', source: {attachmentId: 'pdf-current', sourceHash: s.input.admissions[1]!.source.sourceHash, page: 1, quote: 'Confirmation Number: 12345678-1'}}], assignments: [{taskId: 'status', factIds: ['ref']}], unresolvedAsks: []} : {facts: [], assignments: [{taskId: 'status', factIds: []}], unresolvedAsks: []}, modelId: 'synthetic-only', usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0, rateTableVersion: 'synthetic-only'}}));
    const plan = await extractReservationistPlan(s.input as never);
    expect(plan.facts[0]!.source).toMatchObject({attachmentId: 'pdf-current', page: 1, start: 0, end: 31, quote: 'Confirmation Number: 12345678-1'});
    expect(plan.facts[0]!.verification).toBe('text_verified');
  });

  it('refuses a repeated quote when model offsets are absent rather than choosing an occurrence', async () => {
    const s = setup();
    s.input.admissions[1]!.source.pages = ['Confirmation Number: 12345678-1\nConfirmation Number: 12345678-1'];
    let call = 0;
    s.invoke.mockImplementation(async () => ({output: call++ === 0 ? {facts: [], tasks: [{id: 'status', kind: 'question', factIds: [], source: {attachmentId: 'message:m', sourceHash: sha(s.input.messages[1]!.text), page: 1, quote: s.input.messages[1]!.text}}], unresolvedAsks: []} : call === 3 ? {facts: [{id: 'ref', kind: 'reservation_reference', value: '12345678-1', disclosure: 'guest', source: {attachmentId: 'pdf-current', sourceHash: s.input.admissions[1]!.source.sourceHash, page: 1, quote: 'Confirmation Number: 12345678-1'}}], assignments: [{taskId: 'status', factIds: ['ref']}], unresolvedAsks: []} : {facts: [], assignments: [{taskId: 'status', factIds: []}], unresolvedAsks: []}, modelId: 'synthetic-only', usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0, rateTableVersion: 'synthetic-only'}}));
    await expect(extractReservationistPlan(s.input as never)).rejects.toThrow('Ambiguous original text span');
  });

  it('projects fact sources to exact quote or visual region, leaving offsets to the existing server resolver', async () => {
    const s = setup();
    await extractReservationistPlan(s.input as never);
    const pdfRequest = s.invoke.mock.calls.at(-1)![0];
    const schema: any = pdfRequest.responseSchema;
    const facts = schema.properties.facts.items.anyOf;
    for (const fact of facts) {
      const projection = fact.properties.source;
      expect(projection).toHaveProperty('anyOf');
      expect(projection.anyOf).toHaveLength(2);
      expect(projection.anyOf.map((branch: any) => branch.required)).toEqual([
        ['attachmentId', 'sourceHash', 'page', 'quote'],
        ['attachmentId', 'sourceHash', 'page', 'region'],
      ]);
      for (const branch of projection.anyOf) {
        expect(branch.properties).not.toHaveProperty('start');
        expect(branch.properties).not.toHaveProperty('end');
      }
    }
  });

  it('limits status enrichment to reference and independently explicit guest/date target context', async () => {
    const s = setup();
    await extractReservationistPlan(s.input as never);
    const request: any = s.invoke.mock.calls[1]![0];
    expect(request.responseSchema.properties.facts.items.anyOf.map((fact: any) => fact.properties.kind.const)).toEqual(['dates', 'guest', 'reservation_reference']);
  });

  it('retains commercial fact kinds for a mixed booking and status request', async () => {
    const s = setup();
    const text = 'Please book accommodation. Please confirm the reservation status?';
    s.input.messages[1]!.text = text;
    let call = 0;
    s.invoke.mockImplementation(async () => ({output: call++ === 0 ? {facts: [], tasks: [{id: 'book', kind: 'new_booking', factIds: [], source: {attachmentId: 'message:m', sourceHash: sha(text), page: 1, quote: 'Please book accommodation.'}}, {id: 'status', kind: 'question', factIds: [], source: {attachmentId: 'message:m', sourceHash: sha(text), page: 1, quote: 'Please confirm the reservation status?'}}], unresolvedAsks: []} : {facts: [], assignments: [{taskId: 'book', factIds: []}, {taskId: 'status', factIds: []}], unresolvedAsks: []}, modelId: 'synthetic-only', usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0, rateTableVersion: 'synthetic-only'}}));
    await extractReservationistPlan(s.input as never);
    const request: any = s.invoke.mock.calls[1]![0];
    expect(request.responseSchema.properties.facts.items.anyOf.map((fact: any) => fact.properties.kind.const)).toEqual(expect.arrayContaining(['party', 'room', 'board', 'rate_claim', 'reservation_reference']));
  });

  it('dispatches identical causal PDF bytes once and retains every original occurrence in batch diagnostics', async () => {
    const s = setup();
    const plan: any = await extractReservationistPlan(s.input as never);
    const pdfRequest = s.invoke.mock.calls.at(-1)![0];
    expect(pdfRequest.files).toHaveLength(1);
    expect(pdfRequest.files[0].filename).toBe('pdf-current.pdf');
    expect(JSON.parse(pdfRequest.userPrompt).sources.map((item: any) => item.attachmentId)).toEqual(['pdf-current']);
    expect(plan.extractionDiagnostics.batches.at(-1).sources.map((item: any) => item.attachmentId)).toEqual(['pdf-prior', 'pdf-current']);
  });

  it('retains separate bytes when the exact duplicate has different disclosure or extracted pages', async () => {
    for (const difference of ['disclosure', 'pages'] as const) {
      const s = setup();
      if (difference === 'disclosure') {
        s.input.admissions[1]!.metadata.disclosure = 'staff_only';
        s.input.admissions[1]!.source.disclosure = 'staff_only';
      } else s.input.admissions[1]!.source.pages = ['Another original page'];
      await extractReservationistPlan(s.input as never);
      expect(s.invoke.mock.calls.at(-1)![0].files).toHaveLength(2);
    }
  });

  it('marks all duplicate occurrences unavailable when their mandatory representative batch fails', async () => {
    const s = setup();
    const invoke = s.invoke.getMockImplementation()!;
    let call = 0;
    s.invoke.mockImplementation(async request => {
      if (++call === 3) throw new Error('azure_luna_completion_incomplete');
      return invoke(request);
    });
    const plan: any = await extractReservationistPlan(s.input as never);
    expect(plan.sourceIncomplete.map((item: any) => item.attachmentId)).toEqual(['pdf-prior', 'pdf-current']);
    expect(plan.extractionDiagnostics.batches.at(-1).status).toBe('failed');
  });
});
