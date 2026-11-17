/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReservationPaneSnapshot, ReservationSourceContext, ReservationWorkflowClient } from '../lib/reservation-workflow/types';

const decisions = vi.hoisted(() => ({ blocked: '' }));
vi.mock('../../server-pilot/src/ai/reservation-workflow-v2-quote-readiness', async load => ({
  ...await load<typeof import('../../server-pilot/src/ai/reservation-workflow-v2-quote-readiness')>(),
  quoteReadinessBeforeSplit: () => [{ code: 'test', path: '', message: '' }],
  quoteReadiness: (_draft: unknown, id: string, stage: string) => stage === 'execute' && id === decisions.blocked
    ? [{ code: 'extra', path: '', message: 'Review the extras.' }] : [],
  compileQuote: (_draft: unknown, request: { id: string }) => ({ status: 'ok', request, inputDigest: request.id }),
  currentQuoteAvailabilityObservation: (draft: { observations: Array<{ criteria: { requestId: string } }> }, id: string) =>
    draft.observations.find(row => row.criteria.requestId === id) ?? null,
  quoteOverridesMatch: () => true,
  compilePreparedUnavailableQuote: () => null,
}));
vi.mock('../lib/reservation-workflow/quote-output', async load => ({
  ...await load<typeof import('../lib/reservation-workflow/quote-output')>(),
  getQuoteOutput: (_source: unknown, snapshot: ReservationPaneSnapshot, id: string) =>
    snapshot.session.draft.operationResults.some(row => row.requestId === id && row.status === 'succeeded')
      ? { cover: { to: 'buyer@example.test', subject: 'Quote', body: 'Quote' }, issues: [], failures: [], inventoryDecline: false,
          artifacts: [{ kind: 'pdf_quote' }, { kind: 'xlsx_quote' }] } : null,
}));
vi.mock('../lib/workstation/mutations-in-flight', async load => ({
  ...await load<typeof import('../lib/workstation/mutations-in-flight')>(), beginMutation: () => {}, endMutation: () => {},
}));
import { useReservationWorkbench } from '../components/reservation-pane/use-reservation-workbench';
import { QuoteEditor } from '../components/reservation-pane/editors/quote-editor';

afterEach(() => { cleanup(); decisions.blocked = ''; });

function setup(name: string, prepared = false, additive = false, differentOutput = false, dinner = false) {
  const source: ReservationSourceContext = { mailboxId: `mailbox-${name}`, propertyId: 'HRCEN', internetMessageId: null,
    messageId: `message-${name}`, threadId: 'thread', sourceHash: 'hash', selectionEpoch: 1,
    arrivedAt: '2026-11-16T00:00:00Z', subject: '', sender: '', attachments: [] };
  const members = [{ requestId: 'one', label: 'Breakfast' }, { requestId: 'two', label: 'Room only' }];
  const composition = additive ? { kind: 'additive' } : { kind: 'scenarios', options: members.map(member => ({
    id: member.requestId, label: member.label, requestIds: [member.requestId], evidenceRefs: [] })) };
  const groups = dinner ? ['group-1', 'group-2'].map(id => ({ id, arrival: '2027-01-01', departure: '2027-01-02',
    quantity: 1, roomCodes: [], ratePlan: 'BAR', mealPlan: 'bb', requestedMealPlan: 'bb',
    occupancy: { scope: 'per_room', adults: 1, childCount: 0, childAges: [] }, priceObservationRefs: [] })) : [];
  const requests = members.map(member => ({ id: member.requestId, kind: 'quote', body: { groups,
    parties: {}, client: {}, requestedMoney: dinner ? [{ id: 'dinner', amount: '200', currency: 'ZAR',
      unit: 'per_person_per_night', scope: 'unresolved', targetRefs: [], sourceRefs: [], staffAllowanceType: 'dinner' }] : [],
    outputIntent: { artifacts: differentOutput && member.requestId === 'two' ? ['email_quote'] : ['email_quote', 'pdf_quote', 'xlsx_quote'] },
    quoteFamily: { id: 'family', label: member.label, members, composition } } }));
  const snapshot = { sourceMessageId: source.messageId, session: { seq: 1, revision: 1, revisionHead: 1, draft: {
    transportId: source.mailboxId, propertyCode: source.propertyId, source: { messageId: source.messageId, threadId: source.threadId, sourceHash: source.sourceHash },
    generationId: 'generation', proposal: { content: { requests, services: [], documents: [] }, sourceClaims: [], annotations: [], issues: [] },
    fieldOverrides: {}, fieldReviewRequirements: {}, staffReviews: {}, observations: [], operationResults: [],
  } }, requests: members.map(member => ({ id: member.requestId, kind: 'quote' })), fields: {}, issues: [], operationResults: [], preparationViews: []
  } as unknown as ReservationPaneSnapshot;
  if (prepared) for (const member of members) {
    snapshot.session.draft.observations.push({ ref: `price-${member.requestId}`, criteria: { requestId: member.requestId },
      status: 'complete', coverage: { complete: true }, result: { freshUntil: new Date(Date.now() + 60_000).toISOString(), inputOverrides: {} } } as never);
    snapshot.session.draft.operationResults.push({ workflow: 'quote', requestId: member.requestId, generationId: 'generation',
      status: 'prepared', observationRefs: [`price-${member.requestId}`] } as never);
  }
  const calls: string[] = [];
  const client = {
    edit: vi.fn(async ({ snapshot: before, requestId, fieldPath, value }: { snapshot: ReservationPaneSnapshot; requestId: string; fieldPath: string; value: unknown }) => {
      calls.push(`edit:${requestId}`); const next = structuredClone(before); next.session.seq++; next.session.revision++;
      next.session.draft.fieldOverrides[fieldPath] = { state: 'set', value, updatedAt: '2026-11-16T00:00:00Z' };
      return next;
    }),
    reviewScope: vi.fn(async ({ snapshot: before, requestId }: { snapshot: ReservationPaneSnapshot; requestId: string }) => {
      calls.push(`review:${requestId}`); const next = structuredClone(before); next.session.seq++; next.session.revision++; return next;
    }),
    prepare: vi.fn(async ({ snapshot: before, requestId }: { snapshot: ReservationPaneSnapshot; requestId: string }) => {
      calls.push(`prepare:${requestId}`); const next = structuredClone(before);
      next.session.draft.observations.push({ ref: `price-${requestId}`, criteria: { requestId }, status: 'complete', coverage: { complete: true },
        result: { freshUntil: new Date(Date.now() + 60_000).toISOString(), inputOverrides: {} } } as never);
      next.session.draft.operationResults.push({ workflow: 'quote', requestId, generationId: 'generation', status: 'prepared', observationRefs: [`price-${requestId}`] } as never);
      return next;
    }),
    execute: vi.fn(async ({ snapshot: before, requestId }: { snapshot: ReservationPaneSnapshot; requestId: string }) => {
      calls.push(`execute:${requestId}`); const next = structuredClone(before);
      next.session.draft.operationResults.push({ workflow: 'quote', requestId, generationId: 'generation', status: 'succeeded', observationRefs: [] } as never);
      return next;
    }),
  } as unknown as ReservationWorkflowClient;
  const configuration = { propertyCode: 'HRCEN', transportId: source.mailboxId,
    capabilities: { quote: { status: 'staff-enabled' }, reads: { status: 'staff-enabled' } } } as never;
  const hook = renderHook(() => useReservationWorkbench({ source, activeProperty: 'HRCEN', configuration, snapshot, client, onSnapshot: vi.fn() }));
  return { hook, calls, client, source, configuration };
}

describe('generating quote options', () => {
  it('persists the dinner room choices through the workbench', async () => {
    const { hook, client, source } = setup('dinner-scope', false, false, false, true);
    const editor = () => ({ source, configuration: null, activeProperty: 'HRCEN', snapshot: hook.result.current.snapshot,
      request: hook.result.current.request, view: { busy: hook.result.current.busy, preview: false },
      commands: hook.result.current.commands } as any);
    const { rerender } = render(<QuoteEditor {...editor()} />);
    const base = '/proposal/content/requests/one/body/requestedMoney/0';
    fireEvent.click(screen.getByLabelText('Room group 2'));
    await waitFor(() => expect(vi.mocked(client.edit)).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.readyForReply()).toBe(true));
    expect(vi.mocked(client.edit).mock.calls.map(([call]) => [call.fieldPath, call.value])).toEqual([
      [`${base}/targetRefs`, ['group-2']], [`${base}/scope`, 'per_target'],
    ]);
    rerender(<QuoteEditor {...editor()} />);
    expect((screen.getByLabelText('Room group 2') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Room group 1') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Room group 1'));
    await waitFor(() => expect(vi.mocked(client.edit)).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(hook.result.current.readyForReply()).toBe(true));
    expect(vi.mocked(client.edit).mock.calls.slice(2).map(([call]) => [call.fieldPath, call.value])).toEqual([
      [`${base}/targetRefs`, []], [`${base}/scope`, 'overall'],
    ]);
  });
  it('reviews and prepares every option before generating any files', async () => {
    const { hook, calls } = setup('complete');
    await act(async () => { await hook.result.current.commands.executeQuoteFamily(); });
    expect(calls).toEqual(['review:one', 'review:two', 'prepare:one', 'prepare:two', 'execute:one', 'execute:two']);
  });

  it('opens the option needing review before generating any files', async () => {
    decisions.blocked = 'two';
    const { hook, calls } = setup('blocked');
    await act(async () => { await expect(hook.result.current.commands.executeQuoteFamily()).rejects.toThrow('Review the extras.'); });
    expect(calls.some(call => call.startsWith('execute:'))).toBe(false);
    await waitFor(() => expect(hook.result.current.activeId).toBe('two'));
  });

  it('keeps already prepared prices instead of replacing an accepted extras review', async () => {
    const { hook, calls } = setup('prepared', true);
    await act(async () => { await hook.result.current.commands.executeQuoteFamily(); });
    expect(calls).toEqual(['review:one', 'review:two', 'execute:one', 'execute:two']);
  });

  it('prepares both dates but generates one combined option', async () => {
    const { hook, calls } = setup('additive', false, true);
    await act(async () => { await hook.result.current.commands.executeQuoteFamily(); });
    expect(calls).toEqual(['review:one', 'review:two', 'prepare:one', 'prepare:two', 'execute:one']);
  });

  it('requests the complete package for every date before preparing', async () => {
    const { hook, calls } = setup('different-output', false, true, true);
    await act(async () => { await hook.result.current.commands.executeQuoteFamily(); });
    expect(calls).toEqual(['edit:two', 'review:one', 'review:two', 'prepare:one', 'prepare:two', 'execute:one']);
  });
});
