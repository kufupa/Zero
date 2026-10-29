import { describe, expect, it } from 'vitest';
import {
  groupsForQuoteStep,
  initialQuoteSession,
  partyLookupWaitReason,
  quotePartySourceTransition,
  quoteRunBlockReason,
  ratedStayCount,
  reduceQuoteSession,
  requestedQuoteKeys,
} from '../lib/quote-workflow/session';
import { bindExecuteStaffQuote, type ExecuteStaffQuoteResult } from '../lib/quote-workflow/staff-quote-bind';
import {
  HRCEN_PROPERTY_CODE,
  type QuoteSession,
  type StaffQuoteHeader,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';

// AE1 live proof (ae1-rates-20261011T023109Z): a quote with two date options, each with two rows (STQN 1 adult,
// STWN 2 adults). Stay 1's run succeeded on the server, but the pane still said "0 of 2 stays rated".
const BINDING = {
  transportId: 't1',
  mailboxEmail: 'centurion@legacyhotels.co.za',
  storeId: 'store',
  folderEntryId: 'inbox',
  entryId: 'e1',
  selectionEpoch: 1,
  scopeEpoch: 1,
};
const SOURCE = { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) };
const A = { key: '2027-10-26:2027-10-28', arrival: '2027-10-26', departure: '2027-10-28' };
const B = { key: '2027-11-17:2027-11-19', arrival: '2027-11-17', departure: '2027-11-19' };
/** What the auto party lookup's pick sends: StaffPartyFields onPick -> onPatch({ parties, company }). */
const PICK: Partial<StaffQuoteHeader> = {
  company: 'Acme Travel',
  parties: { company: { kind: 'company', nativeId: 'hms-1', name: 'Acme Travel' } },
};

function row(
  id: string,
  stay: { arrival: string; departure: string },
  roomCode: string,
  adults: number,
): StayGroupRequirement {
  return {
    id,
    arrivalDate: stay.arrival,
    departureDate: stay.departure,
    quantity: 30,
    roomPreference: roomCode,
    adults,
    childrenPerRoom: 0,
    childrenAges: [],
    board: 'bb',
    specialRequests: [],
    fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted', roomPreference: 'staff_corrected' },
  };
}

function aeSession(): QuoteSession {
  let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: BINDING });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: {
      intent: 'quote',
      groups: [
        row('a-stqn', A, 'STQN', 1),
        row('a-stwn', A, 'STWN', 2),
        row('b-stqn', B, 'STQN', 1),
        row('b-stwn', B, 'STWN', 2),
      ],
      secondaryAsks: [],
      alternatives: [],
    },
  });
  session = reduceQuoteSession(session, { type: 'staff_source_ready', source: SOURCE });
  return reduceQuoteSession(session, { type: 'patch_staff_header', header: { salesStrategy: 'BAR' } });
}

/** The success body workstation.executeStaffQuote returns (summary() in workstation.ts), for the stay the run was for. */
function serverSummary(input: { inputRevision: number; stay: typeof A; totalMinor: number }): ExecuteStaffQuoteResult {
  return {
    status: 'ready',
    workflowRunId: '1e6c9d25-0000-4000-8000-000000000001',
    revisionRef: `quote:${'c'.repeat(64)}`,
    messageId: 'mail-1',
    threadId: 'thread-1',
    factRefs: [],
    extrasReviewItems: [],
    rateOptions: [],
    selectionEpoch: 1,
    inputRevision: input.inputRevision,
    inputDigest: 'd'.repeat(64),
    totalMinor: input.totalMinor,
    currency: 'ZAR',
    arrivalDate: input.stay.arrival,
    departureDate: input.stay.departure,
    description: 'Queen · 1 adult per room · Bed & Breakfast; Twin · 2 adults per room · Bed & Breakfast',
    runId: '2026-10-11T02-32-38',
    screenshots: [],
    rowRates: [],
  };
}

/** runQuoteStep for one stay, as nava-pane.tsx does it: step_running, the bind, then staff_quote_ready on success. */
async function runStay(
  session: QuoteSession,
  stay: typeof A,
  mutate: () => Promise<ExecuteStaffQuoteResult>,
): Promise<{ session: QuoteSession; status: string }> {
  const step = session.steps.find((item) => item.shareKey === stay.key);
  if (!step) throw new Error(`no step for ${stay.key}`);
  let next = reduceQuoteSession(session, { type: 'step_running', stepId: step.id });
  const selectionEpoch = session.binding?.selectionEpoch ?? 0;
  const inputRevision = session.inputRevision;
  const stayGroups = groupsForQuoteStep(session, step);
  const remote = await bindExecuteStaffQuote({
    mutate,
    source: SOURCE,
    propertyCode: HRCEN_PROPERTY_CODE,
    selectionEpoch,
    inputRevision,
    groups: stayGroups,
    header: session.staffHeader,
    stayKey: stay.key,
  });
  if (remote.status !== 'ok') {
    return { session: reduceQuoteSession(next, { type: 'results_unavailable', stepId: step.id, reason: remote.reason, selectionEpoch, inputRevision }), status: remote.reason };
  }
  next = reduceQuoteSession(next, {
    type: 'staff_quote_ready',
    offer: remote.offer,
    staffQuote: remote.staffQuote,
    selectionEpoch,
    inputRevision,
    extrasReviewItems: remote.extrasReviewItems,
    approvedHeader: session.staffHeader,
  });
  return { session: next, status: 'ok' };
}

describe('AE1 multi-stay: a succeeded stay run counts as rated', () => {
  it('requires party review if a failed save exposes a source change during a local edit', () => {
    const original = { key: 'mail', party: 'old-source', extraction: 'ex-1' };
    const changed = { ...original, party: 'new-source' };
    expect(quotePartySourceTransition(original, changed, true, false, true)).toBe('defer');
    expect(quotePartySourceTransition(original, changed, true, true, true)).toBe('review');
    expect(quotePartySourceTransition(changed, changed, false, true, true)).toBe('none');
    const picked = reduceQuoteSession(aeSession(), { type: 'patch_staff_header', header: PICK });
    const held = reduceQuoteSession(picked, { type: 'quote_source_changed',
      sourceParty: { agency: null, company: 'New Company' } });
    expect(held.staffHeader.parties).toBeUndefined();
    expect(partyLookupWaitReason(held)).toMatch(/select or clear/i);
  });

  it('holds an old auto-picked HMS party when the saved source changes until staff chooses again', () => {
    const picked = reduceQuoteSession(aeSession(), { type: 'patch_staff_header', header: PICK });
    const oldEpoch = picked.sourcePartyEpoch ?? 0;
    const changed = reduceQuoteSession(picked, { type: 'quote_source_changed',
      sourceParty: { agency: null, company: 'New Company' } });
    expect(changed.staffHeader.parties).toBeUndefined();
    expect(changed.staffHeader.company).toBe('New Company');
    expect(changed.sourcePartyReview).toEqual(['company']);
    expect(changed.sourcePartyAutoPickDisabled).toBe(true);
    expect(partyLookupWaitReason(changed)).toMatch(/select or clear/i);
    // An automatic lookup started against the old source cannot reapply its pick or clear the review.
    expect(reduceQuoteSession(changed, { type: 'patch_staff_header', header: PICK, sourcePartyEpoch: oldEpoch })).toBe(changed);
    expect(reduceQuoteSession(changed, { type: 'quote_party_reviewed', kind: 'company', sourcePartyEpoch: oldEpoch })).toBe(changed);
    const newPick = { ...PICK, company: 'New Company',
      parties: { company: { kind: 'company' as const, nativeId: 'hms-2', name: 'New Company' } } };
    const selected = reduceQuoteSession(changed, { type: 'patch_staff_header', header: newPick,
      sourcePartyEpoch: changed.sourcePartyEpoch });
    const reviewed = reduceQuoteSession(selected, { type: 'quote_party_reviewed', kind: 'company',
      sourcePartyEpoch: changed.sourcePartyEpoch! });
    expect(reviewed.staffHeader.parties?.company?.nativeId).toBe('hms-2');
    expect(partyLookupWaitReason(reviewed)).toBeNull();
    const edited = reduceQuoteSession(reviewed, { type: 'patch_staff_header', header: { notes: 'same source' },
      sourcePartyEpoch: reviewed.sourcePartyEpoch });
    expect(edited.staffHeader.parties?.company?.nativeId).toBe('hms-2');
  });

  it('keeps the changed-source party hold when the Centurion catalogue arrives late', () => {
    const picked = reduceQuoteSession(aeSession(), { type: 'patch_staff_header', header: PICK });
    const held = reduceQuoteSession(picked, { type: 'quote_source_changed',
      sourceParty: { agency: null, company: 'New Company' } });
    const configured = reduceQuoteSession(held, { type: 'quote_property_configured', propertyCode: HRCEN_PROPERTY_CODE });
    expect(configured.staffHeader.salesStrategy).toBe('BAR');
    expect(configured.staffHeader.parties).toBeUndefined();
    expect(configured.sourcePartyReview).toEqual(['company']);
    expect(configured.sourcePartyAutoPickDisabled).toBe(true);
    expect(reduceQuoteSession(configured, { type: 'patch_staff_header', header: PICK,
      sourcePartyEpoch: picked.sourcePartyEpoch ?? 0 })).toBe(configured);
    const next = reduceQuoteSession(configured, { type: 'selection',
      binding: { ...BINDING, entryId: 'next', selectionEpoch: 2 } });
    expect(next.staffHeader.parties).toBeUndefined();
    expect(next.sourcePartyReview ?? []).toEqual([]);
  });

  it('clears visible quote results when the saved source changes', async () => {
    const session = aeSession();
    const { session: priced } = await runStay(session, A, async () =>
      serverSummary({ inputRevision: session.inputRevision, stay: A, totalMinor: 24720000 }));
    expect(ratedStayCount(priced).rated).toBe(1);
    const refreshed = reduceQuoteSession(priced, { type: 'quote_source_changed' });
    expect(refreshed.inputRevision).toBe(priced.inputRevision + 1);
    expect(ratedStayCount(refreshed).rated).toBe(0);
    expect(refreshed.staffQuotes).toEqual({});
    expect(refreshed.pdf).toBeNull();
  });

  it('stay 1 run with the server summary shape is rated: "1 of 2 stays rated"', async () => {
    const session = aeSession();
    expect(requestedQuoteKeys(session.groups)).toEqual([A.key, B.key]);
    const inputRevision = session.inputRevision;
    const { session: after, status } = await runStay(session, A, async () =>
      serverSummary({ inputRevision, stay: A, totalMinor: 24720000 }),
    );
    expect(status).toBe('ok');
    expect(Object.keys(after.staffQuotes)).toEqual([A.key]);
    expect(ratedStayCount(after)).toEqual({ rated: 1, total: 2 });
  });

  it('a pick landing mid-run drops stay 1 result: not rated, step ready again', async () => {
    const session = aeSession();
    const step = session.steps.find((item) => item.shareKey === A.key);
    if (!step) throw new Error(`no step for ${A.key}`);
    const selectionEpoch = session.binding?.selectionEpoch ?? 0;
    const inputRevision = session.inputRevision;
    const groups = groupsForQuoteStep(session, step);
    // The run goes out with no party (partyChecks 0 in the live run). The auto lookup's pick lands while it is in flight.
    const running = reduceQuoteSession(session, { type: 'step_running', stepId: step.id });
    const remote = await bindExecuteStaffQuote({
      mutate: async () => serverSummary({ inputRevision, stay: A, totalMinor: 24720000 }),
      source: SOURCE,
      propertyCode: HRCEN_PROPERTY_CODE,
      selectionEpoch,
      inputRevision,
      groups,
      header: session.staffHeader,
      stayKey: A.key,
    });
    expect(remote.status).toBe('ok');
    if (remote.status !== 'ok') return;
    const picked = reduceQuoteSession(running, { type: 'patch_staff_header', header: PICK });
    const after = reduceQuoteSession(picked, {
      type: 'staff_quote_ready',
      offer: remote.offer,
      staffQuote: remote.staffQuote,
      selectionEpoch,
      inputRevision,
      extrasReviewItems: remote.extrasReviewItems,
      approvedHeader: session.staffHeader,
    });
    expect(Object.keys(after.staffQuotes)).toEqual([]);
    expect(ratedStayCount(after)).toEqual({ rated: 0, total: 2 });
    expect(after.steps.find((item) => item.shareKey === A.key)?.status).toBe('ready');
  });

  it('a pick made before stay 1 is sent keeps its result: stay 1 is rated', async () => {
    const picked = reduceQuoteSession(aeSession(), { type: 'patch_staff_header', header: PICK });
    const inputRevision = picked.inputRevision;
    const { session: after, status } = await runStay(picked, A, async () =>
      serverSummary({ inputRevision, stay: A, totalMinor: 24720000 }),
    );
    expect(status).toBe('ok');
    expect(ratedStayCount(after)).toEqual({ rated: 1, total: 2 });
  });
});

describe('AE1 multi-stay: a run waits for the party lookup', () => {
  it('holds every run with the lookup copy while the company search is pending, and changes no revision', () => {
    const session = aeSession();
    const stayA = session.steps.find((step) => step.shareKey === A.key);
    if (!stayA) throw new Error(`no step for ${A.key}`);
    const pending = reduceQuoteSession(session, { type: 'party_lookup_pending', kind: 'company', pending: true });
    expect(pending.inputRevision).toBe(session.inputRevision);
    expect(quoteRunBlockReason(pending, stayA)).toBe('Finding the company in HMS…');
    const settled = reduceQuoteSession(pending, { type: 'party_lookup_pending', kind: 'company', pending: false });
    expect(quoteRunBlockReason(settled, stayA)).toBeNull();
    // A report that changes nothing returns the same session, so the pane does not re-render for it.
    expect(reduceQuoteSession(settled, { type: 'party_lookup_pending', kind: 'company', pending: false })).toBe(settled);
  });

  it('names both lookups while the company and the agency are both pending', () => {
    const company = reduceQuoteSession(aeSession(), { type: 'party_lookup_pending', kind: 'company', pending: true });
    const both = reduceQuoteSession(company, { type: 'party_lookup_pending', kind: 'agency', pending: true });
    expect(partyLookupWaitReason(both)).toBe('Finding the company and agency in HMS…');
    const agencyOnly = reduceQuoteSession(both, { type: 'party_lookup_pending', kind: 'company', pending: false });
    expect(partyLookupWaitReason(agencyOnly)).toBe('Finding the agency in HMS…');
  });
});
