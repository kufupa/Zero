import { describe, expect, it, vi } from 'vitest';
import {
  bindAnalyseSelection,
  bindQualifiedProposalPdf,
  bindRunStep,
  quoteWorkflowFromTrpc,
  QUOTE_WORKFLOW_BIND_TARGETS,
} from '../lib/quote-workflow/backend-bind';

describe('quote workflow backend bind', () => {
  it('names the existing tRPC procedures rather than a second engine', () => {
    expect(QUOTE_WORKFLOW_BIND_TARGETS.analyseSelection).toBe('quoteWorkflow.analyseSelection');
    expect(QUOTE_WORKFLOW_BIND_TARGETS.runStep).toBe('quoteWorkflow.runStep');
    expect(QUOTE_WORKFLOW_BIND_TARGETS.runStepServerLater).toContain('hms_quote_stay');
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

  it('accepts party_lookup only when the backend returns a party reference, not invented entitlement', async () => {
    const mutate = vi.fn(async () => ({ status: 'ok' as const }));
    const inputs = {
      stepKind: 'party_lookup' as const,
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
          quantity: 2,
          roomPreference: 'suite',
          adults: 2,
          childrenAges: [8, 11],
          board: 'dinner_bb' as const,
          organisation: 'Provincial Treasury',
          specialRequests: ['late arrival'],
        },
      ],
    };
    const missing = await bindRunStep({
      mutate,
      stepId: 'party-lookup',
      selectionEpoch: 1,
      inputRevision: 1,
      inputs,
    });
    expect(missing.status).toBe('unavailable');
    if (missing.status === 'unavailable') {
      expect(missing.reason).toMatch(/party|entitlement|invent/i);
    }

    const withRef = vi.fn(async () => ({
      status: 'ok' as const,
      party: { organisation: 'Provincial Treasury', partyRef: 'party-treasury-1' },
    }));
    const found = await bindRunStep({
      mutate: withRef,
      stepId: 'party-lookup',
      selectionEpoch: 1,
      inputRevision: 1,
      inputs,
    });
    expect(found).toEqual({
      status: 'ok',
      kind: 'party_lookup',
      party: { organisation: 'Provincial Treasury', partyRef: 'party-treasury-1' },
    });
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
      expect(pdf.reason).toMatch(/pdf network down/);
    }
  });

  it('rejects unqualified PDF payloads even when the client mutate resolves', async () => {
    const missingCents = await bindQualifiedProposalPdf({
      mutate: async () =>
        ({ fileName: 'Quote.pdf', pdfBase64: 'JVBERi0xLjQK' }) as never,
      input: { selectedOfferIds: ['a'], sourceRevision: 1, mailboxTransportId: 't1' },
    });
    expect(missingCents.status).toBe('unavailable');

    const emptyBytes = await bindQualifiedProposalPdf({
      mutate: async () =>
        ({ fileName: 'Quote.pdf', pdfBase64: '  ', centsReconciled: true }) as never,
      input: { selectedOfferIds: ['a'], sourceRevision: 1, mailboxTransportId: 't1' },
    });
    expect(emptyBytes.status).toBe('unavailable');

    const ok = await bindQualifiedProposalPdf({
      mutate: async () => ({
        fileName: 'Quote-authorised.pdf',
        pdfBase64: 'JVBERi0xLjQK',
        centsReconciled: true as const,
      }),
      input: { selectedOfferIds: ['a'], sourceRevision: 1, mailboxTransportId: 't1' },
    });
    expect(ok).toEqual({
      status: 'ok',
      pdf: {
        fileName: 'Quote-authorised.pdf',
        pdfBase64: 'JVBERi0xLjQK',
        centsReconciled: true,
      },
    });
  });

  it('does not invent a second PDF engine when qualifiedQuoteProposalPdf is absent', async () => {
    const result = await bindQualifiedProposalPdf({
      input: { selectedOfferIds: ['a'], sourceRevision: 1, mailboxTransportId: 't1' },
    });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/not invent a second PDF engine/i);
    }
  });
});
