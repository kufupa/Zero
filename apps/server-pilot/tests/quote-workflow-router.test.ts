import { quoteWorkflowLoaders } from '../src/trpc/routes/quote-workflow.js';
import { paneStaySaveLoaders } from '../src/ai/pane-stay-save.js';
import { analyseQuoteSources } from '../src/ai/quote-workflow-analyse.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    quoteWorkflowLoaders.analyseCacheDir = null;
    quoteWorkflowLoaders.promptVersion = null;
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

  it('flags a scanned PDF with bytes but no text as unread on regex fallback', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Quote request',
      bodyText: 'Please send availability for two rooms.',
      preceding: [],
      attachments: [{ id: 'scan', filename: 'scan.pdf', bytesPresent: true }],
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

  it('does not surface room-type questions when Luna asks for a hotel default', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Please quote 1 room 12-14 Nov for 2 adults.',
      preceding: [],
      attachments: [],
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput({
          missing: [
            { field: 'roomType', question: 'Which room type?' },
            { field: 'guestNames', question: 'Guest names?' },
          ],
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
      selectionEpoch: 4,
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      const texts = (result.reviewItems ?? []).map((item) => item.text);
      expect(texts.some((text) => /room type/i.test(text))).toBe(false);
      expect(texts.some((text) => /Guest names/i.test(text))).toBe(true);
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

describe('quoteWorkflow.analyseSelection file cache', () => {
  const cacheLoaders = quoteWorkflowLoaders as typeof quoteWorkflowLoaders & {
    analyseCacheDir: string | null;
    promptVersion: string | null;
  };

  async function analyse() {
    return mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 11,
    });
  }

  beforeEach(async () => {
    cacheLoaders.analyseCacheDir = await mkdtemp(join(tmpdir(), 'luna-analyse-'));
    cacheLoaders.promptVersion = 'prompt-h5-test';
    cacheLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.',
      preceding: [],
      attachments: [],
    });
    cacheLoaders.llmEnabled = () => true;
  });

  afterEach(async () => {
    const dir = cacheLoaders.analyseCacheDir;
    cacheLoaders.loadSyncedSelection = null;
    cacheLoaders.adapter = null;
    cacheLoaders.llmEnabled = null;
    cacheLoaders.analyseCacheDir = null;
    cacheLoaders.promptVersion = null;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('reuses the file cache on re-click in under 1s without a second model call', async () => {
    let invokes = 0;
    cacheLoaders.adapter = {
      invoke: async () => {
        invokes += 1;
        return {
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
        };
      },
    };
    const first = await analyse();
    expect(invokes).toBe(1);
    expect(first.status).toBe('ready');
    const started = Date.now();
    const second = await analyse();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(invokes).toBe(1);
    expect(second.status).toBe('ready');
    if (first.status === 'ready' && second.status === 'ready') {
      expect(second.source).toBe('luna');
      expect(second.groups).toEqual(first.groups);
    }
    const files = await readdir(cacheLoaders.analyseCacheDir!);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/prompt-h5-test/);
  });

  it('misses the cache when the selection source changes', async () => {
    let invokes = 0;
    cacheLoaders.adapter = {
      invoke: async () => {
        invokes += 1;
        return {
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
        };
      },
    };
    await analyse();
    cacheLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Quote 3 rooms 2026-12-01 to 2026-12-03, 1 adult, B&B.',
      preceding: [],
      attachments: [],
    });
    await analyse();
    expect(invokes).toBe(2);
  });

  it('treatAs quote remaps a venue-flagged analysis onto the quote path', async () => {
    cacheLoaders.loadSyncedSelection = async () => ({
      subject: 'Conference',
      bodyText: 'Please quote 15 rooms 2026-11-12 to 2026-11-14, 1 adult, B&B.',
      preceding: [],
      attachments: [],
    });
    cacheLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput({
          workflow: 'other',
          flags: ['conference_or_group'],
          groups: [{ ...quoteGroup, rooms: 15 }],
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
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 12,
      treatAs: 'quote',
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.intent).toBe('quote');
      expect(result.groups[0]?.quantity).toBe(15);
      expect(result.luna?.workflow).toBe('quote');
    }
  });

  it('does not reuse cache when the staff note changes', async () => {
    let invokes = 0;
    cacheLoaders.adapter = {
      invoke: async () => {
        invokes += 1;
        return {
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
        };
      },
    };
    await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 14,
      staffNote: 'first note',
    });
    await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 15,
      staffNote: 'second note',
    });
    expect(invokes).toBe(2);
  });

  it('does not reuse an auto cache entry for a treatAs quote click', async () => {
    let invokes = 0;
    cacheLoaders.adapter = {
      invoke: async () => {
        invokes += 1;
        return {
          modelId: 'gpt-6-luna',
          output: lunaOutput({ workflow: 'other', flags: ['conference_or_group'] }),
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            latencyMs: 1,
            estimatedCostUsd: 0,
            rateTableVersion: 't',
          },
        };
      },
    };
    await analyse();
    await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 13,
      treatAs: 'quote',
    });
    expect(invokes).toBe(2);
  });

  it('misses the cache when promptVersion changes', async () => {
    let invokes = 0;
    cacheLoaders.adapter = {
      invoke: async () => {
        invokes += 1;
        return {
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
        };
      },
    };
    await analyse();
    cacheLoaders.promptVersion = 'prompt-h5-other';
    await analyse();
    expect(invokes).toBe(2);
  });
});

const paneStay = {
  firstName: 'Pat',
  lastName: 'Labtest',
  arrival: '2027-09-14',
  departure: '2027-09-16',
  adults: 1,
  sourceOfBusiness: 'Walk in',
  roomType: 'SUITE',
  ratePlan: 'BAR',
  track: 'BAR',
  guaranteeType: 'Awaiting Voucher',
};

describe('quoteWorkflow.previewStay / commitStay', () => {
  afterEach(() => {
    paneStaySaveLoaders.spawn = null;
    paneStaySaveLoaders.lock = null;
    paneStaySaveLoaders.osressGuestDatesSearch = null;
    paneStaySaveLoaders.enabled = null;
  });

  it('refuses preview and commit when RESERVATIONIST_PANE_SAVE is unset', async () => {
    paneStaySaveLoaders.enabled = () => false;
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(mailboxCaller().quoteWorkflow.previewStay(paneStay)).resolves.toMatchObject({
      status: 'refused',
      reason: 'pane_save_flag_off',
    });
    await expect(mailboxCaller().quoteWorkflow.commitStay(paneStay)).resolves.toMatchObject({
      status: 'refused',
      reason: 'pane_save_flag_off',
    });
  });

  it('commit refuses when the OSRESS guest-date reader is parked', async () => {
    paneStaySaveLoaders.enabled = () => true;
    paneStaySaveLoaders.osressGuestDatesSearch = null;
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(mailboxCaller().quoteWorkflow.commitStay(paneStay)).resolves.toMatchObject({
      status: 'refused',
      reason: 'osress_reader_parked',
    });
  });
});
