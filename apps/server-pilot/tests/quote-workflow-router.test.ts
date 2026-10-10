import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { quoteWorkflowLoaders } from '../src/trpc/routes/quote-workflow.js';
import { analyseQuoteSources } from '../src/ai/quote-workflow-analyse.js';

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

  it('returns missing_source when an attachment has a filename but no admitted bytes', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Quote request',
      bodyText: 'Please send availability for two rooms.',
      preceding: [],
      attachments: [{ id: 'att-rooming-list', filename: 'rooming-list.pdf', bytesPresent: false }],
    });
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<a@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 1,
    });
    expect(result).toEqual({
      status: 'missing_source',
      missing: ['att-rooming-list'],
      documentFailures: [{ filename: 'rooming-list.pdf', sourceRef: 'att-rooming-list', sourceKind: 'attachment', reason: 'Content unavailable; review the original attachment.' }],
    });
  });

  it('classifies non-quote mail without calling PMS', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Thanks',
      bodyText: 'Thank you for sorting parking yesterday.',
      preceding: [],
      attachments: [],
    });
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
