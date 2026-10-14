import { describe, expect, it } from 'vitest';
import {
  canCreatePdf,
  evidenceMatchesSession,
  initialQuoteSession,
  reduceQuoteSession,
  staffQuoteForStay,
  staffQuoteMatchesSession,
  staffSourceReady,
} from '../lib/quote-workflow/session';
import { staffHeaderFieldProblem } from '../lib/quote-workflow/types';
import type { QuoteAnalysis, QuoteSession, QuoteSessionAction, StayGroupRequirement } from '../lib/quote-workflow/types';

const binding = {
  transportId: 't1',
  mailboxEmail: 'm@x',
  storeId: 'store',
  folderEntryId: 'inbox',
  entryId: 'e1',
  internetMessageId: '<a@x>',
  selectionEpoch: 1,
  scopeEpoch: 1,
};
const HASH = 'ab'.repeat(32);
const luna = (workflow: string) =>
  ({
    workflow,
    flags: [],
    groups: [],
    party: { kind: 'agency', name: 'Legacy Hotels', reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
  }) as never;

const otherRead: QuoteAnalysis = { intent: 'other', groups: [], secondaryAsks: [], alternatives: [], luna: luna('other') };
const blankGroup: StayGroupRequirement = {
  id: 'g1',
  childrenAges: [],
  board: 'unknown',
  specialRequests: [],
  fields: {},
} as StayGroupRequirement;
const quoteRead = (groups: StayGroupRequirement[]): QuoteAnalysis => ({
  intent: 'quote',
  groups,
  secondaryAsks: [],
  alternatives: [],
  luna: luna('quote'),
});

function conditions(s: QuoteSession) {
  return {
    fieldProblem: staffHeaderFieldProblem(s.staffHeader),
    sourceReady: staffSourceReady(s),
    evidenceMatches: evidenceMatchesSession(s),
    evidenceKind: s.evidence?.kind ?? null,
    hasStayQuote: Boolean(staffQuoteForStay(s)),
    quoteMatches: staffQuoteForStay(s) ? staffQuoteMatchesSession(s) : null,
    offers: s.offers.length,
    canCreatePdf: canCreatePdf(s),
    agency: s.staffHeader.agency,
    phase: s.phase,
    inputRevision: s.inputRevision,
  };
}

function run(s: QuoteSession, analysisGroups: StayGroupRequirement[]) {
  const r = (a: QuoteSessionAction) => (s = reduceQuoteSession(s, a));
  r({ type: 'selection', binding });
  r({ type: 'analysis_started' });
  r({ type: 'analysis_ready', analysis: otherRead });
  r({ type: 'staff_source_ready', source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: HASH } });
  r({ type: 'treat_as', treatAs: 'quote' });
  r({ type: 'analysis_started' });
  r({ type: 'analysis_ready', analysis: quoteRead(analysisGroups) });
  if (!s.groups.length) r({ type: 'add_stay', token: 't' });
  const gid = () => s.groups[0]!.id;
  r({ type: 'patch_group', groupId: gid(), patch: { arrivalDate: '2027-03-10', departureDate: '2027-03-11' } });
  r({ type: 'patch_group', groupId: gid(), patch: { roomCodes: ['STQN'], quantity: 1, adults: 2, board: 'bb' } });
  r({
    type: 'patch_group',
    groupId: gid(),
    patch: { rowPrice: { source: 'override', rateCode: 'NCOR1B', amountMinor: 185000, note: 'ok' } },
  });
  const step = s.steps.find((x) => x.kind === 'quote_stay')!;
  r({ type: 'step_running', stepId: step.id });
  const header = s.staffHeader;
  const inputRevision = s.inputRevision;
  const key = '2027-03-10:2027-03-11';
  r({
    type: 'staff_quote_ready',
    offer: {
      id: 'rev-1',
      kind: 'allocation',
      roomCode: '',
      roomLabel: 'x',
      board: 'bb',
      rateCode: '',
      currency: 'ZAR',
      nightly: [],
      stayTotalMinor: 185000,
      observedAt: '',
      sourceRef: 'rev-1',
      restrictions: [],
      combinable: true,
      quoteRequestKey: key,
      coversGroupIds: [gid()],
      quantity: 1,
    },
    staffQuote: {
      workflowRunId: 'run-1',
      revisionRef: 'rev-1',
      factRefs: [],
      messageId: 'mail-1',
      threadId: 'thread-1',
      sourceHash: HASH,
      selectionEpoch: 1,
      inputRevision,
      inputDigest: 'd',
      totalMinor: 185000,
      currency: 'ZAR',
      quoteRequestKey: key,
      approvedHeader: {
        salesStrategy: 'BAR',
        company: header.company.trim(),
        agency: header.agency.trim(),
        attention: '',
        clientEmail: '',
        clientTelephone: '',
      },
    },
    selectionEpoch: 1,
    inputRevision,
    approvedHeader: header,
  });
  return s;
}

function offerAndQuote(gid: string, inputRevision: number, header: QuoteSession['staffHeader']): QuoteSessionAction {
  const key = '2027-03-10:2027-03-11';
  return {
    type: 'staff_quote_ready',
    offer: { id: 'rev-1', kind: 'allocation', roomCode: '', roomLabel: 'x', board: 'bb', rateCode: '', currency: 'ZAR', nightly: [],
      stayTotalMinor: 185000, observedAt: '', sourceRef: 'rev-1', restrictions: [], combinable: true, quoteRequestKey: key,
      coversGroupIds: [gid], quantity: 1 },
    staffQuote: { workflowRunId: 'run-1', revisionRef: 'rev-1', factRefs: [], messageId: 'mail-1', threadId: 'thread-1', sourceHash: HASH,
      selectionEpoch: 1, inputRevision, inputDigest: 'd', totalMinor: 185000, currency: 'ZAR', quoteRequestKey: key,
      approvedHeader: { salesStrategy: 'BAR', company: header.company.trim(), agency: header.agency.trim(), attention: '', clientEmail: '', clientTelephone: '' } },
    selectionEpoch: 1,
    inputRevision,
    approvedHeader: header,
  };
}

/** The driver's real order: its "analysing" probe never matches the pane copy, so it types into the blank stay while the treat-as read runs. */
function driverOrder(readLandsAfterRun: boolean) {
  let s = initialQuoteSession();
  const r = (a: QuoteSessionAction) => (s = reduceQuoteSession(s, a));
  r({ type: 'selection', binding });
  r({ type: 'analysis_started' });
  r({ type: 'analysis_ready', analysis: otherRead });
  r({ type: 'staff_source_ready', source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: HASH } });
  r({ type: 'treat_as', treatAs: 'quote' });
  r({ type: 'analysis_started' }); // live treat-as read in flight; panel shows draftStayGroup()
  const gid = 'draft-stay';
  r({ type: 'patch_group', groupId: gid, patch: { arrivalDate: '2027-03-10', departureDate: '2027-03-11' } });
  r({ type: 'patch_group', groupId: gid, patch: { roomCodes: ['STQN'], quantity: 1, adults: 2, board: 'bb' } });
  r({ type: 'patch_group', groupId: gid, patch: { rowPrice: { source: 'override', rateCode: 'NCOR1B', amountMinor: 185000, note: 'ok' } } });
  const step = s.steps.find((x) => x.kind === 'quote_stay')!;
  r({ type: 'step_running', stepId: step.id });
  const inputRevision = s.inputRevision;
  const header = s.staffHeader;
  console.log('before read lands', { phase: s.phase, inputRevision, groups: s.groups.map((g) => g.id) });
  if (readLandsAfterRun) {
    r(offerAndQuote(gid, inputRevision, header));
    console.log('after run lands (read still pending)', conditions(s));
    r({ type: 'analysis_ready', analysis: quoteRead([blankGroup]) });
  } else {
    r({ type: 'analysis_ready', analysis: quoteRead([blankGroup]) });
    console.log('after read lands mid-run', { ...conditions(s), runningStepId: s.runningStepId });
    r(offerAndQuote(gid, inputRevision, header));
  }
  console.log('final', conditions(s), s.groups.map((g) => ({ id: g.id, a: g.arrivalDate, price: g.rowPrice?.source })), s.steps.map((x) => x.status));
  return s;
}

describe('ae4 diag', () => {
  it('driver order: read lands after the run', () => {
    expect(canCreatePdf(driverOrder(true))).toBe(false);
  });
  it('driver order: read lands during the run', () => {
    expect(canCreatePdf(driverOrder(false))).toBe(false);
  });
  it('other read -> treat-as quote (blank group read) -> typed stay -> override -> run', () => {
    const s = run(initialQuoteSession(), [blankGroup]);
    console.log('blank-group read', conditions(s));
  });
  it('other read -> treat-as quote (no groups read) -> add stay -> override -> run', () => {
    const s = run(initialQuoteSession(), []);
    console.log('no-group read', conditions(s));
  });
});
