import { describe, expect, it, vi } from 'vitest';
import {
  bindAnalyseSelection,
  bindQualifiedProposalPdf,
  bindRunStep,
  quoteWorkflowFromTrpc,
  QUOTE_WORKFLOW_BIND_TARGETS,
  STAFF_QUOTE_PILOT_MISSING,
} from '../lib/quote-workflow/backend-bind';
import {
  bindExecuteStaffQuote,
  bindQualifiedStaffProposalPdf,
  nativeRoomCodes,
  resolveNativeRoomCodes,
  sha256HexOfBytes,
} from '../lib/quote-workflow/staff-quote-bind';
import { emptyStaffQuoteHeader } from '../lib/quote-workflow/types';

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
      expect(result.reason).toMatch(/not available here/);
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
    const mutate = vi.fn(async () => ({ status: 'ok' as const, offers: [] }));
    const result = await bindRunStep({
      mutate,
      stepId: 'quote-stay',
      selectionEpoch: 1,
      inputRevision: 1,
      inputs: { stepKind: 'quote_stay', binding: { selectionEpoch: 1 }, groups: [] },
    });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/no room options/i);
    }
  });

  it('refuses a separate party execute even when a party mutate is present', async () => {
    const mutate = vi.fn(async () => ({
      status: 'ok' as const,
      offers: [],
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
      expect(result.reason).toMatch(/runs automatically with the quote/i);
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
      expect(pdf.reason).toMatch(/not connected to this pane yet/i);
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
      expect(minted.reason).toMatch(/not connected to this pane yet/i);
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

    const lunaReady = await bindAnalyseSelection({
      mutate: vi.fn(async () => ({
        status: 'ready' as const,
        intent: 'quote' as const,
        groups: [],
        secondaryAsks: [],
        alternatives: [],
        sourceRevision: 4,
        source: 'luna' as const,
        aiUnavailable: false,
        luna: {
          workflow: 'create_booking' as const,
          flags: ['extras' as const],
          groups: [],
          party: { kind: 'agency' as const, name: 'Acme Travel', reference: null },
          rateClaims: [],
          missing: [],
          evidence: [],
          tasks: [],
        },
      })),
      input: { storeId: 'store-1', entryId: '001', folderEntryId: 'folder-inbox', selectionEpoch: 1 },
    });
    expect(lunaReady.kind).toBe('ready');
    if (lunaReady.kind === 'ready') {
      expect(lunaReady.analysis.source).toBe('luna');
      expect(lunaReady.analysis.aiUnavailable).toBe(false);
      expect(lunaReady.analysis.luna?.workflow).toBe('create_booking');
      expect(lunaReady.analysis.luna?.party.name).toBe('Acme Travel');
    }

    const fallbackReady = await bindAnalyseSelection({
      mutate: vi.fn(async () => ({
        status: 'ready' as const,
        intent: 'quote' as const,
        groups: [],
        secondaryAsks: [],
        alternatives: [],
        sourceRevision: 4,
        source: 'regex_fallback' as const,
        fallbackReason: 'timeout' as const,
        aiUnavailable: true,
        luna: null,
      })),
      input: { storeId: 'store-1', entryId: '001', folderEntryId: 'folder-inbox', selectionEpoch: 1 },
    });
    expect(fallbackReady.kind).toBe('ready');
    if (fallbackReady.kind === 'ready') {
      expect(fallbackReady.analysis.source).toBe('regex_fallback');
      expect(fallbackReady.analysis.fallbackReason).toBe('timeout');
      expect(fallbackReady.analysis.aiUnavailable).toBe(true);
      expect(fallbackReady.analysis.luna).toBeNull();
    }

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
      expect(result.reason).toMatch(/not connected to this pane yet/i);
    }
  });
});

describe('staff quote execute/PDF header bind', () => {
  const source = {
    messageId: 'mail-1',
    threadId: 'thread-1',
    sourceHash: 'ab'.repeat(32),
  };
  const stay = {
    id: 'g1',
    arrivalDate: '2026-11-12',
    departureDate: '2026-11-14',
    quantity: 1,
    adults: 1,
    childrenAges: [] as number[],
    board: 'bb' as const,
    specialRequests: [] as string[],
    fields: {},
  };
  const government = {
    salesStrategy: 'Government' as const,
    company: 'Provincial Treasury',
    agency: 'Travel Desk',
    attention: 'Ms. Naidoo',
    clientEmail: 'quotes@example.invalid',
    clientTelephone: '0110000000',
  };
  const readyResult = {
    status: 'ready' as const,
    workflowRunId: 'run-1',
    revisionRef: 'rev-1',
    messageId: source.messageId,
    threadId: source.threadId,
    factRefs: [],
    selectionEpoch: 1,
    inputRevision: 1,
    inputDigest: 'digest',
    totalMinor: 850000,
    currency: 'ZAR',
    arrivalDate: '2026-11-12',
    departureDate: '2026-11-14',
    description: 'STWN NGOVDB',
  };

  it('sends staff-approved Government/contact and the actual native room-code set', async () => {
    expect(nativeRoomCodes('SUITE')).toEqual(['SUITE']);
    expect(nativeRoomCodes('DLXKNG')).toEqual(['DLXKNG']);
    expect(nativeRoomCodes('SINGLE')).toBeUndefined();
    expect(resolveNativeRoomCodes({ roomPreference: 'SINGLE' })).toEqual({
      status: 'unresolved',
      label: 'SINGLE',
    });
    const mutate = vi.fn(async (_input: unknown) => readyResult);
    const labelled = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'SINGLE' }],
      header: government,
    });
    expect(labelled.status).toBe('unavailable');
    if (labelled.status === 'unavailable') {
      expect(labelled.reason).toMatch(/Room type "SINGLE" is not one HMS knows/);
      expect(labelled.reason).toMatch(/DLXTWN/);
    }
    expect(mutate).not.toHaveBeenCalled();
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STWN' }],
      header: government,
    });
    expect(result.status).toBe('ok');
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      salesStrategy: 'Government',
      company: 'Provincial Treasury',
      agency: 'Travel Desk',
      attention: 'Ms. Naidoo',
      clientEmail: 'quotes@example.invalid',
      clientTelephone: '0110000000',
      groups: [expect.objectContaining({ roomCodes: ['STWN'] })],
    });
  });

  it('sends staff-confirmed dinner and shuttle extras on executeStaffQuote', async () => {
    const mutate = vi.fn(async () => readyResult);
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STWN' }],
      header: {
        ...government,
        dinnerAllowanceMinor: 12_500,
        shuttleRequested: true,
        shuttleMinor: 45_000,
      },
    });
    expect(result.status).toBe('ok');
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      dinnerAllowanceMinor: 12_500,
      shuttleRequested: true,
      shuttleMinor: 45_000,
    });
  });

  it('rejects one executeStaffQuote run that mixes date sets, before any HMS call', async () => {
    const mutate = vi.fn(async () => readyResult);
    const mixed = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [
        { ...stay, roomPreference: 'SKNG' },
        { ...stay, id: 'g2', arrivalDate: '2026-12-01', departureDate: '2026-12-03', roomPreference: 'SKNG' },
      ],
      header: emptyStaffQuoteHeader(),
    });
    expect(mixed).toEqual({
      status: 'unavailable',
      reason: 'Distinct stays need separate executeStaffQuote calls.',
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rejects a zero total and requires PDF hash to match actual bytes', async () => {
    const mutateQuote = vi.fn(async () => ({ ...readyResult, totalMinor: 0 }));
    const zero = await bindExecuteStaffQuote({
      mutate: mutateQuote,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'SKNG' }],
      header: emptyStaffQuoteHeader(),
    });
    expect(zero.status).toBe('unavailable');
    const pdfBase64 = 'JVBERi0xLjQK';
    const bytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
    const pdfHash = await sha256HexOfBytes(bytes);
    expect(pdfHash).toMatch(/^[a-f0-9]{64}$/);
    const mutate = vi.fn(async () => ({
      revisionId: 'rev-1',
      pdfHash: pdfHash!,
      fileName: 'Quote.pdf',
      pdfBase64,
      totalMinor: 850000,
    }));
    const pdf = await bindQualifiedStaffProposalPdf({
      mutate,
      input: {
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        messageId: 'mail-1',
        outlookEmail: 'centurion@legacyhotels.co.za',
        factRefs: [],
        company: 'Provincial Treasury',
        agency: '',
        attention: '',
        clientEmail: '',
        clientTelephone: '',
      },
      expectedTotalMinor: 850000,
    });
    expect(pdf.status).toBe('ok');
    const mismatched = await bindQualifiedStaffProposalPdf({
      mutate: vi.fn(async () => ({
        revisionId: 'rev-1',
        pdfHash: 'ab'.repeat(32),
        fileName: 'Quote.pdf',
        pdfBase64,
        totalMinor: 850000,
      })),
      input: {
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        messageId: 'mail-1',
        outlookEmail: 'centurion@legacyhotels.co.za',
        factRefs: [],
        company: 'Provincial Treasury',
        agency: '',
        attention: '',
        clientEmail: '',
        clientTelephone: '',
      },
      expectedTotalMinor: 850000,
    });
    expect(mismatched.status).toBe('unavailable');
    const missingAgency = await bindQualifiedStaffProposalPdf({
      mutate,
      input: {
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        messageId: 'mail-1',
        outlookEmail: 'centurion@legacyhotels.co.za',
        factRefs: [],
        company: 'Provincial Treasury',
        attention: '',
        clientEmail: '',
        clientTelephone: '',
      } as never,
      expectedTotalMinor: 850000,
    });
    expect(missingAgency.status).toBe('unavailable');
  });
});
