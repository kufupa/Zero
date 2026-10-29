import { describe, expect, it, vi } from 'vitest';
import {
  bindAnalyseSelection,
  bindQualifiedProposalPdf,
  bindRunStep,
  bindStoredWork,
  quoteWorkflowFromTrpc,
  QUOTE_WORKFLOW_BIND_TARGETS,
  STAFF_QUOTE_PILOT_MISSING,
  type StoredWork,
} from '../lib/quote-workflow/backend-bind';
import {
  approvedExecuteHeader,
  bindExecuteStaffQuote as bindPropertyScopedStaffQuote,
  bindQualifiedStaffProposalPdf,
  nativeRoomCodes,
  resolveNativeRoomCodes,
  staffQuoteGroupsFromStay,
  sha256HexOfBytes,
} from '../lib/quote-workflow/staff-quote-bind';
import { emptyStaffQuoteHeader, HRCEN_PROPERTY_CODE, HRDAV_PROPERTY_CODE } from '../lib/quote-workflow/types';

// Pin the default Centurion fixtures; the legacy property test supplies HRDAV explicitly.
function bindExecuteStaffQuote(args: Parameters<typeof bindPropertyScopedStaffQuote>[0]) {
  return bindPropertyScopedStaffQuote({ ...args, propertyCode: HRCEN_PROPERTY_CODE });
}

describe('quote workflow backend bind', () => {
  it('names the published staff-quote procedures rather than a second engine', () => {
    expect(QUOTE_WORKFLOW_BIND_TARGETS.analyseSelection).toBe('quoteWorkflow.analyseSelection');
    expect(QUOTE_WORKFLOW_BIND_TARGETS.staffQuoteSource).toBe('workstation.staffQuoteSource');
    expect(QUOTE_WORKFLOW_BIND_TARGETS.executeStaffQuote).toBe('workstation.executeStaffQuote');
    expect(QUOTE_WORKFLOW_BIND_TARGETS.qualifiedPdf).toBe('workstation.qualifiedQuoteProposalPdf');
    expect(QUOTE_WORKFLOW_BIND_TARGETS.rateCatalogue).toBe('quoteWorkflow.rateCatalogue');
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
    const query = vi.fn(async () => []);
    expect(
      quoteWorkflowFromTrpc({ quoteWorkflow: { rateCatalogue: { query } } }).rateCatalogue?.query,
    ).toBe(query);
  });

  it('does not open a work item for stored existing-stay information', async () => {
    const stored = {
      status: 'ready' as const,
      kind: 'other',
      existingStayInformation: true,
      confirmationNumbers: ['57291630-1'],
      workItemId: null,
      workItemStatus: null,
      extractionId: 'ex-existing-stay',
      refs: {},
      analysis: {} as never,
      contact: {} as never,
      language: null,
      translation: null,
    };
    const query = { query: vi.fn(async () => stored) };
    const open = { mutate: vi.fn() };

    const result = await bindStoredWork({
      query: query as unknown as Parameters<typeof bindStoredWork>[0]['query'],
      open: open as unknown as Parameters<typeof bindStoredWork>[0]['open'],
      internetMessageId: '<existing-stay@example.invalid>',
      transportId: 'transport-existing-stay',
    });

    expect(result).toBe(stored);
    expect(open.mutate).not.toHaveBeenCalled();
  });

  it('keeps a detected reclassification conflict without opening another item', async () => {
    const sourceConflict = {
      reason: 'workflow_reclassified' as const,
      previousItems: [{ workItemId: 'old', kind: 'quote', status: 'needs_you' }],
    };
    const stored = {
      status: 'ready' as const, kind: 'booking', workItemId: null, workItemStatus: null,
      extractionId: 'ex-new', refs: {}, sourceConflict,
      analysis: { intent: 'other' as const, groups: [], secondaryAsks: [], alternatives: [], caseActionsUncertain: true },
      contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null,
    };
    const open = { mutate: vi.fn() };
    expect(await bindStoredWork({
      query: { query: async () => stored }, open, internetMessageId: 'mail',
    })).toEqual(stored);
    expect(open.mutate).not.toHaveBeenCalled();
  });

  it('retains a conflict discovered during open even when no new item was created', async () => {
    const stored = {
      status: 'ready' as const, kind: 'booking', workItemId: null, workItemStatus: null,
      extractionId: 'ex-new', refs: {},
      analysis: { intent: 'other' as const, groups: [], secondaryAsks: [], alternatives: [] },
      contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null,
    };
    const conflict = { ...stored, analysis: { ...stored.analysis, caseActionsUncertain: true },
      sourceConflict: { reason: 'workflow_reclassified' as const,
        previousItems: [{ workItemId: 'old', kind: 'quote', status: 'needs_you' }] } };
    const open = { mutate: vi.fn(async () => conflict) };
    expect(await bindStoredWork({
      query: { query: async () => stored }, open, internetMessageId: 'mail',
    })).toEqual(conflict);
    expect(open.mutate).toHaveBeenCalledTimes(1);
  });

  it('keeps a source hold discovered while opening a previously valid read', async () => {
    const stored = {
      status: 'ready' as const, kind: 'quote', workItemId: null, workItemStatus: null,
      extractionId: 'ex-old', refs: {},
      analysis: { intent: 'quote' as const, groups: [], secondaryAsks: [], alternatives: [] },
      contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null,
    };
    const held = { status: 'failed' as const, reason: 'Review this request manually.', hold: true as const };
    expect(await bindStoredWork({ query: { query: async () => stored }, open: { mutate: async () => held },
      internetMessageId: 'mail' })).toEqual(held);
  });

  it('holds a previously found email that disappears while opening its work item', async () => {
    const stored = {
      status: 'ready' as const, kind: 'quote', workItemId: null, workItemStatus: null,
      extractionId: 'ex-old', refs: {},
      analysis: { intent: 'quote' as const, groups: [], secondaryAsks: [], alternatives: [] },
      contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null,
    };
    const held = { status: 'failed', hold: true, reason: expect.stringContaining('no longer available') };
    expect(await bindStoredWork({ query: { query: async () => stored }, open: { mutate: async () => ({ status: 'none' }) },
      internetMessageId: 'mail' })).toEqual(held);
    expect(await bindStoredWork({ query: { query: async () => ({ status: 'none' }) },
      open: { mutate: async () => ({ status: 'none' }) }, internetMessageId: 'mail' })).toEqual({ status: 'none' });
  });

  it('holds an explicit failed open after a previously successful stored read', async () => {
    const stored = {
      status: 'ready' as const, kind: 'quote', workItemId: null, workItemStatus: null,
      extractionId: 'ex-old', refs: {},
      analysis: { intent: 'quote' as const, groups: [], secondaryAsks: [], alternatives: [] },
      contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null,
    };
    expect(await bindStoredWork({ query: { query: async () => stored },
      open: { mutate: async () => ({ status: 'failed', reason: 'Read failed.' }) }, internetMessageId: 'mail' }))
      .toEqual({ status: 'failed', reason: 'Read failed.', hold: true });
  });

  it('reports a late disappearance after showing a slow stored read', async () => {
    vi.useFakeTimers();
    try {
      const stored = {
        status: 'ready' as const, kind: 'quote', workItemId: null, workItemStatus: null,
        extractionId: 'ex-old', refs: {},
        analysis: { intent: 'quote' as const, groups: [], secondaryAsks: [], alternatives: [] },
        contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null,
      };
      let finish!: (value: { status: 'none' }) => void;
      const onLateHold = vi.fn();
      const result = bindStoredWork({ query: { query: async () => stored },
        open: { mutate: () => new Promise((resolve) => { finish = resolve; }) },
        internetMessageId: 'mail', openTimeoutMs: 10, onLateHold });
      await vi.advanceTimersByTimeAsync(10);
      expect(await result).toEqual(stored);
      finish({ status: 'none' });
      await vi.waitFor(() => expect(onLateHold).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', hold: true })));
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a newer open result even when it has no work item', async () => {
    const stored = {
      status: 'ready' as const, kind: 'quote', workItemId: null, workItemStatus: null,
      extractionId: 'ex-old', refs: {},
      analysis: { intent: 'quote' as const, groups: [], secondaryAsks: [], alternatives: [] },
      contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null,
    };
    const opened = { ...stored, kind: 'other', extractionId: 'ex-new', existingStayInformation: true };
    expect(await bindStoredWork({ query: { query: async () => stored }, open: { mutate: async () => opened },
      internetMessageId: 'mail' })).toEqual(opened);
  });

  it('holds a late open that finds a changed extraction', async () => {
    vi.useFakeTimers();
    try {
      const stored = {
        status: 'ready' as const, kind: 'quote', workItemId: null, workItemStatus: null,
        extractionId: 'ex-old', refs: {},
        analysis: { intent: 'quote' as const, groups: [], secondaryAsks: [], alternatives: [] },
        contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null,
      };
      let finish!: (value: typeof stored) => void;
      const onLateHold = vi.fn();
      const result = bindStoredWork({ query: { query: async () => stored },
        open: { mutate: () => new Promise((resolve) => { finish = resolve; }) },
        internetMessageId: 'mail', openTimeoutMs: 10, onLateHold });
      await vi.advanceTimersByTimeAsync(10);
      expect(await result).toEqual(stored);
      finish({ ...stored, extractionId: 'ex-new' });
      await vi.waitFor(() => expect(onLateHold).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', hold: true })));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['payload', 'contact', 'saved-edit'] as const)('holds a late open after a same-ID %s change', async (change) => {
    vi.useFakeTimers();
    try {
      const analysis = { intent: 'quote' as const, groups: [], secondaryAsks: [], alternatives: [] };
      const stored = {
        status: 'ready' as const, kind: 'quote', workItemId: null, workItemStatus: null,
        extractionId: 'ex-old', refs: {}, analysis,
        sourceRead: { extractionId: 'ex-old', kind: 'quote', payloadDigest: 'before', analysis, refs: {} },
        contact: { name: null as string | null, company: null, endClient: null, email: null, phone: null },
        language: null, translation: null,
      };
      let finish!: (value: typeof stored & { revisionSeq?: number }) => void;
      const onLateHold = vi.fn();
      const result = bindStoredWork({ query: { query: async () => stored },
        open: { mutate: () => new Promise((resolve) => { finish = resolve; }) },
        internetMessageId: 'mail', openTimeoutMs: 10, onLateHold });
      await vi.advanceTimersByTimeAsync(10);
      expect(await result).toEqual(stored);
      const opened = change === 'payload' ? { ...stored, sourceRead: { ...stored.sourceRead, payloadDigest: 'after' } }
        : change === 'contact' ? { ...stored, contact: { ...stored.contact, name: 'Changed' } }
        : { ...stored, revisionSeq: 1 };
      finish(opened);
      await vi.waitFor(() => expect(onLateHold).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', hold: true })));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['closed', 'information', 'missing-digest'] as const)('holds a late %s result', async (change) => {
    vi.useFakeTimers();
    try {
      const analysis = { intent: 'quote' as const, groups: [], secondaryAsks: [], alternatives: [] };
      const sourceRead = { extractionId: 'ex-old', kind: 'quote', payloadDigest: 'digest', analysis, refs: {} };
      const stored = {
        status: 'ready' as const, kind: 'quote', workItemId: null, workItemStatus: null,
        extractionId: 'ex-old', refs: {}, analysis,
        sourceRead: change === 'missing-digest' ? { ...sourceRead, payloadDigest: undefined } : sourceRead,
        contact: { name: null, company: null, endClient: null, email: null, phone: null },
        language: null, translation: null,
      };
      let finish!: (value: StoredWork) => void;
      const onLateHold = vi.fn();
      const result = bindStoredWork({ query: { query: async () => stored },
        open: { mutate: () => new Promise((resolve) => { finish = resolve; }) },
        internetMessageId: 'mail', transportId: 'transport-centurion', openTimeoutMs: 10, onLateHold });
      await vi.advanceTimersByTimeAsync(10);
      expect(await result).toEqual(stored);
      finish(change === 'closed' ? { ...stored, workItemId: 'wi', workItemStatus: 'done' }
        : change === 'information' ? { ...stored, existingStayInformation: true } : stored);
      await vi.waitFor(() => expect(onLateHold).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', hold: true })));
    } finally {
      vi.useRealTimers();
    }
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
    childrenPerRoom: 0,
    childrenAges: [] as number[],
    board: 'bb' as const,
    specialRequests: [] as string[],
    fields: {},
  };
  const barHeader = {
    salesStrategy: 'BAR' as const,
    company: 'Provincial Treasury',
    agency: 'Travel Desk',
    attention: 'Ms. Naidoo',
    clientEmail: 'quotes@example.invalid',
    clientTelephone: '0110000000',
  };
  const readyResult = {
    status: 'ready' as const,
    propertyCode: HRCEN_PROPERTY_CODE,
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

  it('holds a Centurion quote when the child count is unknown', async () => {
    const mutate = vi.fn();
    const result = await bindExecuteStaffQuote({
      mutate, source, selectionEpoch: 1, inputRevision: 1,
      groups: [{ ...stay, childrenPerRoom: null, roomPreference: 'STWN' }], header: barHeader,
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/Confirm the number of children/) });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('holds an unverified Centurion Government quote before calling HMS', async () => {
    const mutate = vi.fn();
    const result = await bindExecuteStaffQuote({
      mutate, source, selectionEpoch: 1, inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STWN' }],
      header: { ...barHeader, salesStrategy: 'Government' },
    });
    expect(result).toMatchObject({
      status: 'unavailable', reason: expect.stringMatching(/Government rates need confirmed guest eligibility/),
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('still forwards a Government quote in the legacy HRDAV context', async () => {
    const mutate = vi.fn(async (_input: unknown) => ({ ...readyResult, propertyCode: HRDAV_PROPERTY_CODE }));
    const result = await bindPropertyScopedStaffQuote({
      propertyCode: HRDAV_PROPERTY_CODE, mutate, source, selectionEpoch: 1, inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STKNG' }],
      header: { ...barHeader, salesStrategy: 'Government' },
    });
    expect(result.status).toBe('ok');
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ salesStrategy: 'Government' }));
  });

  it('sends the staff-approved rate, contact and actual native room-code set', async () => {
    expect(nativeRoomCodes('SUITE')).toEqual(['SUITE']);
    expect(nativeRoomCodes('DLXKNG')).toEqual(['DLXKNG']);
    expect(resolveNativeRoomCodes({ roomPreference: 'Standard Queen' })).toEqual({
      status: 'codes',
      codes: ['STQN'],
    });
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
      header: barHeader,
    });
    expect(labelled.status).toBe('unavailable');
    if (labelled.status === 'unavailable') {
      expect(labelled.reason).toMatch(/Not in this hotel's room list/);
      expect(labelled.reason).toMatch(/DLXTWN/);
    }
    expect(mutate).not.toHaveBeenCalled();
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STWN' }],
      header: barHeader,
    });
    expect(result.status).toBe('ok');
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      salesStrategy: 'BAR',
      company: 'Provincial Treasury',
      agency: 'Travel Desk',
      attention: 'Ms. Naidoo',
      clientEmail: 'quotes@example.invalid',
      clientTelephone: '0110000000',
      groups: [expect.objectContaining({ roomCodes: ['STWN'] })],
    });
  });

  it('sends staff-confirmed dinner and shuttle extras on executeStaffQuote', async () => {
    const mutate = vi.fn(async (_input: unknown) => readyResult);
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STWN' }],
      header: {
        ...barHeader,
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

  it('keeps a thrown search error staff-readable and returns the raw diagnostic separately', async () => {
    const raw = "Cannot read properties of undefined (reading 'internetMessageId')";
    const mutate = vi.fn(async () => {
      throw new Error(raw);
    });
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STWN' }],
      header: barHeader,
    });
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: "HMS didn't answer in time.",
      detail: raw,
    });
    expect(result.status === 'unavailable' && result.reason).not.toContain('internetMessageId');
  });

  it('labels a native refusal without exposing the complete exception inline', async () => {
    const raw = 'HMS refused the search: invalid rate plan GOV/INTERNAL-TRACE-123';
    const mutate = vi.fn(async () => {
      throw new Error(raw);
    });
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STWN' }],
      header: barHeader,
    });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toMatch(/^HMS refused the search: /);
    expect(result.reason).not.toContain('INTERNAL-TRACE-123');
    expect(result.detail).toBe(raw);
  });

  it('shows an unrecognized HMS refusal as the server message and keeps its detail', async () => {
    const raw =
      'HMS has no rate for every night of this stay in this room and meal plan. Try another room type or meal plan, or split the dates, then search again.';
    const refusal = Object.assign(new Error(raw), { data: { code: 'PRECONDITION_FAILED' } });
    const result = await bindExecuteStaffQuote({
      mutate: vi.fn(async () => {
        throw refusal;
      }),
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STWN' }],
      header: barHeader,
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: raw, detail: raw });
  });

  it('sends each new extra and the note as its own field, and leaves out empty ones', () => {
    expect(
      approvedExecuteHeader({
        ...barHeader,
        lunchAllowanceMinor: 20_000,
        lunchAllowanceLabel: ' with 1 soft drink ',
        officeTransferMinor: 20_000,
        officeTransferDays: 0,
        shuttleRequested: true,
        shuttleTrips: 2,
        other: { label: ' Parking ', amountMinor: 30_000, unit: 'item' },
        notes: '  Breakfast only on day 2.  ',
      }),
    ).toMatchObject({
      lunchAllowanceMinor: 20_000,
      lunchAllowanceLabel: 'with 1 soft drink',
      officeTransferMinor: 20_000,
      shuttleRequested: true,
      shuttleTrips: 2,
      other: { label: 'Parking', amountMinor: 30_000, unit: 'item' },
      notes: 'Breakfast only on day 2.',
    });
    const bare = approvedExecuteHeader({
      ...barHeader,
      other: { label: 'Parking', unit: 'item' },
      notes: '   ',
    });
    expect(bare).not.toHaveProperty('other');
    expect(bare).not.toHaveProperty('notes');
    expect(bare).not.toHaveProperty('officeTransferDays');
  });

  it('sends an other amount with no label, so the server can raise a review item for it', () => {
    expect(
      approvedExecuteHeader({ ...barHeader, other: { label: '  ', amountMinor: 30_000, unit: 'item' } }),
    ).toMatchObject({ other: { label: '', amountMinor: 30_000, unit: 'item' } });
  });

  it('does not run the quote while an amount is unreadable', async () => {
    const mutate = vi.fn(async () => readyResult);
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STWN' }],
      header: {
        ...barHeader,
        dinnerAllowanceMinor: 45_000,
        fieldErrors: { dinnerAllowance: 'Enter an amount in rand, like 450 or 1,250.50' },
      },
    });
    expect(result).toEqual({
      status: 'unavailable',
      reason:
        'Fix the amounts before running this search. Dinner allowance: Enter an amount in rand, like 450 or 1,250.50',
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('sends the group ids the dinner allowance belongs to, so the server charges only those guests', async () => {
    const mutate = vi.fn(async (_input: unknown) => readyResult);
    await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, roomPreference: 'STWN' }],
      header: { ...barHeader, dinnerAllowanceMinor: 12_500, dinnerAllowanceGroupIds: ['g1'] },
    });
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      dinnerAllowanceMinor: 12_500,
      dinnerAllowanceGroupIds: ['g1'],
    });
  });

  it('sends each date option only its own dinner groups, within the server cap of 8 ids', async () => {
    const optionA = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const optionB = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const optionC = ['c1'];
    const groupsFor = (ids: string[], arrivalDate: string, departureDate: string) =>
      ids.map((id) => ({ ...stay, id, arrivalDate, departureDate, roomPreference: 'STWN' as const }));
    const header = {
      ...barHeader,
      dinnerAllowanceMinor: 12_500,
      dinnerAllowanceGroupIds: [...optionA, ...optionB, 'a1'],
    };
    const mutate = vi.fn(async (_input: unknown) => readyResult);
    const runs = [
      groupsFor(optionA, '2026-11-12', '2026-11-14'),
      groupsFor(optionB, '2026-11-20', '2026-11-22'),
      groupsFor(optionC, '2026-11-28', '2026-11-30'),
    ];
    for (const groups of runs) {
      const result = await bindExecuteStaffQuote({
        mutate,
        source,
        selectionEpoch: 1,
        inputRevision: 1,
        groups,
        header,
      });
      expect(result.status).toBe('ok');
    }
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ dinnerAllowanceGroupIds: optionA });
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({ dinnerAllowanceGroupIds: optionB });
    // Option C took no B&B fallback. An empty list charges nothing; an omitted list would charge every group.
    expect(mutate.mock.calls[2]?.[0]).toMatchObject({
      dinnerAllowanceMinor: 12_500,
      dinnerAllowanceGroupIds: [],
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
      reason: 'Each date range needs its own quote. Run them one at a time.',
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('sends a mixed room-type stay as one executeStaffQuote run, with each type on its own group', async () => {
    const sent: unknown[] = [];
    const mutate = vi.fn(async (input: unknown) => {
      sent.push(input);
      return readyResult;
    });
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [
        { ...stay, id: 'g1', quantity: 20, roomPreference: 'STQN' },
        { ...stay, id: 'g2', quantity: 10, roomPreference: 'STWN' },
      ],
      header: emptyStaffQuoteHeader(),
    });
    expect(result.status).toBe('ok');
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(sent[0]).toMatchObject({
      groups: [
        expect.objectContaining({ id: 'g1', roomCodes: ['STQN'], quantity: 20 }),
        expect.objectContaining({ id: 'g2', roomCodes: ['STWN'], quantity: 10 }),
      ],
    });
  });

  it('uses the Q-S room type match when an empty room-code list was projected', async () => {
    const sent: unknown[] = [];
    const mutate = vi.fn(async (input: unknown) => {
      sent.push(input);
      return readyResult;
    });
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{
        ...stay,
        roomPreference: 'Standard Queen',
        roomTypeCode: 'STQN',
        roomCodes: [],
      }],
      header: emptyStaffQuoteHeader(),
    });
    expect(result.status).toBe('ok');
    expect(sent[0]).toMatchObject({ groups: [{ roomCodes: ['STQN'] }] });
  });

  it('sends the room a rate-card pick chose, not the projected room type', async () => {
    const sent: unknown[] = [];
    const mutate = vi.fn(async (input: unknown) => {
      sent.push(input);
      return readyResult;
    });
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{
        ...stay,
        roomPreference: 'Standard Queen',
        roomTypeCode: 'STQN',
        roomCodes: ['SKNG'],
      }],
      header: emptyStaffQuoteHeader(),
    });
    expect(result.status).toBe('ok');
    expect(sent[0]).toMatchObject({ groups: [{ roomCodes: ['SKNG'] }] });
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
        notes: 'Breakfast only on day two.',
      },
      expectedTotalMinor: 850000,
    });
    expect(pdf.status).toBe('ok');
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ notes: 'Breakfast only on day two.' }));
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
  it('gives plain re-quote copy when the PDF run is no longer recorded or its evidence expired', async () => {
    const input = {
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
    };
    const serverMessages = ['Proposal source not found', 'Proposal evidence expired during conversion'];
    for (const message of serverMessages) {
      const result = await bindQualifiedStaffProposalPdf({
        mutate: async () => {
          throw new Error(message);
        },
        input,
        expectedTotalMinor: 850000,
      });
      expect(result).toEqual({
        status: 'unavailable',
        reason: 'This quote has expired. Run the quote again.',
      });
    }
  });
  it('keeps other PDF failure messages as the server sent them', async () => {
    const result = await bindQualifiedStaffProposalPdf({
      mutate: async () => {
        throw new Error('GOTENBERG_URL missing');
      },
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
    expect(result).toEqual({ status: 'unavailable', reason: 'GOTENBERG_URL missing' });
  });

  it('lets a defaulted unresolved room preference quote any type', () => {
    const result = staffQuoteGroupsFromStay([{
      id: 'g1',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      quantity: 1,
      roomPreference: 'double',
      adults: 2,
      childrenPerRoom: 0,
      childrenAges: [],
      board: 'bb',
      specialRequests: [],
      fields: { roomPreference: 'defaulted' },
    }]);

    expect(result).toEqual({
      ok: [{
        id: 'g1',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 1,
        adults: 2,
        childrenPerRoom: 0,
        childrenAges: [],
        board: 'bb',
      }],
    });
  });

  it('prices an unpicked twin request as Standard Twin', () => {
    const result = staffQuoteGroupsFromStay([{
      id: 'g1',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      quantity: 1,
      roomPreference: 'Twin',
      adults: 2,
      childrenPerRoom: 0,
      childrenAges: [],
      board: 'bb',
      specialRequests: [],
      fields: { roomPreference: 'defaulted' },
    }]);

    expect(result).toEqual({
      ok: [{
        id: 'g1',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 1,
        adults: 2,
        childrenPerRoom: 0,
        childrenAges: [],
        board: 'bb',
        roomCodes: ['STWN'],
      }],
    });
  });
});

describe('staff quote no-matching-rate flag', () => {
  const source = { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) };
  const stay = {
    id: 'g1',
    arrivalDate: '2026-11-12',
    departureDate: '2026-11-14',
    quantity: 1,
    adults: 1,
    childrenPerRoom: 0,
    childrenAges: [] as number[],
    board: 'dinner_bb' as const,
    specialRequests: [] as string[],
    fields: {},
  };
  const header = {
    salesStrategy: 'BAR' as const,
    company: '',
    agency: '',
    attention: '',
    clientEmail: '',
    clientTelephone: '',
  };

  it('flags only the clean HMS no-match, so the pane can offer the B&B fallback', async () => {
    const noMatch = await bindExecuteStaffQuote({
      mutate: vi.fn(async () => {
        throw new Error(
          'HMS has no rate for this meal plan under BAR. For dinner, quote Bed & Breakfast and add a dinner allowance (button below), or use the Government rate if the guest is entitled.',
        );
      }),
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay],
      header,
    });
    expect(noMatch).toMatchObject({
      status: 'unavailable',
      reason: 'HMS refused the search: No rate matches this meal plan under the selected rate plan.',
      detail: 'HMS has no rate for this meal plan under BAR. For dinner, quote Bed & Breakfast and add a dinner allowance (button below), or use the Government rate if the guest is entitled.',
      noMatchingRate: true,
    });

    const otherFailure = await bindExecuteStaffQuote({
      mutate: vi.fn(async () => {
        throw new Error("HMS didn't respond as expected.");
      }),
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay],
      header,
    });
    expect(otherFailure.status).toBe('unavailable');
    expect(otherFailure).not.toHaveProperty('noMatchingRate', true);
  });

  it('shows a staff-readable short-supply refusal, keeping raw detail separate', async () => {
    const short = await bindExecuteStaffQuote({
      mutate: vi.fn(async () => {
        throw new Error('Only 34 Standard Queen free on 26 Oct — quote fewer or split');
      }),
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay],
      header,
    });
    expect(short).toMatchObject({
      status: 'unavailable',
      reason: 'HMS refused the search: Only 34 Standard Queen free on 26 Oct — quote fewer or split',
      detail: 'Only 34 Standard Queen free on 26 Oct — quote fewer or split',
    });
    expect(short).not.toHaveProperty('noMatchingRate', true);
  });
});

describe('bindAnalyseSelection no-reply sender', () => {
  it('carries the sender flag onto the analysis for the pane', async () => {
    const mutate = vi.fn(async () => ({
      status: 'ready' as const,
      intent: 'other' as const,
      groups: [],
      secondaryAsks: [],
      alternatives: [],
      sourceRevision: 3,
      noReplySender: true,
    }));
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
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') expect(result.analysis.noReplySender).toBe(true);
  });
});
