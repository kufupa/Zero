import { describe, expect, it } from 'vitest';
import { Blocker } from '../scripts/nava-ae4-override-proof';
import { staffQuoteFailureMessage } from '../src/ai/staff-quote-run.js';
import {
  chooseRoomType,
  classifyQuoteRequest,
  choosePartyCandidate,
  liveHmsCandidateFromText,
  openStayDateInputs,
  isNamedRefusal,
  namedRateRefusal,
  newQuoteGuardState,
  partyLookupAction,
  partyLookupsReady,
  queuedJobRefusal,
  QUOTE_SELECTORS,
  rateKeysForDateRanges,
  rateSearchAction,
  shouldRetryObservedRateSearch,
  rateWaitBudget,
  quoteThreadFailure,
  quoteProofPass,
  requiredQuoteEdits,
  withPiiMask,
} from '../scripts/nava-quote-proof';

const result = (outcome: string | null, blocker: string | null = null) => ({
  rates: { outcome, seconds: outcome === null ? null : 1, cards: outcome === 'priced' ? 2 : 0 },
  blocker,
});

const tRPC = (procedure: string) => `https://nava.example.test/api/trpc/${procedure}?batch=1`;
const batch = (input: unknown) => JSON.stringify({ 0: { json: input } });

describe('quote proof scoring', () => {
  it('passes a priced thread and a thread with a named refusal', () => {
    expect(isNamedRefusal('refused: No rooms are available for those dates.')).toBe(true);
    expect(quoteProofPass([result('priced'), result('refused: No rooms are available for those dates.')])).toBe(true);
  });

  it('does not score unnamed refusals, timeouts, non-quotes, or missing input as a pass', () => {
    expect(isNamedRefusal('refused:')).toBe(false);
    expect(isNamedRefusal('refused: refused')).toBe(false);
    expect(quoteProofPass([result('timeout')])).toBe(false);
    expect(quoteProofPass([result(null, 'not_quote')])).toBe(false);
    expect(quoteProofPass([result(null, 'needs_edits:dates,rooms')])).toBe(false);
  });

  it('fails if any thread crashed, even if another thread was priced', () => {
    expect(quoteProofPass([result('priced'), result('priced', 'crashed: browser closed')])).toBe(false);
  });

  it('does not let an empty batch pass', () => {
    expect(quoteProofPass([])).toBe(false);
  });

  it('keeps fields already read when a later proof step fails', () => {
    const proof = {
      threadId: 'thread-a',
      kind: 'quote',
      prefilled: {
        contact: { name: 'Ada Guest', email: 'ada@example.test' },
        stays: [],
        ratePlan: 'BAR',
      },
      party: {
        suggested: [{ kind: 'company' as const, name: 'Centurion Travel', source: 'hms_list' as const }],
        accepted: [{ kind: 'company' as const, name: 'Centurion Travel', source: 'hms_list' as const }],
        prefetched: true,
      },
      rates: { outcome: 'priced', seconds: 42, cards: 2 },
      docs: { pdfBytes: null, xlsxBytes: null },
      edits: [],
      blocker: null,
    };

    expect(quoteThreadFailure(proof, new Blocker('the Documents step is missing'))).toEqual({
      ...proof,
      blocker: 'the Documents step is missing',
    });
  });

  it('only treats the pane’s explicit HMS search refusals as named refusals', () => {
    expect(namedRateRefusal('HMS refused the search: No rate matches this meal plan under the selected rate plan.')).toBe(
      'refused: No rate matches this meal plan under the selected rate plan.',
    );
    expect(namedRateRefusal('HMS has only 1 room available.')).toBe('refused: HMS has only 1 room available.');
    expect(namedRateRefusal('borrowed CDP required')).toBeNull();
    expect(namedRateRefusal('The request did not finish. Refresh the pane and try again.')).toBeNull();
  });
});

describe('quote proof input review', () => {
  const prefilled = {
    contact: { name: 'Ada Guest', email: 'ada@example.test' },
    stays: [
      {
        stay: 1,
        arrival: '2026-11-02',
        departure: '2026-11-04',
        rooms: [{ room: 1, type: 'Double', rooms: 1, adults: 2 }],
        mealPlan: 'All meal plans',
        mealPlanMissing: false,
      },
    ],
    ratePlan: 'All rates',
  };

  it('keeps an all-meal-plans display filter distinct from a missing requested meal plan', () => {
    expect(requiredQuoteEdits(prefilled)).toEqual([]);
    expect(
      requiredQuoteEdits({
        ...prefilled,
        stays: [{ ...prefilled.stays[0]!, mealPlanMissing: true }],
      }),
    ).toContain('stay1.mealPlan');
  });

  it('reports empty required dates and room inputs without filling them', () => {
    expect(
      requiredQuoteEdits({
        ...prefilled,
        stays: [
          {
            ...prefilled.stays[0]!,
            arrival: null,
            departure: null,
            rooms: [{ room: 1, type: null, rooms: null, adults: null }],
          },
        ],
      }),
    ).toEqual(['stay1.arrival', 'stay1.departure', 'stay1.room1.type', 'stay1.room1.rooms', 'stay1.room1.adults']);
  });
});

describe('quote proof interaction helpers', () => {
  it('targets display-first contact values and current quote section names and room labels', () => {
    expect(QUOTE_SELECTORS.intent).toBe('[data-preview-pane] [data-read-as]');
    expect(QUOTE_SELECTORS.contactRegion).toBe('Quote contact — printed on the PDF');
    expect(QUOTE_SELECTORS.contactNameValue).toBe('[data-contact-field="name"] dd > span');
    expect(QUOTE_SELECTORS.contactEmailValue).toBe('[data-contact-field="email"] dd > span');
    expect(QUOTE_SELECTORS.stayRegion).toBe('Stay');
    expect(QUOTE_SELECTORS.ratesRegion).toBe('Availability & rates');
    expect(QUOTE_SELECTORS.docsRegion).toBe('Documents');
    expect(QUOTE_SELECTORS.roomRow.test('Standard Queen ×2')).toBe(true);
    expect(QUOTE_SELECTORS.roomRow.test('Room type needed ×1')).toBe(true);
    expect(QUOTE_SELECTORS.roomRow.test('Room 1')).toBe(false);
  });

  it('opens each stay date disclosure before exposing its native date inputs', async () => {
    const datesVisible = { Arrival: false, Departure: false };
    let clicks = 0;
    const waits = { Arrival: 0, Departure: 0 };
    const stay = {
      getByLabel: (name: 'Arrival' | 'Departure') => ({
        isVisible: async () => datesVisible[name],
        waitFor: async () => {
          waits[name] += 1;
          expect(datesVisible[name]).toBe(true);
        },
      }),
      getByRole: (_role: string, options: { name: string }) => ({
        click: async () => {
          expect(options.name).toBe('Change dates');
          clicks += 1;
          datesVisible.Arrival = true;
          datesVisible.Departure = true;
        },
      }),
    } as unknown as Parameters<typeof openStayDateInputs>[0];

    await openStayDateInputs(stay);

    expect(clicks).toBe(1);
    expect(waits).toEqual({ Arrival: 1, Departure: 1 });
  });

  it('accepts only a unique candidate or one exact match among alternatives', () => {
    const sole = { name: 'Centurion Travel', source: 'live_hms' as const };
    const exact = { name: 'Centurion Travel', source: 'hms_list' as const };
    const other = { name: 'Centurion Travel Group', source: 'live_hms' as const };

    expect(choosePartyCandidate([sole], 'Different query')).toBe(sole);
    expect(choosePartyCandidate([other, exact], 'centurion travel')).toBe(exact);
    expect(choosePartyCandidate([sole, exact], 'centurion travel')).toBeNull();
    expect(choosePartyCandidate([sole, other], 'Centurion')).toBeNull();
  });

  it('records live HMS chips only when their name and native id are present', () => {
    expect(liveHmsCandidateFromText('company', 'Centurion Travel (#CT-42)')).toEqual({
      kind: 'company',
      name: 'Centurion Travel',
      source: 'live_hms',
      nativeId: 'CT-42',
    });
    expect(liveHmsCandidateFromText('agency', 'Centurion Travel')).toBeNull();
  });

  it('does not call party lookup settled before the auto/index debounces can complete', () => {
    expect(
      partyLookupsReady({
        pending: false,
        readBackPending: false,
        autoLookupExpected: true,
        autoLookupStarted: false,
        autoLookupComplete: false,
        autoStartGraceElapsed: false,
        indexLookupExpected: true,
        indexRequestStarted: false,
        indexResponseComplete: false,
        indexStartGraceElapsed: false,
      }),
    ).toBe(false);
    expect(
      partyLookupsReady({
        pending: false,
        readBackPending: false,
        autoLookupExpected: true,
        autoLookupStarted: true,
        autoLookupComplete: true,
        autoStartGraceElapsed: true,
        indexLookupExpected: true,
        indexRequestStarted: true,
        indexResponseComplete: false,
        indexStartGraceElapsed: true,
      }),
    ).toBe(false);
    expect(
      partyLookupsReady({
        pending: false,
        readBackPending: false,
        autoLookupExpected: true,
        autoLookupStarted: true,
        autoLookupComplete: true,
        autoStartGraceElapsed: true,
        indexLookupExpected: true,
        indexRequestStarted: false,
        indexResponseComplete: false,
        indexStartGraceElapsed: true,
      }),
    ).toBe(true);

    expect(
      partyLookupsReady({
        pending: false,
        readBackPending: false,
        autoLookupExpected: true,
        autoLookupStarted: false,
        autoLookupComplete: false,
        autoStartGraceElapsed: true,
        indexLookupExpected: true,
        indexRequestStarted: false,
        indexResponseComplete: false,
        indexStartGraceElapsed: true,
      }),
    ).toBe(true);

    expect(
      partyLookupsReady({
        pending: false,
        readBackPending: true,
        autoLookupExpected: true,
        autoLookupComplete: false,
        autoLookupStarted: false,
        autoStartGraceElapsed: true,
        indexLookupExpected: false,
        indexRequestStarted: false,
        indexResponseComplete: false,
        indexStartGraceElapsed: true,
      }),
    ).toBe(false);

    expect(
      partyLookupsReady({
        pending: false,
        readBackPending: false,
        autoLookupExpected: true,
        autoLookupComplete: false,
        autoLookupStarted: true,
        autoStartGraceElapsed: true,
        indexLookupExpected: false,
        indexRequestStarted: false,
        indexResponseComplete: false,
        indexStartGraceElapsed: true,
      }),
    ).toBe(false);
  });

  it('uses Confirm when offered, otherwise searches once after empty read-back settles', () => {
    const idle = {
      query: 'Centurion Travel',
      selected: false,
      pending: false,
      readBackPending: false,
      hasConfirm: false,
      hasResults: false,
      searchStarted: false,
      searchComplete: false,
      attempted: false,
      findEnabled: true,
    };

    expect(partyLookupAction({ ...idle, readBackPending: true, startGraceElapsed: true })).toBe('wait');
    expect(partyLookupAction({ ...idle, startGraceElapsed: false })).toBe('wait');
    expect(partyLookupAction({ ...idle, startGraceElapsed: true })).toBe('search');
    expect(partyLookupAction({ ...idle, hasConfirm: true, startGraceElapsed: true })).toBe('ready');
    expect(partyLookupAction({ ...idle, searchStarted: true, startGraceElapsed: true })).toBe('wait');
    expect(partyLookupAction({ ...idle, searchComplete: true, startGraceElapsed: true })).toBe('ready');
    expect(partyLookupAction({ ...idle, attempted: true, startGraceElapsed: true })).toBe('ready');
  });

  it('caps each rate wait by the shared deadline', () => {
    expect(rateWaitBudget(10_000, 0, 30_000)).toBe(10_000);
    expect(rateWaitBudget(10_000, 9_500, 30_000)).toBe(500);
    expect(rateWaitBudget(10_000, 10_000, 30_000)).toBe(0);
  });

  it('skips the screenshot callback if PII marking fails', async () => {
    let screenshots = 0;
    await expect(
      withPiiMask(
        async () => {
          throw new Error('page detached');
        },
        async () => {
          screenshots += 1;
        },
      ),
    ).rejects.toThrow('PII masking failed; screenshot skipped');
    expect(screenshots).toBe(0);
  });
});

describe('quote proof request guard', () => {
  it('allows one staff quote read per known stay, but never a duplicate', () => {
    const state = newQuoteGuardState(['2026-11-02:2026-11-04']);
    const input = batch({ groups: [{ arrivalDate: '2026-11-02', departureDate: '2026-11-04' }] });
    expect(classifyQuoteRequest(tRPC('workstation.executeStaffQuote'), input, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('workstation.executeStaffQuote'), input, state).allowed).toBe(false);
  });

  it('allows read routes and quote documents, but blocks HMS writes, mail writes and unknown routes', () => {
    const state = newQuoteGuardState(['2026-11-02:2026-11-04']);
    expect(classifyQuoteRequest(tRPC('workstation.hmsQueueStatus'), null, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('workstation.quoteWorkbook'), null, state).allowed).toBe(true);
    for (const procedure of ['hmsApproval.approve', 'quoteWorkflow.commitStay', 'drafts.saveReply', 'unknown.call']) {
      expect(classifyQuoteRequest(tRPC(procedure), null, state).allowed, procedure).toBe(false);
    }
  });

  it('allows queued quote and party reads while retaining the per-stay and party-search limits', () => {
    const state = newQuoteGuardState(['2026-11-02:2026-11-04']);
    const quoteInput = batch({ groups: [{ arrivalDate: '2026-11-02', departureDate: '2026-11-04' }] });

    expect(classifyQuoteRequest(tRPC('workstation.queueStaffQuote'), quoteInput, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('workstation.staffQuoteJob'), null, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('paneStayLookup.jobStatus'), null, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('paneStayLookup.jobQueueEnabled'), null, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('workstation.executeStaffQuote'), quoteInput, state).allowed).toBe(false);

    expect(classifyQuoteRequest(tRPC('paneStayLookup.queueParty'), null, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('paneStayLookup.queueParty'), null, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('paneStayLookup.queueParty'), null, state).allowed).toBe(false);
    expect(classifyQuoteRequest(tRPC('paneStayLookup.queueFind'), null, state).allowed).toBe(false);
    expect(classifyQuoteRequest(tRPC('workstation.prepareBookingDraft'), null, state).allowed).toBe(false);
  });

  it('allows the queue-off Find fallback once per field without counting it as a second party search', () => {
    const state = newQuoteGuardState();
    const companyJob = batch({ threadId: 'thread-a', name: 'Centurion Travel', partyKind: 'company' });
    const companyInline = batch({ name: 'Centurion Travel', kind: 'company' });
    const agencyJob = batch({ threadId: 'thread-a', name: 'North Star', partyKind: 'agency' });
    const agencyInline = batch({ name: 'North Star', kind: 'agency' });

    expect(classifyQuoteRequest(tRPC('paneStayLookup.queueParty'), companyJob, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('panePartyLookup.findParty'), companyInline, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('paneStayLookup.queueParty'), agencyJob, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('panePartyLookup.findParty'), agencyInline, state).allowed).toBe(true);
    expect(classifyQuoteRequest(tRPC('paneStayLookup.queueParty'), companyJob, state).allowed).toBe(false);
    expect(state.partyLookups).toBe(2);
  });

  it('builds the rate allowlist from complete shown dates and observes already-started reads', () => {
    const [key] = rateKeysForDateRanges([
      { arrival: '2026-11-02', departure: '2026-11-04' },
      { arrival: '2026-11-02', departure: '2026-11-04' },
      { arrival: '2026-11-05', departure: null },
    ]);

    expect([...rateKeysForDateRanges([
      { arrival: '2026-11-02', departure: '2026-11-04' },
      { arrival: '2026-11-02', departure: '2026-11-04' },
      { arrival: '2026-11-05', departure: null },
    ])]).toEqual(['2026-11-02:2026-11-04']);
    expect(rateSearchAction(key!, [key!])).toBe('observe');
    expect(rateSearchAction(key!, [])).toBe('search');
  });

  it('waits through a continuous idle grace before retrying an observed rate search', () => {
    const idle = {
      buttonEnabled: true,
      pending: false,
      hasPricedCards: false,
      refusalShown: false,
      idleSinceMs: 1_000,
      nowMs: 10_999,
      graceMs: 10_000,
    };

    expect(shouldRetryObservedRateSearch({ ...idle, idleSinceMs: null })).toBe(false);
    expect(shouldRetryObservedRateSearch(idle)).toBe(false);
    expect(shouldRetryObservedRateSearch({ ...idle, nowMs: 11_000 })).toBe(true);
  });

  it('does not retry while rates are pending, priced, refused, or search is disabled', () => {
    const idle = {
      buttonEnabled: true,
      pending: false,
      hasPricedCards: false,
      refusalShown: false,
      idleSinceMs: 1_000,
      nowMs: 11_000,
      graceMs: 10_000,
    };

    expect(shouldRetryObservedRateSearch({ ...idle, buttonEnabled: false })).toBe(false);
    expect(shouldRetryObservedRateSearch({ ...idle, pending: true })).toBe(false);
    expect(shouldRetryObservedRateSearch({ ...idle, hasPricedCards: true })).toBe(false);
    expect(shouldRetryObservedRateSearch({ ...idle, refusalShown: true })).toBe(false);
  });

  it('only allows pane field events when NAVA_PROOF_ALLOW_EDITS is enabled', () => {
    const procedure = tRPC('workItems.recordEvent');
    const disabled = newQuoteGuardState();
    expect(classifyQuoteRequest(procedure, null, disabled).allowed).toBe(false);

    const enabled = newQuoteGuardState([], true);
    for (let edit = 0; edit < 4; edit += 1) {
      expect(classifyQuoteRequest(procedure, null, enabled).allowed).toBe(true);
    }
    expect(classifyQuoteRequest(procedure, null, enabled).allowed).toBe(false);
  });

  describe('chooseRoomType', () => {
    const options = [
      { value: '', label: 'Choose room type' },
      { value: 'Single', label: 'Email request' },
      { value: 'STWN', label: 'Standard Twin (STWN)' },
      { value: 'STQN', label: 'Standard Queen (STQN)' },
    ];

    it("takes the pane's first suggestion for what the email asked", () => {
      expect(chooseRoomType(true, ['STQN', 'STWN'], options)).toEqual({ value: 'STQN', how: 'suggested' });
    });

    it('leaves an asked type with no suggestion open rather than guess', () => {
      expect(chooseRoomType(true, [], options)).toBeNull();
    });

    it('takes the first listed HMS type when the email names none', () => {
      expect(chooseRoomType(false, [], options)).toEqual({ value: 'STWN', how: 'first_listed' });
    });
  });

  it('reads a queued staff quote refusal as a named refusal', () => {
    const message =
      'HMS has no rate for every night of this stay in this room and meal plan. Try another room type or meal plan, or split the dates, then search again.';
    expect(
      queuedJobRefusal({
        procedure: 'workstation.staffQuoteJob',
        data: { status: 'succeeded', result: { ok: false, code: 'PRECONDITION_FAILED', message } },
      }),
    ).toBe('refused: ' + message);
    expect(
      queuedJobRefusal({ procedure: 'workstation.staffQuoteJob', data: { status: 'running', result: null } }),
    ).toBeNull();
  });

  it('gives staff the next steps when no rate covers every night', () => {
    const error = Object.assign(new Error('business_selected_price_unavailable'), {
      code: 'business_selected_price_unavailable',
    });
    expect(staffQuoteFailureMessage(error)).toBe(
      'HMS has no rate for every night of this stay in this room and meal plan. Try another room type or meal plan, or split the dates, then search again.',
    );
  });
});

