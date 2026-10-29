/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setMailCacheScope } from '@/lib/mail/mail-cache-scope';
import type { RecordFieldEventInput, SourcePartyFields, StoredWork } from '@/lib/quote-workflow/backend-bind';
import { useStoredWork } from '@/lib/quote-workflow/use-work-item';
import { bindExecuteStaffQuote } from '@/lib/quote-workflow/staff-quote-bind';
import { emptyStaffQuoteHeader, HRCEN_PROPERTY_CODE, type StayGroupRequirement } from '@/lib/quote-workflow/types';

type Ready = Extract<StoredWork, { status: 'ready' }>;
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const SCOPE = 'staff:session:transport-a';
const ROW: StayGroupRequirement = {
  id: 'r1', stayId: 's1', arrivalDate: '2027-10-20', departureDate: '2027-10-21',
  quantity: 1, adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'bb',
  specialRequests: [], fields: {}, sourcePreference: { roomType: null, board: null },
};
const INITIAL: Ready = {
  status: 'ready', kind: 'quote', workItemId: 'wi-1', workItemStatus: 'needs_you', extractionId: 'ex-1',
  refs: { r1: { stayId: 's1', rowId: 'r1' } },
  analysis: { intent: 'quote', groups: [ROW], secondaryAsks: [], alternatives: [] },
  contact: { name: null, company: 'Original Agency', endClient: null, email: null, phone: null },
  sourcePartyDigest: OLD, sourcePartyFields: { company: ['value', 'Original Agency'], endClient: ['missing'] },
  language: null, translation: null,
};

function harness(saved: Ready = INITIAL) {
  const query = vi.fn(async (): Promise<StoredWork> => saved).mockResolvedValueOnce(INITIAL);
  const record = vi.fn(async (input: RecordFieldEventInput) => ({ aiValue: null, value: input.value }));
  const trpc = { workItems: { getByMessage: { query }, recordEvent: { mutate: record } } };
  return { trpc, query, record };
}

function saved(fields: SourcePartyFields, digest = NEW): Ready {
  return { ...INITIAL, sourcePartyFields: fields, sourcePartyDigest: digest,
    contact: { ...INITIAL.contact, company: fields.company[0] === 'value' ? fields.company[1] : null,
      endClient: fields.endClient[0] === 'value' ? fields.endClient[1] : null } };
}

afterEach(() => {
  cleanup();
  setMailCacheScope({ userId: null, activeTransportId: null });
});

it('flushes a saved party edit and forwards its newly verified source in the next quote', async () => {
  setMailCacheScope({ userId: 'staff', activeTransportId: 'transport-a' });
  const { trpc, query, record } = harness(saved({ company: ['value', 'New Agency'], endClient: ['missing'] }));
  let finish!: () => void;
  record.mockImplementationOnce((input) => new Promise((resolve) => { finish = () => resolve({ aiValue: null, value: input.value }); }));
  const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm1', scope: SCOPE, verifyQuotePartySource: true }));
  await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready' }));
  act(() => result.current.recordContact('company', 'New Agency'));
  expect(result.current.quoteSourceAfterFlush().sourcePartyDigest).toBeNull();
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.flushEdits(); });
  await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
  await act(async () => { finish(); expect(await pending).toBe(true); });
  expect(query).toHaveBeenCalledTimes(2);
  const sourceParty = result.current.quoteSourceAfterFlush();
  expect(sourceParty).toEqual({ sourcePartyDigest: NEW, sourceExtractionId: 'ex-1' });
  const mutate = vi.fn(async (_input: unknown) => { throw new Error('stop after capture'); });
  await bindExecuteStaffQuote({ mutate, source: { messageId: 'm1', threadId: 't1', sourceHash: OLD },
    ...sourceParty, selectionEpoch: 1, inputRevision: 1, groups: [ROW],
    header: { ...emptyStaffQuoteHeader(), salesStrategy: 'BAR' }, propertyCode: HRCEN_PROPERTY_CODE });
  expect(mutate.mock.calls[0]?.[0]).toMatchObject(sourceParty);
});

it('confirms an explicit clear instead of treating it as missing', async () => {
  setMailCacheScope({ userId: 'staff', activeTransportId: 'transport-a' });
  const { trpc } = harness(saved({ company: ['cleared'], endClient: ['missing'] }));
  const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm1', scope: SCOPE, verifyQuotePartySource: true }));
  await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready' }));
  act(() => result.current.recordContact('company', null));
  await act(async () => expect(await result.current.flushEdits()).toBe(true));
  expect(result.current.quoteSourceAfterFlush().sourcePartyDigest).toBe(NEW);
});

it.each([
  ['a concurrent party edit', saved({ company: ['value', 'New Agency'], endClient: ['cleared'] })],
  ['a newer extraction', { ...saved({ company: ['value', 'New Agency'], endClient: ['missing'] }), extractionId: 'ex-2' }],
  ['missing source proof', { ...saved({ company: ['value', 'New Agency'], endClient: ['missing'] }), sourcePartyDigest: null }],
])('does not adopt a new digest after %s', async (_description, refreshed) => {
  setMailCacheScope({ userId: 'staff', activeTransportId: 'transport-a' });
  const { trpc } = harness(refreshed);
  const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm1', scope: SCOPE, verifyQuotePartySource: true }));
  await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready' }));
  act(() => result.current.recordContact('company', 'New Agency'));
  await act(async () => expect(await result.current.flushEdits()).toBe(false));
  expect(result.current.quoteSourceAfterFlush().sourcePartyDigest).toBeNull();
  expect(result.current.saveError).toMatch(/refresh/i);
});

it('drops a late source refresh after the pane switches to another email', async () => {
  setMailCacheScope({ userId: 'staff', activeTransportId: 'transport-a' });
  const { trpc, query } = harness();
  let finish!: (value: Ready) => void;
  const { result, rerender } = renderHook(({ messageId }) => useStoredWork({
    trpc, internetMessageId: messageId, scope: SCOPE, verifyQuotePartySource: true,
  }), { initialProps: { messageId: 'm1' } });
  await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready' }));
  query.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => result.current.recordContact('company', 'New Agency'));
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.flushEdits(); });
  await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
  rerender({ messageId: 'm2' });
  await act(async () => {
    finish(saved({ company: ['value', 'New Agency'], endClient: ['missing'] }));
    expect(await pending).toBe(false);
  });
  await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready' }));
  expect(result.current.quoteSourceAfterFlush().sourcePartyDigest).toBe(OLD);
});

it('keeps unrelated contact edits and the legacy property on their existing save path', async () => {
  setMailCacheScope({ userId: 'staff', activeTransportId: 'transport-a' });
  const { trpc, query } = harness();
  const { result } = renderHook(() => useStoredWork({ trpc, internetMessageId: 'm1', scope: SCOPE }));
  await waitFor(() => expect(result.current.pane).toMatchObject({ state: 'ready' }));
  act(() => { result.current.recordContact('name', 'Example'); result.current.recordContact('company', 'Legacy Agency'); });
  await act(async () => expect(await result.current.flushEdits()).toBe(true));
  expect(query).toHaveBeenCalledTimes(1);
  expect(result.current.quoteSourceAfterFlush().sourcePartyDigest).toBe(OLD);
});
