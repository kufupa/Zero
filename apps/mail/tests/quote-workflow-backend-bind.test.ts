import { describe, expect, it, vi } from 'vitest';
import {
  bindAnalyseSelection,
  bindQualifiedProposalPdf,
  bindRunStep,
  quoteWorkflowFromTrpc,
  QUOTE_WORKFLOW_BIND_TARGETS,
  STAFF_QUOTE_PILOT_MISSING,
} from '../lib/quote-workflow/backend-bind';

describe('quote workflow backend bind', () => {
  it('names the published staff-quote procedures rather than a second engine', () => {
    expect(QUOTE_WORKFLOW_BIND_TARGETS.analyseSelection).toBe('quoteWorkflow.analyseSelection');
    expect(QUOTE_WORKFLOW_BIND_TARGETS.staffQuoteSource).toBe('workstation.staffQuoteSource');
    expect(QUOTE_WORKFLOW_BIND_TARGETS.executeStaffQuote).toBe('workstation.executeStaffQuote');
    expect(QUOTE_WORKFLOW_BIND_TARGETS.qualifiedPdf).toBe('workstation.qualifiedQuoteProposalPdf');
    expect(QUOTE_WORKFLOW_BIND_TARGETS.staffActions).toMatch(/staffActions/);
    expect(QUOTE_WORKFLOW_BIND_TARGETS).not.toHaveProperty('runStepServerLater');
  });

  it('reads quoteWorkflow off a partial tRPC client without throwing', () => {
    expect(quoteWorkflowFromTrpc({ workstation: {} })).toEqual({});
    const mutate = vi.fn();
    expect(
      quoteWorkflowFromTrpc({ quoteWorkflow: { analyseSelection: { mutate } } }).analyseSelection
        ?.mutate,
    ).toBe(mutate);
  });

  it('reports unavailable when analyseSelection is not on the client', async () => {
    const result = await bindAnalyseSelection({
      input: {
        storeId: 'store-1',
        entryId: '001',
        folderEntryId: 'folder-inbox',
        selectionEpoch: 1,
      },
    });
    expect(result.kind).toBe('unavailable');
  });

  it('passes through mailbox unsynced without inventing a source', async () => {
    const mutate = vi.fn(async () => ({ status: 'unsynced' as const }));
    const result = await bindAnalyseSelection({
      mutate,
      input: {
        storeId: 'store-1',
        entryId: '001',
        folderEntryId: 'folder-inbox',
        selectionEpoch: 2,
        internetMessageId: '<a@x>',
      },
    });
    expect(result).toEqual({ kind: 'unsynced' });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('does not treat runStep unavailable as a license to enqueue HMS from the pane', async () => {
    const result = await bindRunStep({
      stepId: 'quote-stay',
      selectionEpoch: 1,
      inputRevision: 1,
      inputs: {},
    });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/enqueueHmsRead/);
    }
  });

  it('forwards integration_unavailable from the existing runStep procedure', async () => {
    const mutate = vi.fn(async () => ({
      status: 'integration_unavailable' as const,
      reason: 'Live PMS search is not owned by this quoting UI.',
    }));
    const inputs = {
      stepKind: 'quote_stay' as const,
      binding: {
        transportId: 't1',
        mailboxEmail: 'centurion@legacyhotels.co.za',
        storeId: 'store',
        folderEntryId: 'inbox',
        entryId: 'e1',
        selectionEpoch: 1,
      },
      groups: [
        {
          id: 'g1',
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          quantity: 1,
          roomPreference: 'standard king',
          adults: 1,
          childrenAges: [] as number[],
          board: 'bb' as const,
          specialRequests: [] as string[],
        },
      ],
    };
    const result = await bindRunStep({
      mutate,
      stepId: 'quote-stay-2026-11-12:2026-11-14',
      selectionEpoch: 1,
      inputRevision: 3,
      inputs,
    });
    expect(result).toEqual({
      status: 'integration_unavailable',
      reason: 'Live PMS search is not owned by this quoting UI.',
    });
    expect(mutate).toHaveBeenCalledWith({
      stepId: 'quote-stay-2026-11-12:2026-11-14',
      selectionEpoch: 1,
      inputRevision: 3,
      inputs,
    });
    expect(mutate).not.toHaveBeenCalledWith(expect.objectContaining({ toolId: 'hms_quote_stay' }));
  });

  it('does not treat quote_stay ok without offers as authorised inventory', async () => {
    const mutate = vi.fn(async () => ({ status: 'ok' as const }));
    const result = await bindRunStep({
      mutate,
      stepId: 'quote-stay',
      selectionEpoch: 1,
      inputRevision: 1,
      inputs: { stepKind: 'quote_stay', binding: { selectionEpoch: 1 }, groups: [] },
    });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/without offers|do not synthesize/i);
    }
  });

  it('refuses a separate party execute even when a party mutate is present', async () => {
    const mutate = vi.fn(async () => ({
      status: 'ok' as const,
      party: { organisation: 'Provincial Treasury', partyRef: 'party-treasury-1' },
    }));
    const result = await bindRunStep({
      mutate,
      stepId: 'party-lookup',
      selectionEpoch: 1,
      inputRevision: 1,
      inputs: { stepKind: 'party_lookup' },
    });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/not execute party twice/i);
    }
    expect(mutate).not.toHaveBeenCalled();
  });

  it('returns typed unavailable when analyseSelection, runStep, or PDF mutate reject', async () => {
    const analyse = await bindAnalyseSelection({
      mutate: async () => {
        throw new Error('analyseSelection network down');
      },
      input: {
        storeId: 'store-1',
        entryId: '001',
        folderEntryId: 'folder-inbox',
        selectionEpoch: 1,
      },
    });
    expect(analyse.kind).toBe('unavailable');
    if (analyse.kind === 'unavailable') {
      expect(analyse.reason).toMatch(/analyseSelection network down/);
    }

    const run = await bindRunStep({
      mutate: async () => {
        throw new Error('runStep network down');
      },
      stepId: 'quote-stay',
      selectionEpoch: 1,
      inputRevision: 1,
      inputs: { stepKind: 'quote_stay' },
    });
    expect(run.status).toBe('unavailable');
    if (run.status === 'unavailable') {
      expect(run.reason).toMatch(/runStep network down/);
    }

    const pdf = await bindQualifiedProposalPdf({
      mutate: async () => {
        throw new Error('pdf network down');
      },
      input: { selectedOfferIds: ['a'], sourceRevision: 1, mailboxTransportId: 't1' },
    });
    expect(pdf.status).toBe('unavailable');
    if (pdf.status === 'unavailable') {
      expect(pdf.reason).toMatch(/mint centsReconciled:true/i);
    }
  });

  it('does not mint centsReconciled:true from the old PDF bind', async () => {
    const minted = await bindQualifiedProposalPdf({
      mutate: async () => ({
        fileName: 'Quote-authorised.pdf',
        pdfBase64: 'JVBERi0xLjQK',
        centsReconciled: true as const,
      }),
      input: { selectedOfferIds: ['a'], sourceRevision: 1, mailboxTransportId: 't1' },
    });
    expect(minted.status).toBe('unavailable');
    if (minted.status === 'unavailable') {
      expect(minted.reason).toMatch(/mint centsReconciled:true/i);
    }
  });

  it('names remaining connected dependencies instead of unpublished placeholders', () => {
    expect(STAFF_QUOTE_PILOT_MISSING.handoffFile).toBe(
      'docs/plans/handoff-reports/2026-10-06-staff-quote-pilot-backend-handoff.md',
    );
    expect(STAFF_QUOTE_PILOT_MISSING.snapshot).toMatch(/snapshot/);
    expect(STAFF_QUOTE_PILOT_MISSING.connectedIntegration).toMatch(/qualifiedQuoteProposalPdf/);
  });

  it('passes through published reviewItems and named documentFailures only', async () => {
    const reviewItems = [
      {
        id: 'q-shuttle',
        kind: 'question' as const,
        rank: 'secondary' as const,
        text: 'Is an airport shuttle available?',
        sourceLabel: 'Selected message',
        blocking: false,
      },
    ];
    const ready = await bindAnalyseSelection({
      mutate: vi.fn(async () => ({
        status: 'ready' as const,
        intent: 'quote' as const,
        groups: [],
        secondaryAsks: ['Is an airport shuttle available?'],
        alternatives: [],
        sourceRevision: 4,
        reviewItems,
      })),
      input: { storeId: 'store-1', entryId: '001', folderEntryId: 'folder-inbox', selectionEpoch: 1 },
    });
    expect(ready).toEqual({
      kind: 'ready',
      sourceRevision: 4,
      analysis: {
        intent: 'quote',
        groups: [],
        secondaryAsks: ['Is an airport shuttle available?'],
        alternatives: [],
        reviewItems,
      },
    });

    const missing = await bindAnalyseSelection({
      mutate: vi.fn(async () => ({
        status: 'missing_source' as const,
        missing: ['att-1'],
        documentFailures: [
          {
            filename: 'rooming-list.pdf',
            reason: 'Authorised attachment content is missing. Filenames are not document bytes.',
            sourceKind: 'attachment' as const,
          },
        ],
      })),
      input: { storeId: 'store-1', entryId: '001', folderEntryId: 'folder-inbox', selectionEpoch: 1 },
    });
    expect(missing).toEqual({
      kind: 'missing_source',
      missing: ['att-1'],
      documents: [
        {
          filename: 'rooming-list.pdf',
          reason: 'Authorised attachment content is missing. Filenames are not document bytes.',
          sourceKind: 'attachment',
        },
      ],
    });

    const unnamed = await bindAnalyseSelection({
      mutate: vi.fn(async () => ({ status: 'missing_source' as const, missing: ['att-1'] })),
      input: { storeId: 'store-1', entryId: '001', folderEntryId: 'folder-inbox', selectionEpoch: 1 },
    });
    expect(unnamed).toEqual({ kind: 'missing_source', missing: ['att-1'], documents: [] });
  });

  it('does not invent a second PDF engine when qualifiedQuoteProposalPdf is absent', async () => {
    const result = await bindQualifiedProposalPdf({
      input: { selectedOfferIds: ['a'], sourceRevision: 1, mailboxTransportId: 't1' },
    });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/mint centsReconciled:true/i);
    }
  });
});
