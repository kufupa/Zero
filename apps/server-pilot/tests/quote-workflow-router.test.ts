import { quoteWorkflowLoaders, voucherLoaders } from '../src/trpc/routes/quote-workflow.js';
import { paneStaySaveLoaders } from '../src/ai/pane-stay-save.js';
import { analyseQuoteSources } from '../src/ai/quote-workflow-analyse.js';
import { lunaAnalysisSchema } from '../src/ai/reservationist-decision.js';
import { AMBIGUOUS_NUMBER_GROUPS } from '../src/ai/card-mask.js';
import { readQuoteAttachments } from '../src/ai/quote-workflow-synced-selection.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { getDb } from '../src/db/client.js';
import { recordStaffNote } from '../src/ai/work-events.js';
import { workItemIdForMail } from '../src/ai/work-items.js';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The staff note is kept by a separate write. The route does not wait for it, so a test can hold that write open.
vi.mock('../src/db/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/client.js')>();
  return { ...actual, getDb: vi.fn(actual.getDb) };
});
vi.mock('../src/ai/work-items.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/work-items.js')>();
  return { ...actual, workItemIdForMail: vi.fn(actual.workItemIdForMail) };
});
vi.mock('../src/ai/work-events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/work-events.js')>();
  return { ...actual, recordStaffNote: vi.fn(actual.recordStaffNote) };
});

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

  it.each(['quote', 'create_booking'] as const)(
    'keeps a stay group for a staff %s override when no quote keyword matches',
    (treatAs) => {
      const analysis = analyseQuoteSources({
        subject: 'Reservation',
        bodyText: 'Please reserve 2027-11-12 to 2027-11-14 for 2 adults.',
        treatAs,
      });
      expect(analysis.intent).toBe('quote');
      expect(analysis.groups[0]).toMatchObject({
        arrivalDate: '2027-11-12',
        departureDate: '2027-11-14',
        adults: 2,
      });
    },
  );

  it('lets a staff note arrival correction replace only the arrival it names', () => {
    const analysis = analyseQuoteSources({
      subject: 'Quote request',
      bodyText: 'Please quote 2 adults 2027-11-12 to 2027-11-14.',
      staffNote: 'Arrival is now 2027-11-13',
    });
    expect(analysis.groups[0]).toMatchObject({
      arrivalDate: '2027-11-13',
      departureDate: '2027-11-14',
      adults: 2,
    });
    expect(analysis.groups[0]?.fields).toMatchObject({
      arrivalDate: 'staff_corrected',
      departureDate: 'extracted',
    });
  });

  it('lets a staff note departure correction replace only the departure it names', () => {
    const analysis = analyseQuoteSources({
      subject: 'Quote request',
      bodyText: 'Please quote 2 adults 2027-11-12 to 2027-11-14.',
      staffNote: 'Departure is now 2027-11-15',
    });
    expect(analysis.groups[0]).toMatchObject({
      arrivalDate: '2027-11-12',
      departureDate: '2027-11-15',
    });
  });

  it.each([
    { note: 'Departure changed from 2027-11-14 to 2027-11-15.', arrivalDate: '2027-11-12', departureDate: '2027-11-15' },
    { note: 'Check-out changed from 2027-11-14 to 2027-11-15.', arrivalDate: '2027-11-12', departureDate: '2027-11-15' },
    { note: 'Arrival changed from 2027-11-12 to 2027-11-11.', arrivalDate: '2027-11-11', departureDate: '2027-11-14' },
    { note: 'Arrival 2027-11-12. Departure changed from 2027-11-14 to 2027-11-15.', arrivalDate: '2027-11-12', departureDate: '2027-11-15' },
  ])('applies an old-to-new staff correction only to the field it names: $note', ({ note, arrivalDate, departureDate }) => {
    const analysis = analyseQuoteSources({
      subject: 'Quote request',
      bodyText: 'Please quote 2 adults 2027-11-12 to 2027-11-14.',
      staffNote: note,
    });
    expect(analysis.groups[0]).toMatchObject({ arrivalDate, departureDate, adults: 2 });
  });

  it('reads two dates in a staff note in reading order, mixing date formats', () => {
    const analysis = analyseQuoteSources({
      subject: 'Quote request',
      bodyText: 'Please quote 2 adults 2027-11-12 to 2027-11-14.',
      staffNote: 'Stay 13 November 2027 to 2027-11-15',
    });
    expect(analysis.groups[0]).toMatchObject({
      arrivalDate: '2027-11-13',
      departureDate: '2027-11-15',
    });
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

  it('flags an automated sender so the pane can hide Insert draft, and leaves a guest sender unflagged', async () => {
    quoteWorkflowLoaders.llmEnabled = () => false;
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Your voucher',
      bodyText: 'Please send availability for two rooms.',
      preceding: [],
      attachments: [],
      fromAddress: 'Travelit <notifications@travelit.example>',
    });
    const automated = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<noreply-1@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 1,
    });
    expect(automated).toMatchObject({ status: 'ready', noReplySender: true });

    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Quote request',
      bodyText: 'Please send availability for two rooms.',
      preceding: [],
      attachments: [],
      fromAddress: 'ada@example.test',
    });
    const guest = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<guest-1@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 1,
    });
    expect(guest).toMatchObject({ status: 'ready', noReplySender: false });
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

  it('asks staff to review masked ambiguous number groups without calling the readable attachment unread', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Room assignments',
      bodyText: 'Please confirm availability for the listed guests.',
      preceding: [],
      attachments: [{
        id: 'sheet',
        filename: 'rooming.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        byteSize: 40_000,
        bytesPresent: true,
        text: `Rooms ${AMBIGUOUS_NUMBER_GROUPS}`,
        readFailure: 'ambiguous number groups',
      }],
    });
    quoteWorkflowLoaders.llmEnabled = () => false;
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<rooming@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 1,
    });

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.reviewItems).toContainEqual(expect.objectContaining({
        kind: 'document_failure',
        text: 'Some number groups may be room numbers or card details. Check the original source.',
        blocking: false,
      }));
      expect(result.reviewItems?.some((item) => item.text?.includes("Nava can't read rooming.xlsx"))).toBe(false);
    }
  });

  it('warns that later XLSX rows were omitted without calling the source unread', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Room assignments',
      bodyText: 'Please quote the listed guests.',
      preceding: [],
      attachments: [{
        id: 'long-rooming',
        filename: 'rooming.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        byteSize: 40_000,
        bytesPresent: true,
        text: 'first rows only',
        reviewReason: 'spreadsheet text truncated',
      }],
    });
    quoteWorkflowLoaders.llmEnabled = () => false;
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<rooming-truncated@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 2,
    });

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.reviewItems).toContainEqual(expect.objectContaining({
        id: 'spreadsheet-review:long-rooming',
        kind: 'document_failure',
        readable: true,
        text: 'Nava sent only the beginning of this spreadsheet for analysis. Review later rows and any masked number groups in the original file.',
      }));
      expect(result.reviewItems?.some((item) => item.text?.includes("Nava can't read rooming.xlsx"))).toBe(false);
      expect(result.luna?.flags ?? []).not.toContain('attachment_unread');
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

  it('raises no review row and no banner for a signature image or a calendar invite on a quote request', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.',
      preceding: [],
      attachments: [
        { id: 'sig', filename: 'image001.jpg', mimeType: 'image/jpeg', byteSize: 12_000, bytesPresent: false, readFailure: 'not a PDF' },
        { id: 'ics', filename: 'invite.ics', mimeType: 'text/calendar', byteSize: 2_000, bytesPresent: false, readFailure: 'not a PDF' },
      ],
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput(),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, estimatedCostUsd: 0, rateTableVersion: 't' },
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
      expect(result.luna?.flags ?? []).not.toContain('attachment_unread');
      expect(result.reviewItems?.filter((item) => item.kind === 'document_failure' || item.blocking)).toEqual([]);
    }
  });

  it('raises one non-blocking row in Nava copy for a document it cannot read, and one banner flag', async () => {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.',
      preceding: [],
      attachments: [
        {
          id: 'doc',
          filename: 'rooming.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          byteSize: 50_000,
          bytesPresent: false,
          readFailure: 'not a PDF',
        },
      ],
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput(),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, estimatedCostUsd: 0, rateTableVersion: 't' },
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
      expect(result.luna?.flags.filter((flag) => flag === 'attachment_unread')).toHaveLength(1);
      const rows = result.reviewItems?.filter((item) => item.kind === 'document_failure') ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        blocking: false,
        text: "Nava can't read rooming.docx (not a PDF) — open it if it has booking details.",
      });
    }
  });

  it('lists a document that has a Content-ID as a non-blocking row, from the real loader filter', async () => {
    const attachments = await readQuoteAttachments(
      [
        {
          id: 'rooming',
          filename: 'rooming.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 50_000,
          isInline: false,
          contentId: 'rooming-cid@x',
          s3Key: 'attachments/m1/rooming',
          messageId: 'm1',
        },
      ],
      async () => ({ text: null }),
    );
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Rooms',
      bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.',
      preceding: [],
      attachments,
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput(),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, estimatedCostUsd: 0, rateTableVersion: 't' },
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
      const rows = result.reviewItems?.filter((item) => item.kind === 'document_failure') ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        blocking: false,
        text: "Nava can't read rooming.docx (not a PDF) — open it if it has booking details.",
      });
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

  it.each([
    {
      label: 'one yearless stay',
      bodyText: 'Please quote 12-14 March for 2 adults, B&B. Guest: Ada Lovelace.',
      groups: [
        { arrival: '2026-03-12', departure: '2026-03-15', dateEvidence: '12-14 March', guestNames: ['Ada Lovelace'] },
      ],
      expected: [{ arrival: '2027-03-12', departure: '2027-03-15', guestNames: ['Ada Lovelace'] }],
    },
    {
      label: 'a yearless first stay of two',
      bodyText: 'Please quote 12-14 March for Ada Lovelace and 2027-04-02 to 2027-04-04 for Grace Hopper.',
      groups: [
        { arrival: '2026-03-12', departure: '2026-03-15', dateEvidence: '12-14 March', guestNames: ['Ada Lovelace'] },
        {
          arrival: '2027-04-02',
          departure: '2027-04-04',
          dateEvidence: '2027-04-02 to 2027-04-04',
          guestNames: ['Grace Hopper'],
        },
      ],
      expected: [
        { arrival: '2027-03-12', departure: '2027-03-15', guestNames: ['Ada Lovelace'] },
        { arrival: '2027-04-02', departure: '2027-04-04', guestNames: ['Grace Hopper'] },
      ],
    },
    {
      label: 'a yearless second stay of two',
      bodyText: 'Please quote 2027-04-02 to 2027-04-04 for Grace Hopper and 12-14 March for Ada Lovelace.',
      groups: [
        {
          arrival: '2027-04-02',
          departure: '2027-04-04',
          dateEvidence: '2027-04-02 to 2027-04-04',
          guestNames: ['Grace Hopper'],
        },
        { arrival: '2026-03-12', departure: '2026-03-15', dateEvidence: '12-14 March', guestNames: ['Ada Lovelace'] },
      ],
      expected: [
        { arrival: '2027-04-02', departure: '2027-04-04', guestNames: ['Grace Hopper'] },
        { arrival: '2027-03-12', departure: '2027-03-15', guestNames: ['Ada Lovelace'] },
      ],
    },
  ])(
    'returns luna.groups dates equal to the mapped stay dates, so the staff overlay can match guestNames ($label)',
    async ({ bodyText, groups, expected }) => {
      quoteWorkflowLoaders.loadSyncedSelection = async () => ({
        subject: 'Quote request',
        bodyText,
        preceding: [],
        attachments: [],
        receivedAt: '2026-12-20T12:00:00.000Z',
      });
      quoteWorkflowLoaders.llmEnabled = () => true;
      quoteWorkflowLoaders.adapter = {
        invoke: async () => ({
          modelId: 'gpt-6-luna',
          output: lunaOutput({ groups: groups.map((group) => ({ ...quoteGroup, ...group })) }),
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
        internetMessageId: '<date-sync@x>',
        storeId: 'store-1',
        entryId: 'entry-1',
        folderEntryId: 'folder-1',
        selectionEpoch: 12,
      });
      expect(result.status).toBe('ready');
      if (result.status === 'ready') {
        expect(result.source).toBe('luna');
        expect(result.groups).toMatchObject(
          expected.map(({ arrival, departure }) => ({ arrivalDate: arrival, departureDate: departure })),
        );
        expect(result.luna).toMatchObject({ workflow: 'quote' });
        expect(result.luna?.groups).toMatchObject(
          expected.map(({ arrival, departure, guestNames }) => ({
            arrival,
            departure,
            guestNames,
            rooms: 1,
            adultsPerRoom: 2,
          })),
        );
      }
    },
  );
});

describe('quoteWorkflow.analyseSelection amendment payload', () => {
  afterEach(() => {
    quoteWorkflowLoaders.loadSyncedSelection = null;
    quoteWorkflowLoaders.adapter = null;
    quoteWorkflowLoaders.llmEnabled = null;
    quoteWorkflowLoaders.analyseCacheDir = null;
    quoteWorkflowLoaders.promptVersion = null;
  });

  function useLuna(output: Record<string, unknown>, bodyText: string) {
    quoteWorkflowLoaders.loadSyncedSelection = async () => ({
      subject: 'Booking change',
      bodyText,
      preceding: [],
      attachments: [],
    });
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.adapter = {
      invoke: async () => ({
        modelId: 'gpt-6-luna',
        output: lunaOutput(output),
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
  }

  function analyseWith(internetMessageId: string, selectionEpoch: number) {
    return mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId,
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch,
    });
  }

  it('returns intent other and an amendment payload for an amend mail', async () => {
    useLuna(
      {
        workflow: 'amend',
        groups: [],
        tasks: [{ kind: 'amend', groupIndexes: [], note: 'change departure' }],
        confirmationNumber: '57291630-1',
        guestLastName: 'Example',
        arrival: '2026-11-12',
        departure: '2026-11-17',
        requestedChange: 'Change departure from 15 Nov to 17 Nov',
      },
      'Please change booking 57291630-1 for Example: leave 17 Nov instead of 15 Nov.',
    );
    const result = await analyseWith('<amend-1@x>', 4);
    expect(result).toMatchObject({
      status: 'ready',
      source: 'luna',
      intent: 'other',
      workflow: 'amend',
      groups: [],
      amendment: {
        kind: 'amend',
        confirmationNumber: '57291630-1',
        guestLastName: 'Example',
        arrival: '2026-11-12',
        departure: '2026-11-17',
        requestedChange: 'Change departure from 15 Nov to 17 Nov',
      },
    });
  });

  it('returns a cancel amendment, and a null amendment for a quote', async () => {
    useLuna(
      {
        workflow: 'cancel',
        groups: [],
        tasks: [{ kind: 'cancel', groupIndexes: [], note: 'cancel stay' }],
        confirmationNumber: '57291630-1',
      },
      'Please cancel booking 57291630-1.',
    );
    const cancelled = await analyseWith('<cancel-1@x>', 5);
    expect(cancelled).toMatchObject({
      workflow: 'cancel',
      intent: 'other',
      amendment: { kind: 'cancel', confirmationNumber: '57291630-1' },
    });

    useLuna({}, 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.');
    const quote = await analyseWith('<quote-1@x>', 6);
    expect(quote).toMatchObject({ workflow: 'quote', intent: 'quote', amendment: null });
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

  it('shares one cache file between a bracketed and a bare message id', async () => {
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
    const bracketed = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<Cache-Canon@X>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 21,
    });
    const bare = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: 'cache-canon@x',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 22,
    });
    expect(invokes).toBe(1);
    expect(bracketed.status).toBe('ready');
    expect(bare).toMatchObject({ status: 'ready', source: 'luna', sourceRevision: 22 });
  });

  it('misses the cache when the prompt version changes', async () => {
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
    cacheLoaders.promptVersion = 'prompt-h5-test-next';
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

  it('keeps treatAs quote on regex fallback', async () => {
    cacheLoaders.llmEnabled = () => false;
    cacheLoaders.loadSyncedSelection = async () => ({
      subject: 'Venue',
      bodyText: 'DDR and conference rooms please.',
      preceding: [],
      attachments: [],
    });
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 13,
      treatAs: 'quote',
      staffNote: '12 standard twins 12-14 Nov',
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.source).toBe('regex_fallback');
      expect(result.intent).toBe('quote');
      expect(result.workflow).toBe('quote');
    }
  });

  it('keeps a booking override on the quote workspace when Luna is unavailable', async () => {
    cacheLoaders.llmEnabled = () => false;
    cacheLoaders.loadSyncedSelection = async () => ({
      subject: 'Quote and reserve',
      bodyText: 'Please quote and reserve 2027-11-12 to 2027-11-14 for 2 adults.',
      preceding: [],
      attachments: [],
    });
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 21,
      treatAs: 'create_booking',
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.source).toBe('regex_fallback');
      expect(result.intent).toBe('quote');
      expect(result.workflow).toBe('create_booking');
      expect(result.groups[0]).toMatchObject({
        arrivalDate: '2027-11-12',
        departureDate: '2027-11-14',
      });
      // The pane reads the booking choice from luna.workflow; the carrier must pass the
      // server booking-draft schema so the pane can send it back.
      expect(result.luna?.workflow).toBe('create_booking');
      expect(lunaAnalysisSchema.safeParse(result.luna).success).toBe(true);
    }
  });

  it('tells staff what to check when a regex-fallback override is shown', async () => {
    cacheLoaders.llmEnabled = () => false;
    cacheLoaders.loadSyncedSelection = async () => ({
      subject: 'Quote and reserve',
      bodyText: 'Please quote and reserve 2027-11-12 to 2027-11-14 for 2 adults.',
      preceding: [],
      attachments: [],
    });
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 22,
      treatAs: 'create_booking',
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.reviewItems?.map((item) => item.text)).toContainEqual(
        expect.stringMatching(/^Nava is unavailable.*Check the dates and room count below/),
      );
    }
  });

  it('tells staff to edit the room count directly, since a note cannot change it', async () => {
    cacheLoaders.llmEnabled = () => false;
    cacheLoaders.loadSyncedSelection = async () => ({
      subject: 'Quote and reserve',
      bodyText: 'Please quote and reserve 2027-11-12 to 2027-11-14 for 2 adults.',
      preceding: [],
      attachments: [],
    });
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 23,
      treatAs: 'create_booking',
      staffNote: '3 rooms',
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      const item = result.reviewItems?.find((row) => row.id === 'luna-unavailable');
      expect(item?.text).toMatch(/Edit the room count directly/);
      expect(item?.text).not.toMatch(/add a note with corrections/);
      expect(result.groups[0]?.quantity).toBe(1);
    }
  });

  it('keeps a stay group when treat-as quote is applied to a mail with no quote keyword', async () => {
    cacheLoaders.llmEnabled = () => false;
    cacheLoaders.loadSyncedSelection = async () => ({
      subject: 'Reservation',
      bodyText: 'Please reserve 2027-11-12 to 2027-11-14 for 2 adults.',
      preceding: [],
      attachments: [],
    });
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 23,
      treatAs: 'quote',
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.intent).toBe('quote');
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toMatchObject({
        arrivalDate: '2027-11-12',
        departureDate: '2027-11-14',
      });
    }
  });

  it('answers without waiting for the staff note to be kept, and logs a note that fails to keep', async () => {
    cacheLoaders.llmEnabled = () => false;
    cacheLoaders.loadSyncedSelection = async () => ({
      subject: 'Quote request',
      bodyText: 'Please quote 2 adults 2027-11-12 to 2027-11-14.',
      preceding: [],
      attachments: [],
    });
    const request = {
      internetMessageId: '<note-keep@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      staffNote: 'Arrival is now 2027-11-13',
    };
    // The writes are mocked, so the stub database is never queried.
    vi.mocked(getDb).mockReturnValue({} as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.mocked(workItemIdForMail).mockResolvedValueOnce('wi-note');
      vi.mocked(recordStaffNote).mockImplementationOnce(() => new Promise(() => undefined));
      expect(await mailboxCaller().quoteWorkflow.analyseSelection({ ...request, selectionEpoch: 31 })).toMatchObject({
        status: 'ready',
      });

      vi.mocked(workItemIdForMail).mockResolvedValueOnce('wi-note');
      vi.mocked(recordStaffNote).mockRejectedValueOnce(new Error('db down'));
      expect(await mailboxCaller().quoteWorkflow.analyseSelection({ ...request, selectionEpoch: 32 })).toMatchObject({
        status: 'ready',
      });
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('staff_note_not_kept', 'db down'));
    } finally {
      warn.mockRestore();
      vi.mocked(getDb).mockRestore();
    }
  });

  it('applies a staff note arrival correction without mixing in the email dates', async () => {
    cacheLoaders.llmEnabled = () => false;
    cacheLoaders.loadSyncedSelection = async () => ({
      subject: 'Quote request',
      bodyText: 'Please quote 2 adults 2027-11-12 to 2027-11-14.',
      preceding: [],
      attachments: [],
    });
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<cache-h5@x>',
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 24,
      staffNote: 'Arrival is now 2027-11-13',
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.groups[0]).toMatchObject({
        arrivalDate: '2027-11-13',
        departureDate: '2027-11-14',
      });
    }
  });

  it('does not cache regex_fallback so a later Luna call can recover', async () => {
    cacheLoaders.llmEnabled = () => false;
    const first = await analyse();
    expect(first).toMatchObject({ source: 'regex_fallback' });
    let invokes = 0;
    cacheLoaders.llmEnabled = () => true;
    cacheLoaders.adapter = {
      invoke: async () => {
        invokes += 1;
        return {
          modelId: 'gpt-6-luna',
          output: lunaOutput(),
        };
      },
    };
    const second = await analyse();
    expect(invokes).toBe(1);
    expect(second).toMatchObject({ source: 'luna' });
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
    paneStaySaveLoaders.mode = null;
  });

  it('refuses preview and commit when RESERVATIONIST_PANE_SAVE is unset', async () => {
    paneStaySaveLoaders.mode = () => 'off';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(mailboxCaller().quoteWorkflow.previewStay(paneStay)).resolves.toMatchObject({
      status: 'refused',
      reason: 'pane_save_flag_off',
    });
    await expect(
      mailboxCaller().quoteWorkflow.commitStay({ ...paneStay, previewDigest: '0'.repeat(64) }),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'pane_save_flag_off',
    });
  });

  it('commit refuses when the OSRESS guest-date reader is parked', async () => {
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.osressGuestDatesSearch = null;
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      mailboxCaller().quoteWorkflow.commitStay({ ...paneStay, previewDigest: '0'.repeat(64) }),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'osress_reader_parked',
    });
  });

  it('passes the agency, organization, note and booker fields through to the save, and caps the note at 2000', async () => {
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = { withLock: async (fn) => fn() };
    const seen: unknown[] = [];
    paneStaySaveLoaders.spawn = async (input) => {
      seen.push(input.stay);
      return { outcome: 'previewed', clickedSave: false, confirmationNumber: '' };
    };
    const extras = {
      bookingAgency: { name: 'XYZ TRAVEL' },
      organization: { nativeId: '4411', name: 'Bidvest' },
      reservationNote: 'Late arrival',
      bookerName: 'Ann Booker',
      bookerEmail: 'ann@example.invalid',
    };
    await expect(mailboxCaller().quoteWorkflow.previewStay({ ...paneStay, ...extras })).resolves.toMatchObject({
      status: 'ok',
      outcome: 'previewed',
    });
    expect(seen[0]).toMatchObject(extras);
    await expect(
      mailboxCaller().quoteWorkflow.previewStay({ ...paneStay, reservationNote: 'x'.repeat(2001) }),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().quoteWorkflow.previewStay({ ...paneStay, bookerName: 'b'.repeat(51) }),
    ).rejects.toThrow();
  });

  it('commitStay requires a 64-hex previewDigest at the schema', async () => {
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(mailboxCaller().quoteWorkflow.commitStay(paneStay as never)).rejects.toThrow();
    await expect(
      mailboxCaller().quoteWorkflow.commitStay({ ...paneStay, previewDigest: 'abc' } as never),
    ).rejects.toThrow();
  });

  it('previewStay returns previewDigest and commitStay commits only with it, once', async () => {
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = { withLock: async (fn) => fn() };
    paneStaySaveLoaders.osressGuestDatesSearch = async () => 'clear';
    paneStaySaveLoaders.spawn = async (input) =>
      input.paneCommit
        ? { outcome: 'committed', clickedSave: true, confirmationNumber: '46184891-1' }
        : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' };
    const preview = await mailboxCaller().quoteWorkflow.previewStay(paneStay);
    expect(preview).toMatchObject({ status: 'ok', outcome: 'previewed' });
    const previewDigest = preview.previewDigest as string;
    expect(previewDigest).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      mailboxCaller().quoteWorkflow.commitStay({ ...paneStay, previewDigest }),
    ).resolves.toMatchObject({ status: 'ok', outcome: 'committed', confirmationNumber: '46184891-1' });
    await expect(
      mailboxCaller().quoteWorkflow.commitStay({ ...paneStay, previewDigest }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_preview_required' });
  });
});

describe('quoteWorkflow.analyseSelection without Outlook ids', () => {
  afterEach(() => {
    quoteWorkflowLoaders.loadSyncedSelection = null;
    quoteWorkflowLoaders.adapter = null;
    quoteWorkflowLoaders.llmEnabled = null;
    quoteWorkflowLoaders.analyseCacheDir = null;
    quoteWorkflowLoaders.promptVersion = null;
  });

  it('analyses by internetMessageId alone, as the web preview sends it', async () => {
    const seen: Record<string, unknown>[] = [];
    quoteWorkflowLoaders.loadSyncedSelection = async (input) => {
      seen.push({ ...input });
      return {
        subject: 'Rooms',
        bodyText: 'Please quote 1 room.',
        preceding: [],
        attachments: [],
      };
    };
    quoteWorkflowLoaders.llmEnabled = () => false;
    const result = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: '<preview-1@x>',
      selectionEpoch: 2,
    });
    expect(result).toMatchObject({ status: 'ready', source: 'regex_fallback' });
    expect(seen).toHaveLength(1);
    // The route canonicalises the id (brackets stripped) before the loader sees it.
    expect(seen[0]).toMatchObject({ internetMessageId: 'preview-1@x' });
  });
});

describe('quoteWorkflow.voucherFind', () => {
  afterEach(() => {
    voucherLoaders.candidate = null;
    voucherLoaders.readText = null;
  });

  function attachmentRow(id: string, filename: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      filename,
      mimeType: filename.endsWith('.pdf') ? 'application/pdf' : 'image/png',
      sizeBytes: 100,
      isInline: false,
      s3Key: `k/${id}`,
      messageId: 'm1',
      threadId: 'thread-1',
      ...extra,
    };
  }

  it('answers unsynced for a Message-ID this mailbox has not synced', async () => {
    voucherLoaders.candidate = async () => null;
    await expect(
      mailboxCaller().quoteWorkflow.voucherFind({ internetMessageId: '<abc@host>' }),
    ).resolves.toEqual({ status: 'unsynced' });
  });

  it('answers not_voucher for an ordinary email, without reading any attachment text', async () => {
    const readText = vi.fn(async () => []);
    voucherLoaders.candidate = async () => ({
      messageId: 'm1',
      threadId: 'thread-1',
      subject: 'Booking request',
      bodyText: 'Please quote two rooms.',
      attachments: [attachmentRow('a', 'Quote.pdf')],
    });
    voucherLoaders.readText = readText;
    await expect(
      mailboxCaller().quoteWorkflow.voucherFind({ internetMessageId: 'abc@host' }),
    ).resolves.toEqual({ status: 'not_voucher' });
    expect(readText).not.toHaveBeenCalled();
  });

  it('reads only the voucher files, and returns the guest facts and the file to save', async () => {
    const seen: unknown[] = [];
    const readText = vi.fn(async (files: Array<{ id: string; filename: string; sizeBytes: number }>) =>
      files.map((file) => ({
        id: file.id,
        filename: file.filename,
        byteSize: file.sizeBytes,
        bytesPresent: true,
        text: 'GUEST: Smith, John\nARRIVAL 2026-11-12',
      })),
    );
    voucherLoaders.candidate = async (input) => {
      seen.push(input);
      return {
        messageId: 'm1',
        threadId: 'thread-1',
        subject: 'Voucher – Smith',
        bodyText: 'Please find it attached.',
        attachments: [
          attachmentRow('att-1', 'Smith_VCH_1879000.pdf'),
          attachmentRow('att-2', 'logo.png', { isInline: true }),
        ],
      };
    };
    voucherLoaders.readText = readText;
    const reply = await mailboxCaller().quoteWorkflow.voucherFind({ internetMessageId: '<ABC@Host>' });
    expect(seen).toEqual([{ transportId: 'transport-1', internetMessageId: 'abc@host' }]);
    expect(readText.mock.calls[0]?.[0].map((file) => file.id)).toEqual(['att-1']);
    expect(reply).toEqual({
      status: 'voucher',
      messageId: 'm1',
      threadId: 'thread-1',
      guest: { lastName: 'Smith', arrival: '2026-11-12' },
      file: {
        id: 'att-1',
        filename: 'Smith_VCH_1879000.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      },
      unreadPdfs: 0,
    });
  });

  it('counts a voucher PDF the reader could not read, so the card can tell staff to check it', async () => {
    voucherLoaders.candidate = async () => ({
      messageId: 'm1',
      threadId: 'thread-1',
      subject: 'Voucher – Smith',
      bodyText: 'Please find it attached.',
      attachments: [attachmentRow('att-1', 'Smith_VCH_1879000.pdf'), attachmentRow('att-2', 'Smith_VCH_1879000_p2.pdf')],
    });
    voucherLoaders.readText = async (files: Array<{ id: string; filename: string; sizeBytes: number }>) =>
      files.map((file) =>
        file.id === 'att-1'
          ? { id: file.id, filename: file.filename, byteSize: file.sizeBytes, bytesPresent: true, text: 'GUEST: Smith\nARRIVAL 2026-11-12' }
          : {
              id: file.id,
              filename: file.filename,
              byteSize: file.sizeBytes,
              bytesPresent: false,
              readFailure: 'over the 3 file / 5 MB analysis limit',
            },
      );
    const reply = await mailboxCaller().quoteWorkflow.voucherFind({ internetMessageId: 'abc@host' });
    expect(reply).toMatchObject({
      status: 'voucher',
      guest: { lastName: 'Smith', arrival: '2026-11-12' },
      unreadPdfs: 1,
    });
  });

  it('counts a scanned voucher PDF with no text as unread, and still answers from the email', async () => {
    voucherLoaders.candidate = async () => ({
      messageId: 'm2',
      threadId: 'thread-1',
      subject: 'Voucher – Jones',
      bodyText: 'Guest: Jones\nArrival: 12 Nov 2026',
      attachments: [attachmentRow('scan-1', 'Jones_VCH_77.pdf')],
    });
    voucherLoaders.readText = async (files: Array<{ id: string; filename: string; sizeBytes: number }>) =>
      files.map((file) => ({
        id: file.id,
        filename: file.filename,
        byteSize: file.sizeBytes,
        bytesPresent: true,
        pdf: new Uint8Array([37, 80, 68, 70]),
      }));
    const reply = await mailboxCaller().quoteWorkflow.voucherFind({ internetMessageId: 'def@host' });
    expect(reply).toMatchObject({
      status: 'voucher',
      guest: { lastName: 'Jones', arrival: '2026-11-12' },
      unreadPdfs: 1,
    });
  });

  it('reads the voucher-named PDF even after three unrelated PDFs, and every PDF only when none is voucher-named', async () => {
    const readText = vi.fn(async (_files: Array<{ id: string; filename: string; sizeBytes: number }>) => []);
    voucherLoaders.readText = readText;
    voucherLoaders.candidate = async () => ({
      messageId: 'm1',
      threadId: 'thread-1',
      subject: 'Proof of payment',
      bodyText: 'Attached.',
      attachments: [
        attachmentRow('s1', 'statement-1.pdf'),
        attachmentRow('s2', 'statement-2.pdf'),
        attachmentRow('s3', 'statement-3.pdf'),
        attachmentRow('v', 'Smith_VCH_1879000.pdf'),
      ],
    });
    await mailboxCaller().quoteWorkflow.voucherFind({ internetMessageId: 'abc@host' });
    expect(readText.mock.calls[0]?.[0].map((file) => file.id)).toEqual(['v']);

    readText.mockClear();
    voucherLoaders.candidate = async () => ({
      messageId: 'm2',
      threadId: 'thread-1',
      subject: 'Proof of payment',
      bodyText: 'Attached.',
      attachments: [attachmentRow('p1', 'payment-1.pdf'), attachmentRow('p2', 'payment-2.pdf')],
    });
    await mailboxCaller().quoteWorkflow.voucherFind({ internetMessageId: 'def@host' });
    expect(readText.mock.calls[0]?.[0].map((file) => file.id)).toEqual(['p1', 'p2']);
  });

  it('refuses an empty Message-ID at the schema', async () => {
    await expect(
      mailboxCaller().quoteWorkflow.voucherFind({ internetMessageId: '' }),
    ).rejects.toThrow();
  });
});
