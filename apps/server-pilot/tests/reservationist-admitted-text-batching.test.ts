import { extractReservationistPlan } from '../src/ai/reservationist-extraction.js';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';

it.each(['per_source', undefined] as const)(
  'includes admitted text/DOCX source occurrences in existing text batches: %s',
  async (messageBatching) => {
    const text = 'Please quote.';
    const sourceHash = createHash('sha256').update(text).digest('hex');
    const artifactText = 'Group A: 1 room, 1 adult.';
    const admissions = [
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ].map((mimeType, index) => {
      const attachmentId = `source-${index}`;
      const body = Buffer.from(`synthetic-original-${index}`);
      const hash = createHash('sha256').update(body).digest('hex');
      return {
        status: 'admitted',
        metadata: {
          attachmentId,
          mimeType,
          sourceHash: hash,
          messageAt: '2026-10-04T08:00:00Z',
          disclosure: 'guest',
          sizeBytes: body.length,
        },
        source: {
          attachmentId,
          sourceHash: hash,
          pages: [artifactText],
          pageCount: 1,
          disclosure: 'guest',
          ...(index
            ? {
                rendering: {
                  method: 'gotenberg_libreoffice',
                  originalSourceHash: hash,
                  derivedPdfSHA256: 'b'.repeat(64),
                  pageProvenance: 'derived_pdf',
                  textSHA256: createHash('sha256').update(JSON.stringify([artifactText])).digest('hex'),
                },
              }
            : {}),
        },
        bytes: { body, sha256: hash },
      };
    });
    const requests: any[] = [];
    const invoke = vi.fn(async (request: any) => {
      const prompt = JSON.parse(request.userPrompt);
      requests.push(prompt);
      return {
        output:
          requests.length === 1
            ? {
                facts: [],
                tasks: [
                  {
                    id: 'quote',
                    kind: 'quote',
                    factIds: [],
                    source: { attachmentId: 'message:m', sourceHash, page: 1, quote: text },
                  },
                ],
                unresolvedAsks: [],
              }
            : {
                facts: prompt.sources
                  .filter((source: any) => source.attachmentId.startsWith('source-'))
                  .map((source: any) => ({
                    id: `room-${source.attachmentId}`,
                    kind: 'room',
                    disclosure: 'guest',
                    source: {
                      attachmentId: source.attachmentId,
                      sourceHash: source.sourceHash,
                      page: 1,
                      quote: artifactText,
                    },
                    value: { roomRef: 'A', quantity: 1, adults: 1, childAges: [] },
                  })),
                assignments: [
                  {
                    taskId: 'quote',
                    factIds: prompt.sources
                      .filter((source: any) => source.attachmentId.startsWith('source-'))
                      .map((source: any) => `room-${source.attachmentId}`),
                  },
                ],
                unresolvedAsks: [],
              },
      };
    });
    const reserveCalls = vi.fn(async () => {});
    const result = await extractReservationistPlan({
      adapter: { invoke, reserveCalls } as never,
      mode: 'task_first',
      factEnrichmentMode: 'source_batches',
      messageBatching,
      messages: [{ id: 'm', at: '2026-10-04T08:00:00Z', text }],
      causalAt: '2026-10-04T08:00:00Z',
      admissions: admissions as never,
      signal: new AbortController().signal,
    });
    expect(result.facts).toHaveLength(2);
    expect(result.sourceIncomplete).toEqual([]);
    expect(
      result.extractionDiagnostics?.batches.every(
        (batch) => batch.status === 'completed' && batch.kind === 'messages',
      ),
    ).toBe(true);
    const factSources = requests.slice(1).flatMap((request) => request.sources);
    expect(factSources.map((source) => source.attachmentId)).toEqual([
      'message:m',
      'source-0',
      'source-1',
    ]);
    expect(factSources.find((source) => source.attachmentId === 'source-1').rendering).toEqual(
      admissions[1]!.source.rendering,
    );
    expect(reserveCalls).toHaveBeenCalledWith(
      messageBatching === 'per_source' ? 4 : 2,
      expect.any(AbortSignal),
    );
  },
);
