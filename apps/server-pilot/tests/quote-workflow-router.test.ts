import { quoteWorkflowLoaders } from '../src/trpc/routes/quote-workflow.js';
import { analyseQuoteSources } from '../src/ai/quote-workflow-analyse.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';

const enqueueHmsRead = vi.fn();

function mailboxCaller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: {
      id: 'user-ropperman',
      email: 'ropperman@legacyhotels.co.za',
      name: 'R Opperman',
    },
    activeTransportId: 'transport-1',
    transportEmail: 'centurion@legacyhotels.co.za',
    accessRole: 'owner',
  } as never);
}

const quoteGroup = {
  arrival: '2026-11-12',
  departure: '2026-11-14',
  rooms: 1,
  adultsPerRoom: 2,
  childAges: [] as number[],
  board: 'bb' as const,
  roomPreference: null,
  guestNames: [] as string[],
};

function lunaOutput(overrides: Record<string, unknown> = {}) {
  return {
    workflow: 'quote',
    flags: [] as string[],
    groups: [quoteGroup],
    party: { kind: null, name: null, reference: null },
    rateClaims: [] as unknown[],
    missing: [] as unknown[],
    evidence: [{ field: 'arrival', quote: '2026-11-12' }],
    tasks: [{ kind: 'quote' as const, groupIndexes: [0], note: 'quote stay' }],
    ...overrides,
  };
}

describe('analyseQuoteSources', () => {
  it('does not treat attachment filenames as document bytes', () => {
    const analysis = analyseQuoteSources({
      subject: 'Availability',
      bodyText: 'Please quote rooms.',
      attachments: [
        {
          id: 'att-1',
          filename: 'rooming-list-2026-09-15.pdf',
          bytesPresent: false,
        },
      ],
    });
    expect(analysis.groups[0]?.arrivalDate).toBeUndefined();
    expect(analysis.attachmentAdmissions[0]?.admittedText).toBe(false);
  });

  it('does not invent a quoting workflow for a thanks note', () => {
    expect(
      analyseQuoteSources({
        subject: 'Thanks',
        bodyText: 'Thank you for your help yesterday.',
      }).intent,
    ).toBe('other');
  });
});

describe('quoteWorkflow.analyseSelection', () => {
  afterEach(() => {
    quoteWorkflowLoaders.loadSyncedSelection = null;
    quoteWorkflowLoaders.adapter = null;
    quoteWorkflowLoaders.llmEnabled = null;
    enqueueHmsRead.mockReset();
  });

  it('returns unsynced from the default mailbox loader when no internetMessageId is provided', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = null;
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 1,
    });
    expect(result).toEqual({ status: 'unsynced' });
    expect(enqueueHmsRead).not.toHaveBeenCalled();
  });

  it('returns unsynced when the authorised mailbox has no matching message', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => null;
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 3,
    });
    expect(result).toEqual({ status: 'unsynced' });
    expect(enqueueHmsRead).not.toHaveBeenCalled();
  });

  it('still analyses when an attachment is unreadable and lists it as a document_failure', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Quote request',
      bodyText: 'Please send availability for two rooms.',
      preceding: [],
      attachments: [
        {
          id: 'att-rooming-list',
          filename: 'rooming-list.pdf',
          bytesPresent: false,
          readFailure: 'encrypted',
        },
      ],
    });
    quoteWorkflowLoaders.llmEnabled = () => false;
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<a@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 1,
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.source).toBe('regex_fallback');
      expect(result.fallbackReason).toBe('disabled');
      expect(result.aiUnavailable).toBe(true);
      expect(result.luna).toBeNull();
      expect(result.reviewItems?.some((item) => item.kind === 'document_failure')).toBe(true);
    }
  });

  it('merges attachment_unread and never returns missing_source for a non-PDF attachment', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.',
      preceding: [],
      attachments: [
        { id: 'sheet', filename: 'rooming.xlsx', bytesPresent: false, readFailure: 'not a PDF' },
      ],
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput(),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          estimatedCostUsd: 0,
          rateTableVersion: 't',
        },
      }),
    };
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<a@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 4,
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.source).toBe('luna');
      expect(result.luna?.flags).toContain('attachment_unread');
      expect(result.reviewItems?.some((item) => item.kind === 'document_failure')).toBe(true);
    }
  });

  it('returns the Luna analysis through the route with an injected adapter', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.',
      preceding: [],
      attachments: [],
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput(),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          estimatedCostUsd: 0,
          rateTableVersion: 't',
        },
      }),
    };
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<a@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 4,
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.source).toBe('luna');
      expect(result.aiUnavailable).toBe(false);
      expect(result.workflow).toBe('quote');
      expect(result.groups[0]).toMatchObject({ quantity: 1, adults: 2, board: 'bb' });
      expect(result.sourceRevision).toBe(4);
    }
  });

  it('maps create_booking to intent quote and keeps luna.workflow', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Book rooms',
      bodyText: 'Please confirm 1 room 12-14 Nov 2026, 2 adults, B&B.',
      preceding: [],
      attachments: [],
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput({
          workflow: 'create_booking',
          tasks: [{ kind: 'create_booking', groupIndexes: [0], note: 'book stay' }],
        }),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          estimatedCostUsd: 0,
          rateTableVersion: 't',
        },
      }),
    };
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<a@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 5,
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.intent).toBe('quote');
      expect(result.groups).toHaveLength(1);
      expect(result.luna?.workflow).toBe('create_booking');
    }
  });

  it('passes luna.tasks through and keeps both groups for multi_date', async () => {
    const tasks = [
      { kind: 'quote' as const, groupIndexes: [0], note: 'first date option' },
      { kind: 'quote' as const, groupIndexes: [1], note: 'second date option' },
    ];
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Two dates',
      bodyText: 'Quote 12-14 Nov or 1-3 Dec 2026, 2 adults, B&B.',
      preceding: [],
      attachments: [],
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput({
          flags: ['multi_date'],
          groups: [quoteGroup, { ...quoteGroup, arrival: '2026-12-01', departure: '2026-12-03' }],
          tasks,
        }),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          estimatedCostUsd: 0,
          rateTableVersion: 't',
        },
      }),
    };
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<a@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 6,
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.luna?.tasks).toEqual(tasks);
      expect(result.luna?.flags).toContain('multi_date');
      expect(result.groups).toHaveLength(2);
    }
  });

  it('falls back with invalid_output when Luna returns nine tasks', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.',
      preceding: [],
      attachments: [],
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput({
          tasks: Array.from({ length: 9 }, () => ({ kind: 'quote', groupIndexes: [0], note: 'x' })),
        }),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          estimatedCostUsd: 0,
          rateTableVersion: 't',
        },
      }),
    };
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<a@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 7,
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.source).toBe('regex_fallback');
      expect(result.fallbackReason).toBe('invalid_output');
      expect(result.aiUnavailable).toBe(true);
      expect(result.luna).toBeNull();
    }
  });

  it('does not call the adapter when the kill switch is off', async () => {
    const seen: unknown[] = [];
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.',
      preceding: [],
      attachments: [],
    });
    quoteWorkflowLoaders.llmEnabled = () => false;
    quoteWorkflowLoaders.adapter = {
      invoke: async (input) => {
        seen.push(input);
        throw new Error('should not be called');
      },
    };
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<a@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 8,
    });
    expect(seen).toHaveLength(0);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.fallbackReason).toBe('disabled');
    }
  });

  it('never serialises scanned PDF bytes on the ready payload', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 scanned');
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.',
      preceding: [],
      attachments: [{ id: 'scan', filename: 'scan.pdf', bytesPresent: true, pdf }],
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput(),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          estimatedCostUsd: 0,
          rateTableVersion: 't',
        },
      }),
    };
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<a@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 9,
    });
    expect(JSON.stringify(result)).not.toMatch(/%PDF-/);
    expect(JSON.parse(JSON.stringify(result)).pdf).toBeUndefined();
  });

  it('classifies non-quote mail without calling PMS', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Thanks',
      bodyText: 'Thank you for sorting parking yesterday.',
      preceding: [],
      attachments: [],
    });
    quoteWorkflowLoaders.llmEnabled = () => false;
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 1,
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.intent).toBe('other');
      expect(result.groups).toEqual([]);
    }
    expect(enqueueHmsRead).not.toHaveBeenCalled();
  });

  it('passes mailboxProcedure transportId into the loader', async () => {
    const seen: string[] = [];
    quoteWorkflowLoaders.loadSyncedSelection = async (input) => {
      seen.push(input.transportId);
      return null;
    };
    await mailboxCaller().quoteWorkflow.analyseSelection({
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 1,
    });
    expect(seen).toEqual(['transport-1']);
  });

  it('runStep reports integration unavailable and does not enqueue HMS', async () => {
    const result = await mailboxCaller().quoteWorkflow.runStep({
      stepId: 'quote-stay',
      selectionEpoch: 1,
      inputRevision: 2,
      inputs: { quoteRequestKey: '2026-11-12:2026-11-14', groupIds: ['g1'] },
    });
    expect(result.status).toBe('integration_unavailable');
    expect(enqueueHmsRead).not.toHaveBeenCalled();
  });
});
