import { describe, expect, it, vi } from 'vitest';
import { attentionFieldPath, createTrpcReservationWorkflowClient, inputFieldLabel, type ReservationWorkflowV2TrpcClient } from '../lib/reservation-workflow/client';
import type { ReservationSourceContext } from '../lib/reservation-workflow/types';

const root = '/proposal/content/requests/quote-1';

describe('reservation workflow attention fields', () => {
  it('maps bare Quote party issues to mounted pickers', () => {
    expect(attentionFieldPath('organization_candidate_unverified', root))
      .toBe(`${root}/body/parties/organization`);
    expect(attentionFieldPath('bookingAgency_requires_staff_acceptance', root))
      .toBe(`${root}/body/parties/bookingAgency`);
    // Former Pass4/Pass6 fail modes (7940e9dc, 65c27686, e497761d).
    expect(attentionFieldPath('organization_unknown_staff_value', root))
      .toBe(`${root}/body/parties/organization`);
    expect(attentionFieldPath('organization_name_unresolved', root))
      .toBe(`${root}/body/parties/organization`);
    expect(attentionFieldPath('organization_selection_required', root))
      .toBe(`${root}/body/parties/organization`);
  });

  it('maps extra and meal-plan blockers to editable controls', () => {
    expect(attentionFieldPath(`${root}/body/allocations/0/guest:existing_profile_selection_required`, root))
      .toBe(`${root}/body/allocations/0/guest/nativeSelectionRef`);
    expect(attentionFieldPath(`${root}/body/requestedMoney/0:allowance_requires_supported_staff_choice`, root))
      .toBe(`${root}/body/requestedMoney/0/staffAllowanceType`);
    expect(attentionFieldPath(`${root}/body/groups/0/mealPlan:native_meal_plan_code_required`, root))
      .toBe(`${root}/body/groups/0/ratePlan`);
  });

  it('maps quote group blockers to Add/Remove controls', () => {
    expect(attentionFieldPath(`${root}/body/groups:group_required`, root))
      .toBe(`${root}/body/groups`);
    expect(attentionFieldPath(`${root}/body/groups:native_quote_group_limit`, root))
      .toBe(`${root}/body/groups/0`);
    expect(attentionFieldPath(`${root}/body/groups:duplicate_group_id`, root))
      .toBe(`${root}/body/groups/0`);
    expect(attentionFieldPath(`${root}/body/groups/2/id:native_group_id_limit`, root))
      .toBe(`${root}/body/groups/2`);
  });

  it('uses action-oriented Review labels', () => {
    expect(inputFieldLabel(`${root}/body/requestedMoney:lunch_extra_price_required`))
      .toBe('lunch extra requested amount');
    expect(inputFieldLabel(`${root}/body/requestedMoney/0:allowance_requires_supported_staff_choice`))
      .toBe('Handle as for this extra');
    expect(inputFieldLabel(`${root}/body/groups/0/mealPlan:native_board_code_required`))
      .toBe('Rate Plan (sets Meal Plan)');
    expect(inputFieldLabel(`${root}/body/shared/guestOptIn:true_not_supported`))
      .toBe('Terms and Conditions');
    expect(inputFieldLabel(`${root}/body/groups:group_required`)).toBe('Add a room group');
    expect(inputFieldLabel(`${root}/body/groups:duplicate_group_id`)).toBe('Remove a duplicate room group');
    expect(inputFieldLabel(`${root}/body/groups:native_quote_group_limit`)).toBe('Remove a room group (max 8)');
    expect(inputFieldLabel(`${root}/body/groups/0/id:native_group_id_limit`)).toBe('Remove this room group (ID too long)');
    expect(inputFieldLabel(`${root}/confirmationReference`))
      .toBe('source confirmation (review email/PDF — no Create field)');
  });
});

describe('reservation workflow Create approval', () => {
  const generationId = '00000000-0000-4000-8000-000000000002';
  const preparedRef = '00000000-0000-4000-8000-000000000003';
  const grantId = '00000000-0000-4000-8000-000000000004';
  const runId = '00000000-0000-4000-8000-000000000005';
  const attemptId = '00000000-0000-4000-8000-000000000007';
  const source: ReservationSourceContext = { mailboxId: 'transport-1', propertyId: 'HRCEN', threadId: 'thread-1',
    messageId: 'message-1', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00Z', selectionEpoch: 1,
    internetMessageId: null, subject: '', sender: '', attachments: [] };
  const draft = { contractVersion: 2, schemaVersion: 'reservation-prefill.v0.2',
    workItemId: '00000000-0000-4000-8000-000000000001', transportId: source.mailboxId, propertyCode: 'HRCEN',
    source: { threadId: source.threadId, messageId: source.messageId, sourceHash: source.sourceHash, arrivedAt: source.arrivedAt },
    generationId, revision: 4, status: 'ready', proposal: { schemaVersion: 'reservation-prefill.v0.2',
      content: { requests: [{ id: 'request-1', requestText: 'Book', sourceRefs: [], serviceRefs: [], documentRefs: [],
        kind: 'create', body: { shared: {}, dateSections: [], allocations: [{ id: 'room-1', dateSectionId: 'date-1',
          overrides: {}, guest: { firstName: 'Alex', lastName: 'Example', email: null, mobile: null,
            profileIntent: 'existing_or_unknown', candidateRefs: [], suggestedRef: null },
          occupancy: { adults: 1, childCount: 0, childAges: [] }, priceObservationRefs: [] }] } }],
        services: [], documents: [] }, annotations: [], issues: [], sourceClaims: [], lookupResultRefs: [] },
    observations: [], fieldReviewRequirements: {}, staffReviews: {}, operationResults: [], fieldOverrides: {}, errors: [] };
  const view = { requestId: 'request-1', allocationId: 'room-1', current: true, preparedRef, expectedRevision: 4, generationId };
  const state = (preparationView: Record<string, unknown>) => ({ status: 'ok', draft, revision: 4, revisionHead: 4,
    seq: 9, preparationViews: [preparationView] });
  function api(preparationView: Record<string, unknown>) {
    const get = vi.fn().mockResolvedValue(state(preparationView));
    const execute = vi.fn().mockResolvedValue({ status: 'queued', preparedRef, expectedRevision: 4, grantId, runId, operationId: grantId });
    const trpc = { reservationWorkflowV2: { ensure: { mutate: vi.fn().mockResolvedValue(state(preparationView)) },
      get: { query: get }, execute: { mutate: execute } } } as unknown as ReservationWorkflowV2TrpcClient;
    return { client: createTrpcReservationWorkflowClient(trpc), get, execute };
  }

  it('sends the durable receipt and keeps a queued write pending', async () => {
    const { client, execute } = api(view);
    const snapshot = await client.ensure({ source });
    const next = await client.execute({ source, snapshot, requestId: 'request-1', idempotencyKey: attemptId });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ preparedRef, expectedRevision: 4, expectedSeq: 9,
      requestId: 'request-1' }), expect.anything());
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('allocationId');
    expect(next.preparationViews[0]?.dispatch).toMatchObject({ status: 'queued', grantId, runId });
    expect(next.operationResults).toEqual([]);
  });

  it('does not approve an observation reference or a stale receipt', async () => {
    for (const bad of [{ ...view, preparedRef: 'observation-ref' }, { ...view, expectedRevision: 3 },
      { ...view, generationId: '00000000-0000-4000-8000-000000000006' }]) {
      const { client, execute } = api(bad);
      const snapshot = await client.ensure({ source });
      await expect(client.execute({ source, snapshot, requestId: 'request-1', idempotencyKey: attemptId }))
        .rejects.toThrow('Check the current details');
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('uses one shared approval for both rooms and rejects mismatched receipts', async () => {
    const { client, get, execute } = api(view);
    const secondRoom = { ...draft.proposal.content.requests[0]!.body.allocations[0]!, id: 'room-2' };
    const batch = { ...draft, proposal: { ...draft.proposal, content: { ...draft.proposal.content,
      requests: [{ ...draft.proposal.content.requests[0]!, body: { ...draft.proposal.content.requests[0]!.body,
        allocations: [draft.proposal.content.requests[0]!.body.allocations[0]!, secondRoom] } }] } } };
    get.mockResolvedValue({ ...state(view), draft: batch, preparationViews: [view, { ...view, allocationId: 'room-2' }] });
    const snapshot = await client.ensure({ source });
    const next = await client.execute({ source, snapshot, requestId: 'request-1', idempotencyKey: attemptId });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('allocationId');
    expect(next.preparationViews.map(row => row.dispatch?.status)).toEqual(['queued', 'queued']);

    get.mockResolvedValue({ ...state(view), draft: batch, preparationViews: [view, { ...view, allocationId: 'room-2',
      preparedRef: '00000000-0000-4000-8000-000000000008' }] });
    const mismatch = await client.ensure({ source });
    await expect(client.execute({ source, snapshot: mismatch, requestId: 'request-1', idempotencyKey: attemptId }))
      .rejects.toThrow('Check the current details');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('holds a missing worker run for reconciliation after reopening', async () => {
    const { client } = api({ ...view, current: false, dispatch: { status: 'needs_reconcile', requestId: view.requestId,
      allocationId: view.allocationId, grantId, operationId: grantId, runId: null } });
    const snapshot = await client.ensure({ source });
    expect(snapshot.preparationViews[0]?.dispatch).toMatchObject({ status: 'needs_reconcile', runId: null, grantId });
    await expect(client.execute({ source, snapshot, requestId: 'request-1', idempotencyKey: attemptId }))
      .rejects.toThrow('still being checked');
  });

  it('sends the durable guest approval separately from the observation reference', async () => {
    const get = vi.fn().mockResolvedValue({ ...state(view), workflowDispatches: [{ endpoint: 'createGuestProfile',
      requestId: 'request-1', allocationId: 'room-1', status: 'queued', runId, grantId, operationId: grantId }] });
    const create = vi.fn().mockResolvedValue({ status: 'queued', preparedRef, expectedRevision: 4, runId, grantId, operationId: grantId });
    const trpc = { reservationWorkflowV2: { ensure: { mutate: vi.fn().mockResolvedValue(state(view)) },
      get: { query: get }, createGuestProfile: { mutate: create } } } as unknown as ReservationWorkflowV2TrpcClient;
    const client = createTrpcReservationWorkflowClient(trpc);
    const snapshot = await client.ensure({ source });
    const next = await client.createGuestProfile({ source, snapshot, requestId: 'request-1', allocationId: 'room-1',
      prepareRef: 'profile-observation', preparedRef, idempotencyKey: attemptId });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ prepareRef: 'profile-observation', preparedRef,
      expectedRevision: 4, expectedSeq: 9 }), expect.anything());
    expect(next.serviceNotice).toBeUndefined();
    expect(next.session.workflowDispatches?.[0]).toMatchObject({ status: 'queued', operationId: grantId });
  });

  it('uses the current target-bound amendment receipt', async () => {
    const { client, get, execute } = api(view);
    const amend = { ...draft, proposal: { ...draft.proposal, content: { ...draft.proposal.content,
      requests: [{ id: 'request-1', requestText: 'Amend', sourceRefs: [], serviceRefs: [], documentRefs: [],
        kind: 'amend', body: { targets: { mode: 'explicit', include: [], exclude: [], sourceRefs: [] },
          sharedChanges: [], perTarget: [] } }] } } };
    const preparation = { endpoint: 'execute', requestId: 'request-1', allocationId: 'target-1',
      preparedRef, expectedRevision: 4, generationId };
    get.mockResolvedValue({ ...state(view), draft: amend, preparationViews: [], workflowPreparations: [preparation] });
    const snapshot = await client.ensure({ source });
    const next = await client.execute({ source, snapshot, requestId: 'request-1', allocationId: 'target-1', idempotencyKey: attemptId });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ preparedRef, allocationId: 'target-1' }), expect.anything());
    expect(next.session.workflowDispatches?.[0]).toMatchObject({ status: 'queued', grantId });
    await expect(client.execute({ source, snapshot, requestId: 'request-1', allocationId: 'target-2', idempotencyKey: attemptId }))
      .rejects.toThrow('Check the current details');
  });

  it('prepares the reviewed Add-On and sends its target-bound receipt', async () => {
    const targetRef = { kind: 'saved_target' as const, requestId: 'request-1', hintId: 'target-1' };
    const preparation = { endpoint: 'executeSavedServices', requestId: 'request-1', serviceId: 'service-1', targetRef,
      reviewedPrepareRef: 'reviewed-observation', preparedRef, expectedRevision: 4, generationId };
    const get = vi.fn().mockResolvedValueOnce(state(view)).mockResolvedValue({ ...state(view), workflowPreparations: [preparation] });
    const prepareServices = vi.fn().mockResolvedValue({ status: 'prepared' });
    const executeServices = vi.fn().mockResolvedValue({ status: 'queued', preparedRef, expectedRevision: 4, runId, grantId, operationId: grantId });
    const trpc = { reservationWorkflowV2: { ensure: { mutate: vi.fn().mockResolvedValue(state(view)) }, get: { query: get },
      prepareServices: { mutate: prepareServices }, executeServices: { mutate: executeServices } } } as unknown as ReservationWorkflowV2TrpcClient;
    const client = createTrpcReservationWorkflowClient(trpc);
    const snapshot = await client.ensure({ source });
    const next = await client.executeServices({ source, snapshot, requestId: 'request-1', targetRef, serviceId: 'service-1',
      reviewedPrepareRef: 'reviewed-observation', idempotencyKey: attemptId });
    expect(prepareServices).toHaveBeenCalledWith(expect.objectContaining({ targetRef, reviewedPrepareRef: 'reviewed-observation' }), expect.anything());
    expect(executeServices).toHaveBeenCalledWith(expect.objectContaining({ targetRef, reviewedPrepareRef: 'reviewed-observation', preparedRef }), expect.anything());
    expect(next.session.workflowDispatches?.[0]).toMatchObject({ status: 'queued', grantId });
  });
});
