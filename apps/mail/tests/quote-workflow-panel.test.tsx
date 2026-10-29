/**
 * @vitest-environment happy-dom
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { HmsJobNoticeBanner, HmsJobNoticeProvider } from '../components/quote-workflow/hms-job-notices';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { resetPartyAutoLookupForTests } from '../components/quote-workflow/party-picker';
import type { HmsJobRequest, HmsJobView } from '../lib/quote-workflow/amend-find';
import { fixtureResultsReady, loadQuoteFixture } from '../lib/quote-workflow/fixtures';
import { useHmsJobNoticeReporter } from '../lib/quote-workflow/hms-job-notice-context';
import { initialQuoteSession, reduceQuoteSession, stayKeyForGroup } from '../lib/quote-workflow/session';
import type {
  LunaAnalysisWire,
  QuotePaneConfig,
  QuoteSalesStrategy,
  QuoteStrategyRow,
  QuoteRoomAlternative,
  QuoteSession,
  RateOption,
  RatePlanCatalogueEntry,
  StayGroupRequirement,
} from '../lib/quote-workflow/types';
import { defaultStaffStayExtras, HRDAV_PROPERTY_CODE } from '../lib/quote-workflow/types';
import { CENTURION_RATE_PLANS } from '../../server-pilot/src/hms/rate-catalogue';

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));

afterEach(() => cleanup());

function sessionFromFixture(id: Parameters<typeof loadQuoteFixture>[0]): QuoteSession {
  const fixture = loadQuoteFixture(id);
  let session = reduceQuoteSession(initialQuoteSession(), {
    type: 'selection',
    binding: {
      transportId: 't1',
      mailboxEmail: 'centurion@legacyhotels.co.za',
      storeId: 'store',
      folderEntryId: 'inbox',
      entryId: 'e1',
      selectionEpoch: 1,
      scopeEpoch: 1,
    },
  });
  if (fixture.phase === 'missing_source') {
    return reduceQuoteSession(session, {
      type: 'analysis_missing_source',
      missing: fixture.missing ?? [],
      documents: (fixture.attachmentFilenamesOnly ?? []).map((filename) => ({
        filename,
        reason: 'Authorised attachment content is missing. Filenames are not document bytes.',
        sourceKind: 'attachment' as const,
      })),
    });
  }
  if (fixture.phase === 'unsupported') {
    return reduceQuoteSession(session, { type: 'analysis_unsupported', message: 'Unsupported request' });
  }
  if (fixture.phase === 'failed') {
    return reduceQuoteSession(session, { type: 'analysis_failed', message: 'Source failed' });
  }
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: {
      intent: 'quote',
      groups: fixture.groups,
      secondaryAsks: fixture.secondaryAsks,
      alternatives: fixture.alternatives,
    },
  });
  if (fixture.offers.length) {
    session = reduceQuoteSession(session, fixtureResultsReady(fixture.offers));
  }
  return session;
}

function assertRatePlanVisible() {
  expect(screen.getByLabelText('Rate plan')).toBeDefined();
}

function withLunaMissing(
  session: QuoteSession,
  missing: LunaAnalysisWire['missing'],
  party: LunaAnalysisWire['party'] = { kind: null, name: null, reference: null },
): QuoteSession {
  return {
    ...session,
    analysis: {
      ...(session.analysis ?? {
        intent: 'quote' as const,
        groups: session.groups,
        secondaryAsks: [],
        alternatives: [],
      }),
      luna: {
        workflow: 'quote',
        flags: [],
        groups: [],
        party,
        rateClaims: [],
        missing,
        evidence: [],
        tasks: [],
      },
    },
  };
}

function primaryActions(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter(
    (button) => button.className.includes('bg-[#0066cc]') || button.className.includes('bg-[#1a4332]'),
  );
}

function EditableStayPanel({
  initial,
  seen,
}: {
  initial: QuoteSession;
  seen?: { latest: QuoteSession | null };
}) {
  const [session, setSession] = useState(initial);
  if (seen) seen.latest = session;
  return (
    <QuoteWorkflowPanel
      session={session}
      onStayAction={(action) => setSession((current) => reduceQuoteSession(current, action))}
      onPatchGroup={(groupId, patch) =>
        setSession((current) => reduceQuoteSession(current, { type: 'patch_group', groupId, patch }))
      }
    />
  );
}

function failedRateSession(
  reason: string,
  detail: string,
  alternatives: QuoteRoomAlternative[] = [],
): QuoteSession {
  let session = sessionFromFixture('failed-run');
  const groups = session.groups.map((group) => ({ ...group, roomPreference: 'SKNG' }));
  session = {
    ...session,
    groups,
    steps: [{
      id: 'quote-1',
      kind: 'quote_stay',
      title: 'Search availability for 12–14 Nov',
      inputs: { quoteRequestKey: '2026-11-12:2026-11-14', groupIds: ['g1'] },
      shareKey: '2026-11-12:2026-11-14',
      dependsOn: [],
      status: 'running',
    }],
    phase: 'tools',
  };
  return reduceQuoteSession(session, {
    type: 'results_unavailable',
    stepId: 'quote-1',
    reason,
    detail,
    alternatives,
    selectionEpoch: session.binding?.selectionEpoch ?? 0,
    inputRevision: session.inputRevision,
  });
}

function AlternativeStayPanel({
  initial,
  onRunStep,
  onPatchGroup,
  paneConfig,
}: {
  initial: QuoteSession;
  onRunStep: (stepId: string) => void;
  onPatchGroup: (groupId: string, patch: Partial<QuoteSession['groups'][number]>) => void;
  paneConfig?: QuotePaneConfig | null;
}) {
  const [session, setSession] = useState(initial);
  return (
    <QuoteWorkflowPanel
      session={session}
      onStayAction={(action) => setSession((current) => reduceQuoteSession(current, action))}
      onPatchGroup={(groupId, patch) => {
        onPatchGroup(groupId, patch);
        setSession((current) => reduceQuoteSession(current, { type: 'patch_group', groupId, patch }));
      }}
      onRunStep={onRunStep}
      paneConfig={paneConfig}
    />
  );
}

function FailedRatesNoticeTrigger({
  failureMessage,
  targetId = 'quote-rates',
  label = 'Show failed rate notice',
  jobId = 'failed-rates-test-1',
}: {
  failureMessage: string;
  targetId?: string;
  label?: string;
  jobId?: string;
}) {
  const reporter = useHmsJobNoticeReporter();
  const request = { kind: targetId === 'quote-rates' ? 'staff_quote' : 'party' } as unknown as HmsJobRequest;
  const retry = () => undefined;
  const observerId = `${jobId}-observer`;
  const view: HmsJobView = {
    runId: jobId,
    request,
    prefetch: false,
    status: 'failed',
    position: null,
    attempts: 1,
    failureClass: 'STAFF_QUOTE_FAILED',
    asOf: null,
    result: { message: failureMessage },
  };
  return (
    <button
      type="button"
      onClick={() => {
        reporter.started({ observerId, jobId, request, targetId, retry, transport: null });
        reporter.settled(observerId, jobId, view, retry);
      }}
    >
      {label}
    </button>
  );
}

describe('QuoteWorkflowPanel', () => {
  it('shows analysing, unsynced, missing-source, failed, unsupported, and non-quote states', () => {
    const start = initialQuoteSession();
    render(<QuoteWorkflowPanel session={{ ...start, phase: 'analysing' }} />);
    expect(screen.getByText(/Nava is reading the email/i)).toBeDefined();
    cleanup();
    render(<QuoteWorkflowPanel session={{ ...start, phase: 'unsynced' }} />);
    expect(screen.getByText(/not finished syncing/i)).toBeDefined();
    cleanup();
    render(<QuoteWorkflowPanel session={sessionFromFixture('attachment-dependent')} />);
    expect(screen.getAllByText(/Nava could not read the attachment contents/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/rooming-list\.pdf is the document/i)).toBeNull();
    cleanup();
    render(<QuoteWorkflowPanel session={sessionFromFixture('source-failure')} />);
    expect(screen.getAllByText(/Source failed/i).length).toBeGreaterThan(0);
    cleanup();
    render(<QuoteWorkflowPanel session={sessionFromFixture('unsupported')} />);
    expect(screen.getByText(/Unsupported request/i)).toBeDefined();
    cleanup();
    render(
      <QuoteWorkflowPanel
        session={reduceQuoteSession(reduceQuoteSession(initialQuoteSession(), {
          type: 'selection',
          binding: {
            transportId: 't1',
            mailboxEmail: 'centurion@legacyhotels.co.za',
            storeId: 's',
            folderEntryId: 'f',
            entryId: 'e',
            selectionEpoch: 1,
            scopeEpoch: 1,
          },
        }), { type: 'analysis_ready', analysis: { intent: 'other', groups: [], secondaryAsks: [], alternatives: [] } })}
      />,
    );
    expect(screen.queryByText(/not a quote or booking/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Search availability/i })).toBeNull();
  });

  it('renders one stay card for groups on the same dates, with a row per room and month and year dates', () => {
    const onPatchGroup = vi.fn();
    render(
      <QuoteWorkflowPanel session={sessionFromFixture('mixed-same-dates')} onPatchGroup={onPatchGroup} />,
    );
    const arrivals = screen.getAllByLabelText(/Arrival/i);
    expect(arrivals).toHaveLength(1);
    expect(screen.getAllByRole('group', { name: /^Rooms for stay 1, room \d$/ })).toHaveLength(2);
    expect((arrivals[0] as HTMLInputElement).value).toBe('2026-10-16');
    expect(screen.getByRole('heading', { name: /Stay 1 of 1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit adults per room for stay 1, room 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 2' }));
    expect(onPatchGroup).toHaveBeenCalledWith('g-single', expect.objectContaining({ adults: 2 }));
  });

  it('keeps one stay card when same-date rooms arrived as two extracted stay ids', () => {
    const base = sessionFromFixture('mixed-same-dates');
    const session = {
      ...base,
      groups: base.groups.map((group, index) => ({
        ...group,
        stayId: index === 0 ? 'stay-twin' : 'stay-queen',
      })),
    };
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByRole('heading', { name: /Stay 1 of 1/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Stay 2 of 2/ })).toBeNull();
    expect(screen.getAllByRole('group', { name: /^Rooms for stay 1, room \d$/ })).toHaveLength(2);
    expect(screen.getAllByLabelText(/Arrival/i)).toHaveLength(1);
  });

  it('adds another independent date range after extracted same-date rooms remain together', () => {
    render(<EditableStayPanel initial={sessionFromFixture('mixed-same-dates')} />);
    expect(screen.getAllByRole('heading', { name: /Stay 1 of 1/ })).toHaveLength(1);
    expect(screen.getAllByRole('group', { name: /^Rooms for stay 1, room \d$/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Add another date range/ }));
    expect(screen.getByRole('heading', { name: /Stay 1 of 2/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Stay 2 of 2/ })).toBeTruthy();

    const arrivals = screen.getAllByLabelText('Arrival') as HTMLInputElement[];
    fireEvent.click(screen.getAllByRole('button', { name: /Change dates/ })[1]!);
    fireEvent.change(arrivals[1]!, { target: { value: '2026-12-20' } });
    const afterEdit = screen.getAllByLabelText('Arrival') as HTMLInputElement[];
    expect(afterEdit[0]?.value).toBe('2026-10-16');
    expect(afterEdit[1]?.value).toBe('2026-12-20');
    expect(screen.getAllByRole('button', { name: 'Stay information' })).toHaveLength(2);
  });

  it('keeps duplicated room edits independent', () => {
    const initial = sessionFromFixture('mixed-same-dates');
    const originalCode = initial.groups[0]?.roomTypeCode ?? initial.groups[0]?.roomPreference;
    render(<EditableStayPanel initial={initial} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy room' })[0]!);
    const roomsBeforeEdit = screen.getAllByLabelText('Room type') as unknown as HTMLSelectElement[];
    expect(roomsBeforeEdit).toHaveLength(3);
    fireEvent.change(roomsBeforeEdit[0]!, { target: { value: 'LUXKNG' } });
    const roomsAfterEdit = screen.getAllByLabelText('Room type') as unknown as HTMLSelectElement[];
    expect(roomsAfterEdit[0]?.value).toBe('LUXKNG');
    expect(roomsAfterEdit[1]?.value).toBe('single');
    expect(roomsAfterEdit[2]?.value).toBe(originalCode);
  });

  it('has one People step with distinct agency and company fields', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('agency-contract')} />);
    expect(
      screen.getAllByRole('region', { name: 'People' }),
    ).toHaveLength(1);
    expect(screen.getByLabelText('Agency')).toBeTruthy();
    expect(screen.getByLabelText('Company')).toBeTruthy();
    expect(screen.queryByLabelText('Company or agency')).toBeNull();
    expect(screen.queryByLabelText('Attention')).toBeNull();
    expect(screen.queryByLabelText('Client email')).toBeNull();
    expect(screen.queryByLabelText('Client telephone')).toBeNull();
  });

  it('presents decision-ordered case-card sections with one primary action for the current state', () => {
    const base = sessionFromFixture('public-single');
    const session = withLunaMissing(
      {
        ...base,
        phase: 'requirements',
        offers: [],
        rateOptions: [],
        selectedOfferIds: [],
        steps: base.steps.map((step) => ({ ...step, status: 'ready' as const })),
      },
      [],
    );
    const { container } = render(
      <QuoteWorkflowPanel
        session={session}
      />,
    );
    const steps = Array.from(container.querySelectorAll<HTMLElement>('section[id^="quote-"]'));
    expect(steps.map((step) => step.id)).toEqual([
      'quote-party',
      'quote-stay',
      'quote-quote',
    ]);
    expect(steps.map((step) => step.getAttribute('aria-label'))).toEqual([
      'People',
      'Stay',
      'Documents',
    ]);
    expect(steps.map((step) => step.querySelector('h3 span')?.textContent)).toEqual(['1', '2', '3']);
    expect(screen.queryByRole('region', { name: 'Extras & alternatives' })).toBeNull();
    expect(within(steps[0]!).getByRole('button', { name: 'Continue to Stay' })).toBeDefined();
    const ratesStep = container.querySelector<HTMLElement>('#quote-rates');
    if (!ratesStep) throw new Error('Expected the nested Availability & rates controls.');
    expect(steps[1]!.contains(ratesStep)).toBe(true);
    const ratePlanSelect = within(ratesStep).getByLabelText('Rate plan');
    const searchHeading = within(ratesStep).getByText('Search availability & room rates');
    expect(
      ratePlanSelect.compareDocumentPosition(searchHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const step of steps) {
      expect(within(step).getAllByTestId('quote-step-state').length).toBeGreaterThan(0);
    }
    expect(within(steps[0]!).queryByText(/Optional if none in email/)).toBeNull();
    expect(primaryActions(container)).toHaveLength(1);
    expect(primaryActions(container)[0]?.textContent).toBe('Search availability');
    expect(screen.queryByRole('button', { name: 'Book in HMS' })).toBeNull();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('surfaces party as the first blocker when party and stay facts are both missing', () => {
    const base = sessionFromFixture('public-single');
    const session = withLunaMissing(
      {
        ...base,
        staffHeader: { ...base.staffHeader, company: 'Sample Company', parties: {} },
      },
      [
        { field: 'arrivalDate', question: 'What arrival and departure dates should be quoted?' },
        { field: 'party', question: 'Confirm the company or agency for contract rates.' },
      ],
      { kind: 'organization', name: 'Sample Company', reference: null },
    );
    const { container } = render(<QuoteWorkflowPanel session={session} />);

    const ask = screen.getByLabelText('Needs your answer');
    expect(within(ask).getByText('Confirm the company or agency for contract rates.')).toBeDefined();
    expect(within(ask).queryByText('What arrival and departure dates should be quoted?')).toBeNull();
    expect(primaryActions(container)).toHaveLength(1);
    expect(primaryActions(container)[0]?.textContent).toBe('Review people');
  });

  it('does not route a missing client email to the agency and company step', () => {
    const session = withLunaMissing(sessionFromFixture('public-single'), [
      { field: 'clientEmail', question: 'Which email should be printed on the quote?' },
    ]);
    render(<QuoteWorkflowPanel session={session} />);

    expect(
      screen.queryByRole('button', { name: /Review (?:party and contact|agency & company)/ }),
    ).toBeNull();
  });

  it('skips a missing company ask after the quote header already has that company', () => {
    const base = sessionFromFixture('public-single');
    const session = withLunaMissing(
      {
        ...base,
        groups: base.groups.map((group) => ({
          ...group,
          arrivalDate: undefined,
          departureDate: undefined,
        })),
        staffHeader: {
          ...base.staffHeader,
          company: 'Sample Company',
          parties: { company: { kind: 'company', nativeId: 'company-1', name: 'Sample Company' } },
        },
      },
      [
        { field: 'company', question: 'Which company should appear on the quote?' },
        { field: 'arrivalDate', question: 'What arrival and departure dates should be quoted?' },
      ],
      { kind: 'organization', name: 'Sample Company', reference: null },
    );
    render(<QuoteWorkflowPanel session={session} />);

    const ask = screen.getByLabelText('Needs your answer');
    expect(within(ask).queryByText('Which company should appear on the quote?')).toBeNull();
    expect(
      within(ask).getByText('What arrival and departure dates should be quoted?'),
    ).toBeDefined();
  });

  it('surfaces one date ask and one current action when stay dates are missing', () => {
    const base = sessionFromFixture('missing-fields');
    const session = withLunaMissing(
      {
        ...base,
        analysis: { ...base.analysis!, secondaryAsks: [] },
      },
      [],
    );
    const { container } = render(<QuoteWorkflowPanel session={session} />);

    const ask = screen.getByLabelText('Needs your answer');
    expect(within(ask).getAllByText(/arrival and departure dates/i)).toHaveLength(1);
    expect(primaryActions(container)).toHaveLength(1);
    expect(primaryActions(container)[0]?.textContent).toBe('Add stay dates');
  });

  it('advances to the next unresolved stay ask after staff fills the missing dates', () => {
    const base = sessionFromFixture('missing-fields');
    const session = withLunaMissing(
      {
        ...base,
        groups: base.groups.map((group) => ({
          ...group,
          roomPreference: '',
          roomTypeCode: undefined,
          roomTypeSuggestions: [],
          roomCodes: [],
        })),
      },
      [
        { field: 'arrivalDate', question: 'What arrival and departure dates should be quoted?' },
        { field: 'roomPreference', question: 'Which room type should be quoted?' },
      ],
    );
    render(<EditableStayPanel initial={session} />);
    const ask = () => screen.getByLabelText('Needs your answer');

    expect(
      within(ask()).getByText('What arrival and departure dates should be quoted?'),
    ).toBeDefined();
    expect(within(ask()).queryByText('Which room type should be quoted?')).toBeNull();

    fireEvent.change(screen.getByLabelText('Arrival'), { target: { value: '2026-11-12' } });
    fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2026-11-14' } });

    expect(
      within(ask()).queryByText('What arrival and departure dates should be quoted?'),
    ).toBeNull();
    expect(within(ask()).getByText('Which room type should be quoted?')).toBeDefined();
  });

  it('points the missing-info ask to the fields below or its action button', () => {
    const session = withLunaMissing(sessionFromFixture('missing-fields'), []);
    render(<QuoteWorkflowPanel session={session} />);

    const ask = screen.getByLabelText('Needs your answer');
    expect(
      within(ask).getByText('Use the fields below, or the button to jump to them.'),
    ).toBeDefined();
  });

  it('shows one search action and no missing-info ask when quote facts are present', () => {
    const base = sessionFromFixture('public-single');
    const session = withLunaMissing(
      {
        ...base,
        phase: 'requirements',
        offers: [],
        rateOptions: [],
        selectedOfferIds: [],
        steps: base.steps.map((step) => ({ ...step, status: 'ready' as const })),
      },
      [],
    );
    const { container } = render(<QuoteWorkflowPanel session={session} />);

    expect(screen.queryByLabelText('Needs your answer')).toBeNull();
    expect(primaryActions(container)).toHaveLength(1);
    expect(primaryActions(container)[0]?.textContent).toBe('Search availability');
  });

  it('labels a prepared stay price as Prepared by Nava with its as-of time', () => {
    const base = sessionFromFixture('public-single');
    const asOf = '2026-10-14T10:35:00.000Z';
    const quoteRequestKey = '2026-11-12:2026-11-14';
    const preparedQuote = {
      workflowRunId: 'prepared-run-1',
      revisionRef: 'prepared-revision-1',
      factRefs: [],
      messageId: 'mail-1',
      threadId: 'thread-1',
      sourceHash: 'a'.repeat(64),
      selectionEpoch: 1,
      inputRevision: 1,
      inputDigest: 'b'.repeat(64),
      preparedByNava: true,
      preparedAt: asOf,
      totalMinor: 272000,
      currency: 'ZAR',
      quoteRequestKey,
      approvedHeader: {
        salesStrategy: 'BAR' as const,
        company: '',
        agency: '',
        attention: '',
        clientEmail: '',
        clientTelephone: '',
      },
    };
    render(
      <QuoteWorkflowPanel
        session={{
          ...base,
          selectedStayKey: quoteRequestKey,
          staffQuote: preparedQuote,
          staffQuotes: { [quoteRequestKey]: preparedQuote },
        }}
      />,
    );

    expect(screen.getByText(/^Prepared by Nava · /)).toBeDefined();
  });

  it('marks People as looking up while an HMS party search is pending', () => {
    const session = { ...sessionFromFixture('public-single'), pendingPartyKinds: ['company' as const] };
    render(<QuoteWorkflowPanel session={session} />);
    expect(
      within(
        screen.getByRole('region', {
          name: 'People',
        }),
      ).getByTestId('quote-step-state').textContent,
    ).toBe('Looking up');
  });

  it('names room rows by room type and room count', () => {
    const base = sessionFromFixture('mixed-same-dates');
    const session = {
      ...base,
      groups: base.groups.map((group, index) => ({
        ...group,
        roomPreference: index === 0 ? 'STWN' : 'STQN',
        roomTypeCode: index === 0 ? 'STWN' as const : 'STQN' as const,
      })),
    };
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText('Standard Twin ×1')).toBeDefined();
    expect(screen.getByText('Standard Queen ×2')).toBeDefined();
    expect(screen.getByText('3 rooms · 4 guests')).toBeDefined();
    expect(screen.queryByText('Room 1')).toBeNull();
    expect(screen.queryByText('Room 2')).toBeNull();
  });

  it('shows Find in HMS in both party fields, including an empty Company field', () => {
    const findParty = vi.fn(async () => ({ outcome: 'no_match' as const, results: [], truncated: false, best: null, searchedFor: null }));
    render(<QuoteWorkflowPanel session={sessionFromFixture('mixed-same-dates')} findParty={findParty} />);
    const agency = screen.getByRole('group', { name: 'Agency lookup in HMS' });
    const company = screen.getByRole('group', { name: 'Company lookup in HMS' });
    expect(within(agency).getByRole('button', { name: 'Find in HMS' })).toBeDefined();
    const findCompany = within(company).getByRole('button', { name: 'Find in HMS' }) as HTMLButtonElement;
    expect(findCompany.disabled).toBe(true);
  });

  it('does not show the unused Book in HMS action in the quote flow', () => {
    const session = { ...sessionFromFixture('mixed-same-dates'), reviewedReplyHtml: 'Reply draft' };
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.queryByRole('button', { name: 'Book in HMS' })).toBeNull();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('searches on dates and occupancy without a room type pick', () => {
    const onStayAction = vi.fn();
    const onRunStep = vi.fn();
    const base = sessionFromFixture('failed-run');
    const session = {
      ...base,
      groups: base.groups.map((group) => ({ ...group, roomPreference: '', roomTypeCode: undefined, roomCodes: [] })),
      steps: base.steps.map((step) => (step.kind === 'quote_stay' ? { ...step, status: 'ready' as const } : step)),
    };
    const { container } = render(
      <QuoteWorkflowPanel session={session} onStayAction={onStayAction} onRunStep={onRunStep} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Add room type/ }));
    expect(onStayAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'add_row', stayId: expect.any(String) }));
    expect(screen.queryByText('Choose a room type for each room before searching.')).toBeNull();
    const search = screen.getByRole('button', { name: 'Search availability' }) as HTMLButtonElement;
    expect(search.disabled).toBe(false);
    fireEvent.click(search);
    expect(onRunStep).toHaveBeenCalled();
    expect(primaryActions(container).some((button) => button.textContent === 'Search availability')).toBe(true);
  });

  it('keeps a defaulted any-type row ready and searchable after room and occupancy edits', () => {
    const onRunStep = vi.fn();
    const base = sessionFromFixture('public-single');
    const session = withLunaMissing(
      {
        ...base,
        phase: 'requirements',
        offers: [],
        rateOptions: [],
        selectedOfferIds: [],
        groups: base.groups.map((group) => ({
          ...group,
          roomPreference: 'Twin',
          roomTypeCode: undefined,
          roomCodes: [],
          quantity: 2,
          adults: 2,
          fields: {
            ...group.fields,
            roomPreference: 'defaulted',
            quantity: 'staff_corrected',
            adults: 'staff_corrected',
          },
        })),
        steps: base.steps.map((step) => ({ ...step, status: 'ready' as const })),
      },
      [{ field: 'stay', question: 'Complete the stay details.' }],
    );
    const { container } = render(<QuoteWorkflowPanel session={session} onRunStep={onRunStep} />);

    const search = screen.getByRole('button', { name: 'Search availability' }) as HTMLButtonElement;
    expect(search.disabled).toBe(false);
    expect(container.querySelector('#quote-stay [data-testid="quote-step-state"]')?.textContent).toBe('Done');
    expect(screen.queryByLabelText('Needs your answer')).toBeNull();
    fireEvent.click(search);
    expect(onRunStep).toHaveBeenCalledWith(base.steps[0]!.id);
  });

  it('searches a blank defaulted room preference on dates and occupancy alone', () => {
    const onRunStep = vi.fn();
    const base = sessionFromFixture('public-single');
    const session = withLunaMissing(
      {
        ...base,
        phase: 'requirements',
        offers: [],
        rateOptions: [],
        selectedOfferIds: [],
        groups: base.groups.map((group) => ({
          ...group,
          roomPreference: '',
          roomTypeCode: undefined,
          roomCodes: [],
          quantity: 2,
          adults: 2,
          fields: {
            ...group.fields,
            roomPreference: 'defaulted',
            quantity: 'staff_corrected',
            adults: 'staff_corrected',
          },
        })),
        steps: base.steps.map((step) => ({ ...step, status: 'ready' as const })),
      },
      [{ field: 'stay', question: 'Complete the stay details.' }],
    );
    render(<QuoteWorkflowPanel session={session} onRunStep={onRunStep} />);

    expect(screen.queryByText('Choose a room type for each room before searching.')).toBeNull();
    const search = screen.getByRole('button', { name: 'Search availability' }) as HTMLButtonElement;
    expect(search.disabled).toBe(false);
    fireEvent.click(search);
    expect(onRunStep).toHaveBeenCalledWith(base.steps[0]!.id);
  });

  it('disables Search availability when the server makeQuote capability is off', () => {
    const onRunStep = vi.fn();
    const base = sessionFromFixture('public-single');
    const session = withLunaMissing(
      {
        ...base,
        phase: 'requirements',
        offers: [],
        rateOptions: [],
        selectedOfferIds: [],
        groups: base.groups.map((group) => ({
          ...group,
          roomPreference: '',
          roomTypeCode: undefined,
          roomCodes: [],
          quantity: 2,
          adults: 2,
          fields: {
            ...group.fields,
            roomPreference: 'defaulted',
            quantity: 'staff_corrected',
            adults: 'staff_corrected',
          },
        })),
        steps: base.steps.map((step) => ({ ...step, status: 'ready' as const })),
      },
      [{ field: 'stay', question: 'Complete the stay details.' }],
    );
    render(<QuoteWorkflowPanel session={session} onRunStep={onRunStep} makeQuote={false} />);
    const search = screen.getByRole('button', { name: 'Search availability' }) as HTMLButtonElement;
    expect(search.disabled).toBe(true);
    fireEvent.click(search);
    expect(onRunStep).not.toHaveBeenCalled();
    expect(screen.getAllByText('Make quote is not available for this mailbox.').length).toBeGreaterThan(0);
  });

  it('labels missing fields and extracted provenance', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('missing-fields')} />);
    expect(screen.getAllByText('Missing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('from email').length).toBeGreaterThan(0);
  });

  it('retries one failed date range directly without exposing raw HMS errors', () => {
    const onRunNext = vi.fn();
    const onRunStep = vi.fn();
    const session = failedRateSession(
      "HMS didn't answer in time.",
      "Cannot read properties of undefined (reading 'internetMessageId')",
    );
    render(<QuoteWorkflowPanel session={session} onRunNext={onRunNext} onRunStep={onRunStep} />);
    expect(screen.getAllByText('HMS could not complete this search. Retry the date range.')).toHaveLength(1);
    expect(screen.queryByText("HMS didn't answer in time.")).toBeNull();
    expect(screen.getByText(/Dates 2026-11-12 → 2026-11-14/i)).toBeDefined();
    const details = screen.getByText('Details').closest('details');
    expect(details).toBeTruthy();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.textContent).not.toContain('internetMessageId');
    fireEvent.click(screen.getByRole('button', { name: 'Retry date range for Stay 1' }));
    expect(onRunNext).not.toHaveBeenCalled();
    expect(onRunStep).toHaveBeenCalledWith('quote-1');
    expect(screen.getByRole('button', { name: 'Search availability' })).toBeTruthy();
  });

  it('shows HMS room alternatives without choosing one and reruns only after Use this', async () => {
    const onRunStep = vi.fn();
    const onPatchGroup = vi.fn();
    const alternatives = [
      { groupId: 'g1', roomCode: 'DLXTWN', roomLabel: 'Deluxe Twin', quantity: 2 },
    ];
    const failed = failedRateSession(
      'No qualified rate covers every room-night.',
      'Some nights are short.',
      alternatives,
    );
    const session = {
      ...failed,
      groups: failed.groups.map((group) => ({ ...group, rateCode: 'BAR' })),
    };
    render(<AlternativeStayPanel initial={session} onRunStep={onRunStep} onPatchGroup={onPatchGroup} paneConfig={null} />);

    const alternative = screen.getByText('Not available — instead: Deluxe Twin × 2');
    const alternativeGroup = alternative.closest('[role="group"]');
    expect(alternativeGroup).toBeTruthy();
    expect(alternativeGroup?.parentElement?.querySelector('h5')?.textContent).toMatch(/rates$/);
    const useThis = within(alternativeGroup as HTMLElement).getByRole('button', { name: 'Use this' });
    expect(useThis.className).toContain('min-h-11');
    expect((screen.getByLabelText('Room type') as unknown as HTMLSelectElement).value).toBe('SKNG');
    expect(onPatchGroup).not.toHaveBeenCalled();
    expect(onRunStep).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Use this' }));

    expect(onPatchGroup).toHaveBeenCalledWith('g1', expect.objectContaining({
      roomCodes: ['DLXTWN'],
      roomPreference: 'Deluxe Twin',
      quantity: 2,
      rateCode: 'BAR',
    }));
    await waitFor(() => expect(onRunStep).toHaveBeenCalledWith('quote-1'));
    await waitFor(() =>
      expect((screen.getByLabelText('Room type') as unknown as HTMLSelectElement).value).toBe('DLXTWN'),
    );
  });

  it('shows a safe failed-rate banner once, then one safe local retry message', () => {
    const reason = "HMS didn't answer in time.";
    const session = failedRateSession(reason, 'The full server diagnostic stays behind Details.');
    render(
      <HmsJobNoticeProvider emailKey="e1" emailSubject="Suite Availability Request">
        <HmsJobNoticeBanner />
        <QuoteWorkflowPanel session={session} />
        <FailedRatesNoticeTrigger failureMessage={reason} />
      </HmsJobNoticeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show failed rate notice' }));

    const banner = screen.getByTestId('hms-job-notice-banner');
    expect(banner.textContent).toContain('Rates failed: HMS could not complete the lookup. Retry, or check the request.');
    expect(banner.textContent).not.toContain(reason);
    expect(screen.queryByText(reason, { exact: true })).toBeNull();

    fireEvent.click(within(banner).getByRole('button', { name: 'Try again' }));
    expect(screen.getAllByText('HMS could not complete this search. Retry the date range.')).toHaveLength(1);
    expect(screen.queryByText(reason, { exact: true })).toBeNull();
  });

  it('keeps a safe local rate retry message when another failure owns the notice banner', () => {
    const reason = "HMS didn't answer in time.";
    const session = failedRateSession(reason, 'The full server diagnostic stays behind Details.');
    render(
      <HmsJobNoticeProvider emailKey="e1" emailSubject="Suite Availability Request">
        <HmsJobNoticeBanner />
        <QuoteWorkflowPanel session={session} />
        <FailedRatesNoticeTrigger
          targetId="quote-party"
          jobId="failed-party-test-1"
          label="Show failed party notice"
          failureMessage="The company search failed."
        />
        <FailedRatesNoticeTrigger failureMessage={reason} />
      </HmsJobNoticeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show failed party notice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show failed rate notice' }));

    expect(screen.getByTestId('hms-job-notice-banner').textContent).toContain('HMS lookup failed:');
    expect(screen.getAllByText('HMS could not complete this search. Retry the date range.')).toHaveLength(1);
    expect(screen.queryByText(reason, { exact: true })).toBeNull();
  });

  it('offers a date-specific search after results, enabled when idle and tied to the same stay', () => {
    const onRunStep = vi.fn();
    const session = sessionFromFixture('public-single');
    const step = session.steps.find((item) => item.kind === 'quote_stay');
    expect(step).toBeDefined();
    if (!step) return;
    session.steps = session.steps.map((item) => item.id === step.id ? { ...item, status: 'succeeded' as const } : item);
    const { rerender } = render(<QuoteWorkflowPanel session={session} onRunStep={onRunStep} />);
    const button = screen.getByRole('button', { name: 'Search this date range for Stay 1' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.className).toMatch(/border-\[#0066cc\].*text-\[#0066cc\]/);
    fireEvent.click(button);
    expect(onRunStep).toHaveBeenCalledWith(step.id);

    rerender(<QuoteWorkflowPanel session={{ ...session, runningStepId: step.id }} onRunStep={onRunStep} />);
    expect((screen.getByRole('button', { name: 'Search this date range for Stay 1' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the date-specific search enabled while showing a pending party lookup reason', () => {
    const session = sessionFromFixture('public-single');
    const step = session.steps.find((item) => item.kind === 'quote_stay');
    expect(step).toBeDefined();
    if (!step) return;
    session.steps = session.steps.map((item) => item.id === step.id ? { ...item, status: 'succeeded' as const } : item);
    render(<QuoteWorkflowPanel session={{ ...session, pendingPartyKinds: ['company'] }} onRunStep={vi.fn()} />);

    const button = screen.getByRole('button', { name: 'Search this date range for Stay 1' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.getByText('Finding the company in HMS…')).toBeTruthy();
  });

  it('explains when a date-specific search has no run handler instead of leaving an enabled no-op', () => {
    vi.mocked(toast.warning).mockClear();
    const session = sessionFromFixture('public-single');
    const step = session.steps.find((item) => item.kind === 'quote_stay');
    expect(step).toBeDefined();
    if (!step) return;
    session.steps = session.steps.map((item) => item.id === step.id ? { ...item, status: 'succeeded' as const } : item);
    render(<QuoteWorkflowPanel session={session} />);

    const button = screen.getByRole('button', { name: 'Search this date range for Stay 1' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(toast.warning).toHaveBeenCalledWith('Search is not available in this view.');
  });

  it('shows the non-blocking HMS lookup state on the stay that is running', () => {
    const base = sessionFromFixture('failed-run');
    const running = {
      ...base,
      groups: base.groups.map((group) => ({ ...group, roomPreference: 'SKNG' })),
      steps: [{
        id: 'quote-1',
        kind: 'quote_stay' as const,
        title: 'Search availability for 12–14 Nov',
        inputs: { quoteRequestKey: '2026-11-12:2026-11-14', groupIds: ['g1'] },
        shareKey: '2026-11-12:2026-11-14',
        dependsOn: [],
        status: 'running' as const,
      }],
      runningStepId: 'quote-1',
      phase: 'tools' as const,
    };
    render(<QuoteWorkflowPanel session={running} />);
    expect(screen.getByRole('status').textContent).toContain('Looking up in HMS — you can keep working');
    expect(screen.getByRole('status').textContent).toContain('elapsed');
    expect(screen.getByRole('status').querySelector('svg')).toBeNull();
  });

  it('keeps the other stay editable while a stay HMS search runs', () => {
    const base = staggeredDatesSession();
    const activeStep = base.steps[0]!;
    const [activeGroup, otherGroup] = base.groups;
    if (!activeGroup || !otherGroup) throw new Error('Expected two stays.');
    const rateOption = (groupId: string, id: string): RateOption => ({
      id,
      groupId,
      board: 'bb',
      boardLabel: 'Bed & breakfast',
      rateCode: 'BAR',
      rateLabel: 'Best available',
      roomCode: 'STQN',
      roomLabel: 'Standard Queen',
      contract: false,
      onlyContract: false,
      matchesRequest: true,
      perNightMinor: 100_000,
      totalMinor: 200_000,
      currency: 'ZAR',
      priced: 'summary',
      selected: true,
    });
    const session: QuoteSession = {
      ...base,
      phase: 'tools',
      runningStepId: activeStep.id,
      steps: base.steps.map((step) => step.id === activeStep.id ? { ...step, status: 'running' as const } : step),
      rateOptions: [rateOption(activeGroup.id, 'active-rate'), rateOption(otherGroup.id, 'other-rate')],
    };
    const onRunStep = vi.fn();
    const onPatchGroup = vi.fn();
    const { rerender } = render(
      <QuoteWorkflowPanel session={session} onRunStep={onRunStep} onPatchGroup={onPatchGroup} />,
    );

    const roomTypes = screen.getAllByLabelText('Room type') as unknown as HTMLSelectElement[];
    expect(roomTypes.every((input) => !input.disabled)).toBe(true);
    const searchButton = screen.getByRole('button', { name: 'Search availability' }) as HTMLButtonElement;
    expect(searchButton.disabled).toBe(true);
    const otherStaySearch = screen.getByRole('button', { name: 'Search this date range for Stay 2' });
    expect((otherStaySearch as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(otherStaySearch);
    expect(screen.getByText('Search queued until the current stay finishes.')).toBeDefined();
    expect(onRunStep).not.toHaveBeenCalled();
    const rateCards = screen.getAllByRole('button', { name: /Best available BAR/ }) as HTMLButtonElement[];
    expect(rateCards[0]?.disabled).toBe(true);
    expect(rateCards[1]?.disabled).toBe(false);
    const priceToggles = screen.getAllByRole('button', { name: 'Special price' });
    fireEvent.click(priceToggles[0]!);
    fireEvent.click(priceToggles[1]!);
    const typeRate = screen.getAllByRole('button', { name: 'Type a rate' }) as HTMLButtonElement[];
    expect(typeRate[0]?.disabled).toBe(true);
    expect(typeRate[1]?.disabled).toBe(false);

    const finished: QuoteSession = {
      ...session,
      runningStepId: null,
      steps: session.steps.map((step) => step.id === activeStep.id ? { ...step, status: 'succeeded' as const } : step),
    };
    rerender(<QuoteWorkflowPanel session={finished} onRunStep={onRunStep} onPatchGroup={onPatchGroup} />);
    expect(onRunStep).toHaveBeenCalledWith(base.steps[1]!.id);
  });

  it('does not sum alternatives and shows honest missing screenshots', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('ro-vs-bb')} />);
    expect(screen.getByText(/not counted in the total/i)).toBeDefined();
    expect(screen.getAllByText(/No authorised screenshot is tied to this tool run/i).length).toBeGreaterThan(0);
  });

  it('labels mailbox analyseSelection unsynced while keeping local requirement cards', () => {
    const session = { ...sessionFromFixture('public-single'), mailboxStatus: 'unsynced' as const };
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText(/This email has not finished syncing/i)).toBeDefined();
    expect(screen.queryByText(/Local regex preview/i)).toBeNull();
    expect(screen.getAllByLabelText(/Arrival/i).length).toBeGreaterThan(0);
  });

  it('runs stay search without a separate party execute and parses blank children ages as empty', () => {
    const onRunStep = vi.fn();
    const onPatchGroup = vi.fn();
    let session = sessionFromFixture('agency-contract');
    session = {
      ...session,
      offers: [],
      phase: 'requirements',
    };
    render(
      <QuoteWorkflowPanel
        session={session}
        onRunStep={onRunStep}
        onPatchGroup={onPatchGroup}
      />,
    );
    expect(screen.queryByRole('button', { name: /Run Look up organisation/i })).toBeNull();
    const stay = screen.getByRole('button', { name: 'Search availability' });
    expect((stay as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stay);
    expect(onRunStep).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '− Children / requests' }).getAttribute('aria-expanded')).toBe('true');
    expect((screen.getByLabelText('Children per room') as unknown as HTMLSelectElement).value).toBe('unknown');
    fireEvent.change(screen.getByLabelText('Children ages'), { target: { value: ' , ' } });
    expect(onPatchGroup).toHaveBeenCalledWith('g1', { childrenAges: [] });
  });

  it('keeps two date-group allocations selected and blocks the combined quote until every stay is rated', () => {
    const onSelectOffer = vi.fn();
    let session = sessionFromFixture('staggered-dates');
    session = {
      ...session,
      staffSource: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) },
      evidence: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
      reviewedReplyHtml: '<p>Authorised</p>',
    };
    const first = render(<QuoteWorkflowPanel session={session} onSelectOffer={onSelectOffer} />);
    fireEvent.click(screen.getAllByRole('button').find((el) => (el.textContent ?? '').includes('Counted in the total'))!);
    expect(onSelectOffer).toHaveBeenCalled();
    first.unmount();
    session = { ...session, selectedOfferIds: ['st-a'] };
    render(<QuoteWorkflowPanel session={session} onSelectOffer={onSelectOffer} />);
    expect(screen.getByRole('button', { name: /^Prepare quote$/i })).toHaveProperty('disabled', true);
    session = { ...session, selectedOfferIds: ['st-a', 'st-b'] };
    cleanup();
    render(<QuoteWorkflowPanel session={session} onSelectOffer={onSelectOffer} />);
    expect(screen.getByRole('button', { name: /^Prepare quote$/i })).toHaveProperty('disabled', true);
    expect(screen.getAllByText('0 of 2 stays rated').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Quotation total (all stays)' })).toBeDefined();
    expect(screen.getByText(/Every date range is quoted separately, then included in one quotation/)).toBeDefined();
    expect(screen.queryByText(/Combined PDF is blocked/i)).toBeNull();
  });

  it('keeps mixed same-date groups selected and blocks a partial PDF', () => {
    const onSelectOffer = vi.fn();
    let session = sessionFromFixture('mixed-same-dates');
    session = {
      ...session,
      staffSource: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) },
      evidence: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
      reviewedReplyHtml: '<p>Authorised</p>',
    };
    render(<QuoteWorkflowPanel session={{ ...session, selectedOfferIds: ['mix-a'] }} onSelectOffer={onSelectOffer} />);
    expect(screen.getByRole('button', { name: /^Prepare PDF$/i })).toHaveProperty('disabled', true);
    cleanup();
    render(
      <QuoteWorkflowPanel
        session={{ ...session, selectedOfferIds: ['mix-a', 'mix-b'] }}
        onSelectOffer={onSelectOffer}
        onPreparePdf={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^Prepare PDF$/i })).toHaveProperty('disabled', false);
  });

  it('hides Items for you on a clean quote and on unsynced mail', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('public-single')} />);
    expect(screen.queryByLabelText('Check before sending')).toBeNull();
    expect(screen.queryByText(/Secondary questions still need answers/i)).toBeNull();
    cleanup();
    render(<QuoteWorkflowPanel session={{ ...initialQuoteSession(), phase: 'unsynced' }} />);
    expect(screen.getByText(/not finished syncing/i)).toBeDefined();
    expect(screen.queryByLabelText('Check before sending')).toBeNull();
    expect(screen.queryByLabelText(/Arrival/i)).toBeNull();
    expect(screen.queryByLabelText('Reviewed reply')).toBeNull();
  });

  it('keeps reply content visible when the analysis is unsynced', () => {
    render(
      <QuoteWorkflowPanel
        session={{ ...sessionFromFixture('public-single'), phase: 'unsynced' }}
        replyContent={<p>Reply draft stays visible</p>}
      />,
    );
    expect(screen.getByText('Reply draft stays visible')).toBeDefined();
    expect(screen.getByText(/not finished syncing/i)).toBeDefined();
  });

  it('shows the actual question, filename+reason, handle/undo, and partial-failure reply', () => {
    const onHandle = vi.fn();
    const onUndo = vi.fn();
    const onViewSource = vi.fn();
    const onEditReply = vi.fn();
    render(
      <QuoteWorkflowPanel
        session={sessionFromFixture('missing-fields')}
        onHandleReviewItem={onHandle}
        onUndoReviewItem={onUndo}
        onViewSource={onViewSource}
        onEditReply={onEditReply}
      />,
    );
    expect(screen.getByLabelText('Check before sending')).toBeDefined();
    expect(screen.getByText('How many children, and what ages?')).toBeDefined();
    expect(screen.getByText('Arrival date is missing for Stay 1.')).toBeDefined();
    expect(screen.getByText('Needs a reply. Not a price decision.')).toBeDefined();
    expect(screen.getAllByText('Blocks the quote — fix the stay details first').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Secondary questions still need answers/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as done: How many children, and what ages?' }));
    expect(onHandle).toHaveBeenCalledWith('question:how many children, and what ages?');
    fireEvent.click(screen.getByRole('button', { name: 'Show in email: How many children, and what ages?' }));
    expect(onViewSource).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit reply for How many children, and what ages?' }));
    expect(onEditReply).toHaveBeenCalled();
    expect(screen.getByLabelText('Reviewed reply')).toBeDefined();
    expect(screen.getAllByLabelText(/Arrival/i).length).toBeGreaterThan(0);
    cleanup();

    const missing = sessionFromFixture('attachment-dependent');
    render(<QuoteWorkflowPanel session={missing} />);
    expect(screen.getByText('Could not read: rooming-list.pdf')).toBeDefined();
    expect(screen.getAllByText(/Nava could not read the attachment contents/i).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Reviewed reply')).toBeDefined();
    cleanup();

    const failed = sessionFromFixture('source-failure');
    render(<QuoteWorkflowPanel session={failed} />);
    expect(screen.getAllByText(/Source failed/i).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Reviewed reply')).toBeDefined();
    cleanup();

    const handled = sessionFromFixture('missing-fields');
    handled.handledReviewItemIds = ['question:how many children, and what ages?'];
    render(<QuoteWorkflowPanel session={handled} onUndoReviewItem={onUndo} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo mark as done: How many children, and what ages?' }));
    expect(onUndo).toHaveBeenCalledWith('question:how many children, and what ages?');
  });

  it('shows one top Make quote primary when rates are ready without letting a secondary ask block it', () => {
    const noisy = sessionFromFixture('public-single');
    noisy.reviewItems = [
      {
        id: 'noise-sig',
        kind: 'signature_noise',
        rank: 'unread_source',
        text: 'Hotel logo.png',
        sourceLabel: 'Signature',
        blocking: false,
        positivelyIdentifiedNoise: true,
      },
      {
        id: 'q-shuttle',
        kind: 'question',
        rank: 'secondary',
        text: 'Is an airport shuttle available?',
        sourceLabel: 'Selected message',
        blocking: false,
      },
    ];
    render(<QuoteWorkflowPanel session={noisy} />);
    expect(screen.queryByText('Hotel logo.png')).toBeNull();
    expect(screen.getByText('Is an airport shuttle available?')).toBeDefined();
    cleanup();
    const ready = {
      ...sessionFromFixture('public-single'),
      staffSource: {
        messageId: 'mail-1',
        threadId: 'thread-1',
        sourceHash: 'ab'.repeat(32),
      },
      evidence: { kind: 'authorised' as const, selectionEpoch: 1, inputRevision: 1 },
      selectedOfferIds: ['pub-1'],
      reviewedReplyHtml: '<p>Full staff-edited reply</p>',
      reviewItems: [
        {
          id: 'q-shuttle',
          kind: 'question' as const,
          rank: 'secondary' as const,
          text: 'Is an airport shuttle available?',
          sourceLabel: 'Selected message',
          blocking: false,
        },
      ],
    };
    const onPreparePdf = vi.fn();
    const { container, rerender } = render(<QuoteWorkflowPanel session={ready} onPreparePdf={onPreparePdf} />);
    const topPrepare = screen.getByRole('button', { name: 'Make quote' }) as HTMLButtonElement;
    const documents = container.querySelector('#quote-quote') as HTMLElement;
    const documentPrepare = within(documents).getByRole('button', { name: 'Prepare PDF' }) as HTMLButtonElement;
    expect(topPrepare.disabled).toBe(false);
    expect(topPrepare.className).toContain('bg-[#0066cc]');
    expect(topPrepare.compareDocumentPosition(documents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(primaryActions(container)).toEqual([topPrepare]);
    expect(documentPrepare.className).toContain('border-[#0066cc]');
    expect(documentPrepare.className).not.toContain('bg-[#0066cc]');
    fireEvent.click(topPrepare);
    expect(onPreparePdf).toHaveBeenCalledTimes(1);

    rerender(<QuoteWorkflowPanel session={ready} onPreparePdf={onPreparePdf} pdfPending />);
    const pendingButtons = screen.getAllByRole('button', { name: 'Preparing PDF…' }) as HTMLButtonElement[];
    expect(pendingButtons).toHaveLength(2);
    expect(pendingButtons.every((button) => button.disabled)).toBe(true);

    rerender(
      <QuoteWorkflowPanel
        session={{
          ...ready,
          pdf: {
            fileName: 'Quote - Standard King.pdf',
            bytesBase64: 'JVBERi0xLjQK',
            pdfHash: 'cd'.repeat(32),
            revisionId: 'quotes:public-single',
            totalMinor: 272000,
          },
        }}
        onPreparePdf={onPreparePdf}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Make quote' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Review documents' })).toBeDefined();
    expect(screen.getByText('Is an airport shuttle available?')).toBeDefined();
  });

  it('keeps extras with each Stay and patches the addressed stay only', () => {
    const session = staggeredDatesSession();
    const onPatchStayExtras = vi.fn();
    const { rerender } = render(<QuoteWorkflowPanel session={session} onPatchStayExtras={onPatchStayExtras} />);
    const extras = screen.getAllByRole('group', { name: /^Extras for Stay / });
    expect(extras).toHaveLength(2);
    expect(screen.getAllByText('Stay subtotal')).toHaveLength(2);
    for (const group of extras) {
      for (const label of ['Shuttle', 'Lunch allowance', 'Dinner allowance', 'Other']) {
        const enabled = within(group).getByRole('checkbox', { name: label }) as HTMLInputElement;
        expect(enabled.checked).toBe(false);
        const amount = within(group).getByLabelText(`${label} amount`);
        expect((amount as HTMLInputElement).disabled).toBe(true);
      }
    }
    const firstStayCard = screen.getByRole('article', { name: 'Stay 1 details' });
    const secondStayCard = screen.getByRole('article', { name: 'Stay 2 details' });
    expect(firstStayCard.contains(extras[0]!)).toBe(true);
    expect(secondStayCard.contains(extras[1]!)).toBe(true);
    expect(screen.queryByRole('region', { name: 'Extras & alternatives' })).toBeNull();
    const stayKeys = [...new Set(session.groups.map((group) => `${group.arrivalDate}:${group.departureDate}`))];
    expect(stayKeys).toHaveLength(2);
    const firstStayKey = stayKeys[0]!;
    const secondStayKey = stayKeys[1]!;
    const secondExtras = extras[1]!;
    fireEvent.click(within(secondExtras).getByRole('checkbox', { name: 'Shuttle' }));
    expect(onPatchStayExtras).toHaveBeenCalledWith(secondStayKey, { shuttleEnabled: true });
    rerender(
      <QuoteWorkflowPanel
        session={{
          ...session,
          staffHeader: {
            ...session.staffHeader,
            stayExtrasByKey: {
              ...session.staffHeader.stayExtrasByKey,
              [secondStayKey]: { ...defaultStaffStayExtras(session.staffHeader), shuttleEnabled: true },
            },
          },
        }}
        onPatchStayExtras={onPatchStayExtras}
      />,
    );
    const secondExtrasWithShuttle = screen.getByRole('group', { name: 'Extras for Stay 2' });
    fireEvent.focus(within(secondExtrasWithShuttle).getByLabelText('Shuttle amount'));
    fireEvent.change(within(secondExtrasWithShuttle).getByLabelText('Shuttle amount'), { target: { value: '375' } });
    expect(onPatchStayExtras).toHaveBeenCalledWith(secondStayKey, { shuttleMinor: 37_500 });
    expect(onPatchStayExtras).not.toHaveBeenCalledWith(firstStayKey, expect.anything());

    assertRatePlanVisible();
  });

  it('labels stay duplication and preserves the duplicate_stay action', () => {
    const session = staggeredDatesSession();
    const onStayAction = vi.fn();
    render(<QuoteWorkflowPanel session={session} onStayAction={onStayAction} />);

    const firstStayCard = screen.getByRole('article', { name: 'Stay 1 details' });
    fireEvent.click(within(firstStayCard).getByRole('button', { name: 'Duplicate stay' }));

    expect(onStayAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'duplicate_stay',
        stayId: expect.any(String),
        token: expect.any(String),
      }),
    );
  });

  it('renders the required dinner price and charging unit before quote documents', () => {
    const base = sessionFromFixture('public-single');
    const group = base.groups[0]!;
    const stayKey = `${group.arrivalDate}:${group.departureDate}`;
    const extras = {
      ...defaultStaffStayExtras(base.staffHeader),
      dinnerEnabled: true,
      dinnerAllowanceRequired: true,
      dinnerAllowanceGroupIds: [group.id],
    };
    const session = {
      ...base,
      staffSource: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) },
      evidence: { kind: 'authorised' as const, selectionEpoch: 1, inputRevision: 1 },
      selectedOfferIds: ['pub-1'],
      staffHeader: {
        ...base.staffHeader,
        stayExtrasByKey: { ...base.staffHeader.stayExtrasByKey, [stayKey]: extras },
      },
    };
    const onPatchStayExtras = vi.fn();
    render(<QuoteWorkflowPanel session={session} onPatchStayExtras={onPatchStayExtras} />);

    const extraGroup = screen.getByRole('group', { name: 'Extras for Stay 1' });
    expect(within(extraGroup).getByText('Dinner price — enter amount')).toBeDefined();
    expect((within(extraGroup).getByLabelText('Dinner allowance amount') as HTMLInputElement).disabled).toBe(false);
    expect(['per_person_per_night', 'per_room_per_night', 'per_person']).not.toContain(
      (within(extraGroup).getByLabelText('Dinner add-on unit') as unknown as HTMLSelectElement).value,
    );
    expect((screen.getByRole('button', { name: 'Prepare PDF' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Download Excel' }) as HTMLButtonElement).disabled).toBe(true);

    const amount = within(extraGroup).getByLabelText('Dinner allowance amount');
    fireEvent.focus(amount);
    fireEvent.change(amount, { target: { value: '450' } });
    fireEvent.change(within(extraGroup).getByLabelText('Dinner add-on unit'), { target: { value: 'per_person' } });
    expect(onPatchStayExtras).toHaveBeenCalledWith(stayKey, { dinnerAllowanceMinor: 45_000 });
    expect(onPatchStayExtras).toHaveBeenCalledWith(stayKey, { dinnerAllowanceUnit: 'per_person' });
  });

  it('keeps email extras checked and their amounts prefilled for each stay', () => {
    const base = staggeredDatesSession();
    const session = {
      ...base,
      staffHeader: {
        ...base.staffHeader,
        shuttleRequested: true,
        shuttleMinor: 45_000,
        lunchAllowanceMinor: 20_000,
        dinnerAllowanceMinor: 12_500,
        other: { label: 'Parking', amountMinor: 3_000, unit: 'item' as const },
      },
    };
    render(<QuoteWorkflowPanel session={session} />);
    const [first, second] = screen.getAllByRole('group', { name: /^Extras for Stay / });
    for (const group of [first, second]) {
      for (const label of ['Shuttle', 'Lunch allowance', 'Dinner allowance', 'Other']) {
        expect((within(group!).getByRole('checkbox', { name: label }) as HTMLInputElement).checked).toBe(true);
        expect((within(group!).getByLabelText(`${label} amount`) as HTMLInputElement).disabled).toBe(false);
      }
    }
    expect((within(first!).getByLabelText('Shuttle amount') as HTMLInputElement).value).toBe('450');
    expect((within(second!).getByLabelText('Dinner allowance amount') as HTMLInputElement).value).toBe('125');
  });

  it('blocks only the affected stay while its extra amount is unreadable, then clears it safely', () => {
    const seen: { latest: QuoteSession | null } = { latest: null };
    const base = staggeredDatesSession();
    const key = `${base.groups[0]!.arrivalDate}:${base.groups[0]!.departureDate}`;
    const initial = { ...base, staffHeader: { ...base.staffHeader, dinnerAllowanceMinor: 45_000 } };
    render(<StayExtraGate initial={initial} seen={seen} />);
    const runButtons = () => [
      screen.getByRole('button', { name: 'Search this date range for Stay 1' }) as HTMLButtonElement,
      screen.getByRole('button', { name: 'Search this date range for Stay 2' }) as HTMLButtonElement,
    ];
    expect(runButtons().every((button) => !button.disabled)).toBe(true);
    const dinner = within(screen.getAllByRole('group', { name: /^Extras for Stay / })[0]!).getByLabelText(
      'Dinner allowance amount',
    ) as HTMLInputElement;
    fireEvent.focus(dinner);
    fireEvent.change(dinner, { target: { value: '450,50x' } });
    expect(runButtons()[0]!.disabled).toBe(true);
    expect(runButtons()[1]!.disabled).toBe(false);
    expect(screen.getAllByText(/Fix the amounts before running this search\. Dinner allowance:/).length).toBeGreaterThan(0);
    expect(seen.latest?.staffHeader.stayExtrasByKey?.[key]?.dinnerAllowanceMinor).toBe(45_000);
    fireEvent.change(dinner, { target: { value: '' } });
    fireEvent.blur(dinner);
    expect(seen.latest?.staffHeader.stayExtrasByKey?.[key]?.dinnerAllowanceMinor).toBeUndefined();
    expect(seen.latest?.staffHeader.stayExtrasByKey?.[key]?.fieldErrors?.dinnerAllowance).toBeUndefined();
    expect(runButtons()[0]!.disabled).toBe(false);
    expect(runButtons()[1]!.disabled).toBe(false);
  });

  it('puts Download Excel under the PDF button and passes the click on', () => {
    const onDownloadWorkbook = vi.fn();
    const ready = {
      ...sessionFromFixture('public-single'),
      staffSource: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) },
      evidence: { kind: 'authorised' as const, selectionEpoch: 1, inputRevision: 1 },
      selectedOfferIds: ['pub-1'],
      reviewedReplyHtml: '<p>Full staff-edited reply</p>',
    };
    render(<QuoteWorkflowPanel session={ready} onDownloadWorkbook={onDownloadWorkbook} />);
    const pdf = screen.getByRole('button', { name: /^Prepare PDF$/i }) as HTMLButtonElement;
    const excel = screen.getByRole('button', { name: 'Download Excel' }) as HTMLButtonElement;
    expect(pdf.compareDocumentPosition(excel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(excel.disabled).toBe(false);
    fireEvent.click(excel);
    expect(onDownloadWorkbook).toHaveBeenCalledTimes(1);
  });

  it('keeps Download Excel disabled until a handler is wired', () => {
    const ready = {
      ...sessionFromFixture('public-single'),
      staffSource: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) },
      evidence: { kind: 'authorised' as const, selectionEpoch: 1, inputRevision: 1 },
      selectedOfferIds: ['pub-1'],
      reviewedReplyHtml: '<p>Full staff-edited reply</p>',
    };
    render(<QuoteWorkflowPanel session={ready} />);
    expect((screen.getByRole('button', { name: 'Download Excel' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps one primary search action and offers per-date retries as secondary actions', () => {
    const onRunStep = vi.fn();
    const session = staggeredDatesSession();
    render(<QuoteWorkflowPanel session={session} onRunStep={onRunStep} onRunNext={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: 'Search availability' })).toHaveLength(1);
    const dateRange = screen.getByRole('button', { name: 'Search this date range for Stay 2' }) as HTMLButtonElement;
    expect(dateRange.disabled).toBe(false);
    expect(dateRange.className).toContain('border');
    fireEvent.click(dateRange);
    expect(onRunStep).toHaveBeenCalledWith(session.steps[1]!.id);
  });

  it('lists each date range as its own stay and totals the quote across stays', () => {
    const onRunStep = vi.fn();
    const quoted = staggeredDatesWithOptionA();
    render(<QuoteWorkflowPanel session={quoted} onRunStep={onRunStep} onRunNext={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /Stay 1 of 2/ })).toBeDefined();
    expect(screen.getByRole('heading', { name: /Stay 2 of 2/ })).toBeDefined();
    expect(
      screen.getAllByRole('button', { name: 'Stay information' }).map((button) => button.getAttribute('title')),
    ).toEqual([
      'One stay = one date range = one HMS booking.',
      'One stay = one date range = one HMS booking.',
    ]);
    expect(screen.getByRole('article', { name: 'Stay 1 details' }).textContent).not.toMatch(/Separate HMS booking/);
    expect(screen.getByRole('article', { name: 'Stay 2 details' }).textContent).not.toMatch(/Separate HMS booking/);
    expect(screen.getAllByText('1 of 2 stays rated').length).toBeGreaterThan(0);
    const firstSubtotal = screen.getAllByText('Stay subtotal')[0]!;
    const addRange = screen.getByRole('button', { name: '+ Add another date range' });
    const allStaysTotal = screen.getByRole('heading', { name: 'Quotation total (all stays)' });
    expect(addRange.compareDocumentPosition(firstSubtotal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(addRange.compareDocumentPosition(allStaysTotal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const runB = screen.getByRole('button', { name: 'Search availability' }) as HTMLButtonElement;
    expect(runB.disabled).toBe(false);
    fireEvent.click(runB);
    expect(onRunStep).toHaveBeenCalledWith(quoted.steps[1]!.id);
  });

  it('two extracted stays on the same dates render as one card with both room rows', () => {
    const quoted = staggeredDatesWithOptionA();
    const row = quoted.groups[0]!;
    const sameDates = { ...quoted, groups: [row, { ...row, id: `${row.id}-copy`, stayId: 'stay-copy' }] };
    render(<QuoteWorkflowPanel session={sameDates} />);
    expect(screen.getByRole('heading', { name: /Stay 1 of 1/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Stay 2 of 2/ })).toBeNull();
    expect(screen.getAllByRole('group', { name: /^Rooms for stay 1, room \d$/ })).toHaveLength(2);
    expect(screen.queryByText('Counted in Stay 1')).toBeNull();
  });

  it('a government default still lists the returned rates when the catalogue query failed', () => {
    const base = sessionFromFixture('public-single');
    const ngovb: RateOption = {
      id: 'o-ngovb',
      groupId: base.groups[0]!.id,
      rateCode: 'NGOVB',
      rateLabel: 'Government rate',
      roomCode: 'STWN',
      roomLabel: 'Standard Twin',
      board: 'bb',
      boardLabel: 'Bed & breakfast',
      contract: false,
      onlyContract: false,
      matchesRequest: true,
      perNightMinor: 150000,
      totalMinor: 300000,
      currency: 'ZAR',
      priced: 'full',
      selected: false,
    };
    const session = {
      ...base,
      staffHeader: { ...base.staffHeader, salesStrategy: 'Government' },
      rateOptions: [ngovb],
    } as never;
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.queryByText(/No rates match this filter/)).toBeNull();
    expect(screen.getByRole('button', { name: /NGOVB/ })).toBeDefined();
  });

  it('shows one combined quote once it is prepared, with no PDF per option', () => {
    const session = {
      ...staggeredDatesWithOptionA(),
      pdf: {
        fileName: 'Quote - Standard King.pdf',
        bytesBase64: 'JVBERi0xLjQK',
        pdfHash: 'cd'.repeat(32),
        revisionId: 'quotes:abc',
        totalMinor: 850000,
      },
    };
    render(<QuoteWorkflowPanel session={session} onRunStep={vi.fn()} onRunNext={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Prepare PDF for option/ })).toBeNull();
    expect(screen.getByText(/Prepared quote Quote - Standard King\.pdf for all stays/)).toBeDefined();
  });

  it('gates the one Prepare quote button on every stay and has no per-option PDF button', () => {
    const onPreparePdf = vi.fn();
    render(
      <QuoteWorkflowPanel
        session={staggeredDatesWithOptionA()}
        onPreparePdf={onPreparePdf}
        onRunStep={vi.fn()}
        onRunNext={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Prepare PDF for option A' })).toBeNull();
    const prepare = screen.getByRole('button', { name: 'Prepare quote' }) as HTMLButtonElement;
    expect(prepare.disabled).toBe(true);
    fireEvent.click(prepare);
    expect(onPreparePdf).not.toHaveBeenCalled();
  });
});

const BINDING = {
  transportId: 't1',
  mailboxEmail: 'centurion@legacyhotels.co.za',
  storeId: 'store',
  folderEntryId: 'inbox',
  entryId: 'e1',
  selectionEpoch: 1,
  scopeEpoch: 1,
};

/** The panel with its per-stay extras held by the real reducer, as the page does. */
function StayExtraGate({ initial, seen }: { initial: QuoteSession; seen: { latest: QuoteSession | null } }) {
  const [session, setSession] = useState(initial);
  seen.latest = session;
  return (
    <QuoteWorkflowPanel
      session={session}
      onPatchStayExtras={(stayKey, extras) =>
        setSession((current) => reduceQuoteSession(current, { type: 'patch_staff_stay_extras', stayKey, extras }))
      }
      onRunStep={vi.fn()}
      onRunNext={vi.fn()}
    />
  );
}

function staggeredDatesSession() {
  let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: BINDING });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: {
      intent: 'quote',
      groups: loadQuoteFixture('staggered-dates').groups,
      secondaryAsks: [],
      alternatives: [],
    },
  });
  return reduceQuoteSession(session, {
    type: 'staff_source_ready',
    source: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) },
  });
}

/** Same two options, with option A (2 Nov) quoted and its PDF not yet built. */
function staggeredDatesWithOptionA(): QuoteSession {
  const session = staggeredDatesSession();
  return reduceQuoteSession(session, {
    type: 'staff_quote_ready',
    offer: {
      id: 'rev-a',
      kind: 'allocation',
      roomCode: 'SKNG',
      roomLabel: 'Standard King',
      board: 'bb',
      rateCode: 'BAR',
      currency: 'ZAR',
      nightly: [],
      stayTotalMinor: 850000,
      observedAt: '2026-10-05T12:00:00Z',
      sourceRef: 'rev-a',
      restrictions: [],
      combinable: true,
      quoteRequestKey: '2026-11-02:2026-11-04',
      coversGroupIds: ['stay-a'],
      quantity: 1,
      adults: 1,
    },
    staffQuote: {
      workflowRunId: 'run-a',
      revisionRef: 'rev-a',
      factRefs: [],
      messageId: 'mail-1',
      threadId: 'thread-1',
      sourceHash: 'ab'.repeat(32),
      selectionEpoch: 1,
      inputRevision: session.inputRevision,
      inputDigest: 'digest-a',
      totalMinor: 850000,
      currency: 'ZAR',
      quoteRequestKey: '2026-11-02:2026-11-04',
      approvedHeader: {
        salesStrategy: 'BAR',
        company: '',
        agency: '',
        attention: '',
        clientEmail: '',
        clientTelephone: '',
      },
    },
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
  });
}

describe('the Find in HMS picker in the quote header', () => {
  const ACME = { kind: 'company' as const, nativeId: 'C-100', name: 'Acme Travel' };
  const TRAVEL_HUB = { kind: 'agency' as const, nativeId: 'A-7', name: 'Travel Hub' };
  const noMatch = async () => ({ outcome: 'no_match' as const, results: [], truncated: false });

  function headerSession(staffHeader: Partial<QuoteSession['staffHeader']>): QuoteSession {
    const base = sessionFromFixture('agency-contract');
    return { ...base, offers: [], phase: 'requirements', staffHeader: { ...base.staffHeader, ...staffHeader } };
  }

  it('shows the rate selector above the availability action before rates are read', () => {
    const session = headerSession({ company: 'Sample Company', parties: {} });
    expect(session.rateOptions ?? []).toHaveLength(0);
    const { container } = render(<QuoteWorkflowPanel session={session} />);
    const ratesStep = container.querySelector<HTMLElement>('#quote-rates');
    if (!ratesStep) throw new Error('Expected the nested Availability & rates controls.');
    const planSelect = within(ratesStep).getByLabelText('Rate plan');
    const searchAction = within(ratesStep).getByRole('button', { name: 'Search availability' });
    expect(
      planSelect.compareDocumentPosition(searchAction) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Applies each header patch through the real reducer, so a test reads the header the quote would send.
  function PartyGate({
    initial,
    seen,
    findParty,
  }: {
    initial: QuoteSession;
    seen: { latest: QuoteSession | null };
    findParty: typeof noMatch;
  }) {
    const [session, setSession] = useState(initial);
    seen.latest = session;
    return (
      <QuoteWorkflowPanel
        session={session}
        findParty={findParty}
        onPatchStaffHeader={(header) =>
          setSession((current) => reduceQuoteSession(current, { type: 'patch_staff_header', header }))
        }
      />
    );
  }

  it('lists every catalogue rate plan and reflects an auto-selected government party', () => {
    const rateCatalogue: RatePlanCatalogueEntry[] = CENTURION_RATE_PLANS;
    const session = headerSession({});
    const { unmount } = render(
      <QuoteWorkflowPanel session={session} rateCatalogue={rateCatalogue as never} />,
    );
    assertRatePlanVisible();
    const planSelect = screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement;
    const values = [...planSelect.options].map((option) => option.value);
    // The fixture asks Dinner B&B on every row, so the plan defaults to Government.
    expect(planSelect.value).toBe('government');
    expect(values).toEqual(
      expect.arrayContaining([
        'all', 'BAR', 'BARRO', 'DBB', 'DBBX', 'NCOR1B', 'NCOR2B', 'GNC3B', 'GNC4B',
        'BCO1B', 'BCO2B', 'BBP', 'BWKPB', 'NGOVB',
      ]),
    );
    expect(planSelect.querySelector('optgroup[label="Contract"]')?.querySelector('option[value="BCO1B"]')).not.toBeNull();
    expect(planSelect.querySelector('optgroup[label="Other HMS rates"] option[value="GNC3B"]')).not.toBeNull();
    expect(planSelect.querySelector('optgroup[label="Other HMS rates"] option[value="GNC4B"]')).not.toBeNull();
    unmount();

    const governmentAnalysis = {
      ...session.analysis!,
      luna: {
        workflow: 'quote' as const,
        flags: [],
        groups: [],
        party: { kind: 'government' as const, name: 'Department X', reference: null },
        rateClaims: [],
        missing: [],
        evidence: [],
        tasks: [],
      },
    };
    const governmentSession = reduceQuoteSession(session, {
      type: 'analysis_ready',
      analysis: governmentAnalysis,
    });
    expect(governmentSession.staffHeader.salesStrategy).toBe('Government');
    render(<QuoteWorkflowPanel session={governmentSession} rateCatalogue={rateCatalogue as never} />);
    assertRatePlanVisible();
    expect((screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement).value).toBe('government');
    expect(screen.getByRole('option', { name: 'All government rates' })).toBeDefined();
  });

  it('stores the exact room, rate and board tuple selected for its Stay', () => {
    const base = sessionFromFixture('public-single');
    const firstGroupId = 'grid-stay-first';
    const selectedGroupId = 'grid-stay-selected';
    const firstStayKey = '2026-11-12:2026-11-14';
    const selectedStayKey = '2026-12-12:2026-12-14';
    const sourceGroup = base.groups[0]!;
    const firstGroup = {
      ...sourceGroup,
      id: firstGroupId,
      stayId: firstGroupId,
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
    };
    const selectedGroup = {
      ...sourceGroup,
      id: selectedGroupId,
      stayId: selectedGroupId,
      arrivalDate: '2026-12-12',
      departureDate: '2026-12-14',
    };
    const quoteBase = base.staffQuote ?? base.staffQuotes[firstStayKey] ?? {
      workflowRunId: 'run-1',
      revisionRef: 'rev-1',
      factRefs: [],
      messageId: 'mail-1',
      threadId: 'thread-1',
      sourceHash: 'ab'.repeat(32),
      selectionEpoch: 1,
      inputRevision: 1,
      inputDigest: 'digest',
      totalMinor: 200_000,
      currency: 'ZAR',
      quoteRequestKey: firstStayKey,
      approvedHeader: base.staffHeader,
    };
    const firstQuote = {
      ...quoteBase,
      quoteRequestKey: firstStayKey,
      rateOptions: [],
      availabilityTruncated: false,
      availabilityBoard: [
        {
          groupId: firstGroupId,
          roomCode: 'STQN',
          roomLabel: 'Standard Queen',
          rateCode: 'BAR',
          rateLabel: 'Best Available Rate',
          board: 'bb',
          boardLabel: 'Bed & Breakfast',
          nightlyPriceMinor: 100_000,
          roomsLeft: 4,
        },
      ],
    };
    const selectedQuote = {
      ...quoteBase,
      quoteRequestKey: selectedStayKey,
      rateOptions: [],
      availabilityTruncated: true,
      availabilityBoard: [
        {
          groupId: selectedGroupId,
          roomCode: 'STQN',
          roomLabel: 'Standard Queen',
          rateCode: 'BAR',
          rateLabel: 'Best Available Rate',
          board: 'bb',
          boardLabel: 'Bed & Breakfast',
          nightlyPriceMinor: 100_000,
          roomsLeft: 4,
        },
        {
          groupId: selectedGroupId,
          roomCode: 'STWN',
          roomLabel: 'Standard Twin',
          rateCode: 'FLEX',
          rateLabel: 'Flexible Rate',
          board: 'dinner_bb',
          boardLabel: 'Dinner B&B',
          nightlyPriceMinor: null,
          roomsLeft: null,
        },
      ],
    };
    const seen = { latest: null as QuoteSession | null };
    render(
      <EditableStayPanel
        seen={seen}
        initial={{
          ...base,
          groups: [firstGroup, selectedGroup],
          selectedStayKey: firstStayKey,
          rateOptions: [],
          staffQuote: firstQuote,
          staffQuotes: {
            ...base.staffQuotes,
            [firstStayKey]: firstQuote,
            [selectedStayKey]: selectedQuote,
          },
        }}
      />,
    );
    const grids = screen.getAllByRole('group', { name: 'Room, rate and board choices' });
    expect(grids).toHaveLength(2);
    const grid = grids[1]!;
    const queen = within(grid).getByRole('button', {
      name: /Select Standard Queen \(STQN\), Best Available Rate \(BAR\)/,
    });
    const twin = within(grid).getByRole('button', {
      name: /Select Standard Twin \(STWN\), Flexible Rate \(FLEX\)/,
    });

    fireEvent.click(twin);

    expect(seen.latest?.roomRateBoardSelections).toEqual({
      [selectedGroupId]: { roomCode: 'STWN', rateCode: 'FLEX', board: 'dinner_bb' },
    });
    expect(queen.getAttribute('aria-pressed')).toBe('false');
    expect(twin.getAttribute('aria-pressed')).toBe('true');
  });

  it('binds admitted all-room availability only to the matching Stay', async () => {
    const base = sessionFromFixture('public-single');
    const first = {
      ...base.groups[0]!,
      id: 'availability-stay-1',
      stayId: 'extracted-stay-1',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      roomPreference: 'Requested queen',
      roomTypeCode: undefined,
      roomCodes: undefined,
      quantity: 1,
      adults: 2,
      childrenAges: [],
    };
    const second = {
      ...base.groups[0]!,
      id: 'availability-stay-2',
      stayId: 'extracted-stay-2',
      arrivalDate: '2026-12-12',
      departureDate: '2026-12-14',
      roomPreference: 'Requested twin',
      roomTypeCode: undefined,
      roomCodes: undefined,
      quantity: 1,
      adults: 1,
      childrenAges: [],
    };
    const session: QuoteSession = {
      ...base,
      binding: { ...base.binding!, threadId: 'availability-thread' },
      groups: [first, second],
    };
    const firstRequest = {
      threadId: 'availability-thread',
      kind: 'availability' as const,
      arrival: first.arrivalDate!,
      departure: first.departureDate!,
      rooms: [{ roomType: first.roomPreference!, quantity: 1, adults: 2, childAges: [] }],
    };
    const secondRequest = {
      threadId: 'availability-thread',
      kind: 'availability' as const,
      arrival: second.arrivalDate!,
      departure: second.departureDate!,
      rooms: [{ roomType: second.roomPreference!, quantity: 1, adults: 1, childAges: [] }],
    };
    const asOf = new Date().toISOString();
    const firstView = {
      runId: 'availability-run-1',
      request: {
        kind: firstRequest.kind,
        arrival: firstRequest.arrival,
        departure: firstRequest.departure,
        rooms: firstRequest.rooms,
      },
      prefetch: true,
      status: 'done' as const,
      position: null,
      attempts: 1,
      failureClass: null,
      asOf,
      outcome: null,
      result: {
        outcome: 'read',
        roomScope: 'all_room_types',
        searchOutcome: 'partial',
        observedAt: asOf,
        availableOptions: 1,
        groups: [{
          id: 'group-1',
          outcome: 'partial',
          options: [{ room: 'DVQ', roomLabel: 'Property Queen', availability: 'available' }],
        }],
      },
    };
    const readAvailability = vi.fn(async (request: { arrival: string }) =>
      request.arrival === firstRequest.arrival ? firstView : null,
    );
    const onPatchGroup = vi.fn();
    const paneConfig: QuotePaneConfig = {
      transportId: 't1',
      propertyCode: HRDAV_PROPERTY_CODE,
      roomTypes: [{ code: 'DVQ', label: 'Property Queen' }],
      ratePlans: [],
      boards: ['bb'],
      salesStrategies: [{ code: 'BAR', label: 'Best Available Rate', requestValue: 'BAR' }],
      overrideRateCodes: [],
      eventRateCodes: [],
    };

    render(
      <QuoteWorkflowPanel
        session={session}
        availabilityReader={readAvailability}
        paneConfig={paneConfig}
        onPatchGroup={onPatchGroup}
      />,
    );

    const availableRoom = await screen.findByRole('button', {
      name: 'Use Property Queen for stay 1, room 1',
    });
    expect(readAvailability).toHaveBeenCalledWith(firstRequest);
    expect(readAvailability).toHaveBeenCalledWith(secondRequest);
    expect(screen.getByText('No admitted availability snapshot for this stay. Continue with manual room selection.')).toBeDefined();
    expect(
      screen.queryByRole('button', { name: 'Use Property Queen for stay 2, room 1' }),
    ).toBeNull();

    fireEvent.click(availableRoom);
    expect(onPatchGroup).toHaveBeenCalledWith(
      first.id,
      expect.objectContaining({ roomPreference: 'DVQ' }),
    );
  });

  it('keeps remaining all-room choices after selecting a room in the same Stay', async () => {
    const base = sessionFromFixture('public-single');
    const first = {
      ...base.groups[0]!,
      id: 'availability-room-1',
      stayId: 'extracted-stay',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      roomPreference: 'Requested queen',
      roomTypeCode: undefined,
      roomCodes: undefined,
      quantity: 1,
      adults: 2,
      childrenAges: [],
    };
    const second = {
      ...base.groups[0]!,
      id: 'availability-room-2',
      stayId: 'extracted-stay',
      arrivalDate: first.arrivalDate,
      departureDate: first.departureDate,
      roomPreference: 'Requested twin',
      roomTypeCode: undefined,
      roomCodes: undefined,
      quantity: 1,
      adults: 2,
      childrenAges: [],
    };
    const session: QuoteSession = {
      ...base,
      binding: { ...base.binding!, threadId: 'availability-thread', transportId: 'test-transport' },
      groups: [first, second],
    };
    const originalRoomTypes = ['Requested queen', 'Requested twin'];
    const asOf = new Date().toISOString();
    const snapshot = {
      status: 'done' as const,
      asOf,
      result: {
        outcome: 'read',
        roomScope: 'all_room_types',
        observedAt: asOf,
        groups: [
          {
            id: 'group-1',
            options: [{ room: 'TEST-QUEEN', availability: 'available' }],
          },
          {
            id: 'group-2',
            options: [{ room: 'TEST-TWIN', availability: 'available' }],
          },
        ],
      },
    };
    const readAvailability = vi.fn(async (request: {
      arrival: string;
      departure: string;
      rooms: Array<{ roomType: string }>;
    }) =>
      request.arrival === first.arrivalDate &&
      request.departure === first.departureDate &&
      request.rooms.map((room) => room.roomType).join('|') === originalRoomTypes.join('|')
        ? snapshot
        : null,
    );
    const paneConfig: QuotePaneConfig = {
      transportId: 'test-transport',
      propertyCode: HRDAV_PROPERTY_CODE,
      roomTypes: [
        { code: 'TEST-QUEEN', label: 'Example Queen' },
        { code: 'TEST-TWIN', label: 'Example Twin' },
      ],
      ratePlans: [],
      boards: ['bb'],
      salesStrategies: [{ code: 'BAR', label: 'Best Available Rate', requestValue: 'BAR' }],
      overrideRateCodes: [],
      eventRateCodes: [],
    };
    let currentSession: QuoteSession = session;
    const onPatchGroup = vi.fn((groupId: string, patch: Partial<StayGroupRequirement>) => {
      currentSession = {
        ...currentSession,
        groups: currentSession.groups.map((row) =>
          row.id === groupId ? { ...row, ...patch } : row,
        ),
      };
    });
    const panel = (value: QuoteSession) => (
      <QuoteWorkflowPanel
        session={value}
        availabilityReader={readAvailability}
        paneConfig={paneConfig}
        onPatchGroup={onPatchGroup}
      />
    );
    const { rerender } = render(panel(currentSession));

    const queen = await screen.findByRole('button', {
      name: 'Use Example Queen for stay 1, room 1',
    });
    expect(
      await screen.findByRole('button', { name: 'Use Example Twin for stay 1, room 2' }),
    ).toBeDefined();
    const readsBeforePick = readAvailability.mock.calls.length;

    fireEvent.click(queen);
    expect(onPatchGroup).toHaveBeenCalledWith(
      first.id,
      expect.objectContaining({ roomPreference: 'TEST-QUEEN' }),
    );
    rerender(panel(currentSession));

    await waitFor(() => expect(readAvailability).toHaveBeenCalledTimes(readsBeforePick));
    expect(
      screen.getByRole('button', { name: 'Use Example Twin for stay 1, room 2' }),
    ).toBeDefined();
  });

  it('does not reuse admitted availability after Stay occupancy changes', async () => {
    const base = sessionFromFixture('public-single');
    const group = {
      ...base.groups[0]!,
      id: 'availability-room',
      stayId: 'extracted-stay',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      roomPreference: 'Requested queen',
      roomTypeCode: undefined,
      roomCodes: undefined,
      quantity: 1,
      adults: 2,
      childrenAges: [],
    };
    const session: QuoteSession = {
      ...base,
      binding: { ...base.binding!, threadId: 'availability-thread', transportId: 'test-transport' },
      groups: [group],
    };
    const asOf = new Date().toISOString();
    const snapshot = {
      status: 'done' as const,
      asOf,
      result: {
        outcome: 'read',
        roomScope: 'all_room_types',
        observedAt: asOf,
        groups: [{
          id: 'group-1',
          options: [{ room: 'TEST-QUEEN', availability: 'available' }],
        }],
      },
    };
    const readAvailability = vi.fn(async (request: { rooms: Array<{ adults: number }> }) =>
      request.rooms[0]?.adults === 2 ? snapshot : null,
    );
    const paneConfig: QuotePaneConfig = {
      transportId: 'test-transport',
      propertyCode: HRDAV_PROPERTY_CODE,
      roomTypes: [{ code: 'TEST-QUEEN', label: 'Example Queen' }],
      ratePlans: [],
      boards: ['bb'],
      salesStrategies: [{ code: 'BAR', label: 'Best Available Rate', requestValue: 'BAR' }],
      overrideRateCodes: [],
      eventRateCodes: [],
    };
    const panel = (value: QuoteSession) => (
      <QuoteWorkflowPanel
        session={value}
        availabilityReader={readAvailability}
        paneConfig={paneConfig}
        onPatchGroup={vi.fn()}
      />
    );
    const { rerender } = render(panel(session));

    expect(
      await screen.findByRole('button', { name: 'Use Example Queen for stay 1, room 1' }),
    ).toBeDefined();
    rerender(panel({ ...session, groups: [{ ...group, adults: 3 }] }));

    await waitFor(() =>
      expect(readAvailability).toHaveBeenCalledWith(
        expect.objectContaining({ rooms: [expect.objectContaining({ adults: 3 })] }),
      ),
    );
    expect(
      screen.queryByRole('button', { name: 'Use Example Queen for stay 1, room 1' }),
    ).toBeNull();
  });

  it('keeps availability rows empty when the snapshot admission was denied', async () => {
    const base = sessionFromFixture('public-single');
    const group = {
      ...base.groups[0]!,
      id: 'availability-stay',
      stayId: 'extracted-stay',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      roomPreference: 'Requested queen',
      roomTypeCode: undefined,
      roomCodes: undefined,
      quantity: 1,
      adults: 2,
      childrenAges: [],
    };
    const session: QuoteSession = {
      ...base,
      binding: { ...base.binding!, threadId: 'availability-thread' },
      groups: [group],
    };
    const readAvailability = vi.fn(async () => ({
      runId: 'availability-run-denied',
      request: {
        kind: 'availability' as const,
        arrival: group.arrivalDate!,
        departure: group.departureDate!,
        rooms: [{ roomType: group.roomPreference!, quantity: 1, adults: 2, childAges: [] }],
      },
      prefetch: true,
      status: 'failed' as const,
      position: null,
      attempts: 1,
      failureClass: 'POLICY_REFUSED',
      asOf: null,
      outcome: null,
      result: null,
    }));
    const paneConfig: QuotePaneConfig = {
      transportId: 't1',
      propertyCode: HRDAV_PROPERTY_CODE,
      roomTypes: [{ code: 'DVQ', label: 'Property Queen' }],
      ratePlans: [],
      boards: ['bb'],
      salesStrategies: [{ code: 'BAR', label: 'Best Available Rate', requestValue: 'BAR' }],
      overrideRateCodes: [],
      eventRateCodes: [],
    };
    render(<QuoteWorkflowPanel session={session} availabilityReader={readAvailability} paneConfig={paneConfig} />);

    await waitFor(() => expect(readAvailability).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Availability was not admitted for this stay. Continue with manual room selection.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Use .* for stay 1, room 1/ })).toBeNull();
  });

  it('does not select snapshot rooms when this property has no configuration', async () => {
    const base = sessionFromFixture('public-single');
    const group = {
      ...base.groups[0]!,
      id: 'availability-stay',
      stayId: 'extracted-stay',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      roomPreference: 'Requested queen',
      roomTypeCode: undefined,
      roomCodes: undefined,
      quantity: 1,
      adults: 2,
      childrenAges: [],
    };
    const session: QuoteSession = {
      ...base,
      binding: { ...base.binding!, threadId: 'availability-thread' },
      groups: [group],
    };
    const request = {
      kind: 'availability' as const,
      arrival: group.arrivalDate!,
      departure: group.departureDate!,
      rooms: [{ roomType: group.roomPreference!, quantity: 1, adults: 2, childAges: [] }],
    };
    const asOf = new Date().toISOString();
    const readAvailability = vi.fn(async () => ({
      runId: 'availability-run-1',
      request,
      prefetch: true,
      status: 'done' as const,
      position: null,
      attempts: 1,
      failureClass: null,
      asOf,
      outcome: null,
      result: {
        outcome: 'read',
        roomScope: 'all_room_types',
        searchOutcome: 'partial',
        observedAt: asOf,
        availableOptions: 1,
        groups: [{
          id: 'group-1',
          outcome: 'partial',
          options: [{ room: 'DVQ', roomLabel: 'Property Queen', availability: 'available' }],
        }],
      },
    }));
    render(<QuoteWorkflowPanel session={session} availabilityReader={readAvailability} paneConfig={null} />);

    expect(readAvailability).not.toHaveBeenCalled();
    expect(screen.getByText('Availability room options are unavailable for this property.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Use .* for stay 1, room 1/ })).toBeNull();
  });

  it('does not make a prior-day availability snapshot selectable', async () => {
    const base = sessionFromFixture('public-single');
    const group = {
      ...base.groups[0]!,
      id: 'availability-stay',
      stayId: 'extracted-stay',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      roomPreference: 'Requested queen',
      roomTypeCode: undefined,
      roomCodes: undefined,
      quantity: 1,
      adults: 2,
      childrenAges: [],
    };
    const session: QuoteSession = {
      ...base,
      binding: { ...base.binding!, threadId: 'availability-thread' },
      groups: [group],
    };
    const request = {
      threadId: 'availability-thread',
      kind: 'availability' as const,
      arrival: group.arrivalDate!,
      departure: group.departureDate!,
      rooms: [{ roomType: group.roomPreference!, quantity: 1, adults: 2, childAges: [] }],
    };
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const readAvailability = vi.fn(async () => ({
      runId: 'availability-run-old',
      request: {
        kind: request.kind,
        arrival: request.arrival,
        departure: request.departure,
        rooms: request.rooms,
      },
      prefetch: true,
      status: 'done' as const,
      position: null,
      attempts: 1,
      failureClass: null,
      asOf: yesterday,
      outcome: null,
      result: {
        outcome: 'read',
        roomScope: 'all_room_types',
        searchOutcome: 'partial',
        observedAt: yesterday,
        availableOptions: 1,
        groups: [{
          id: 'group-1',
          outcome: 'partial',
          options: [{ room: 'DVQ', roomLabel: 'Property Queen', availability: 'available' }],
        }],
      },
    }));
    const paneConfig: QuotePaneConfig = {
      transportId: 't1',
      propertyCode: HRDAV_PROPERTY_CODE,
      roomTypes: [{ code: 'DVQ', label: 'Property Queen' }],
      ratePlans: [],
      boards: ['bb'],
      salesStrategies: [{ code: 'BAR', label: 'Best Available Rate', requestValue: 'BAR' }],
      overrideRateCodes: [],
      eventRateCodes: [],
    };

    render(<QuoteWorkflowPanel session={session} availabilityReader={readAvailability} paneConfig={paneConfig} />);

    await waitFor(() => expect(readAvailability).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Availability snapshot is out of date. Search availability for current results.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Use .* for stay 1, room 1/ })).toBeNull();
  });

  it('filters returned rate cards locally without clearing the quoted HMS results', () => {
    const rateOptions: RateOption[] = [
      {
        id: 'g1:BAR',
        groupId: 'g1',
        board: 'bb',
        boardLabel: 'Bed & Breakfast',
        rateCode: 'BAR',
        rateLabel: 'Best Available Rate',
        roomCode: 'STQN',
        roomLabel: 'Standard Queen',
        contract: false,
        onlyContract: false,
        matchesRequest: true,
        perNightMinor: 100_000,
        totalMinor: 200_000,
        currency: 'ZAR',
        priced: 'summary',
        selected: true,
      },
      {
        id: 'g1:NCOR1B',
        groupId: 'g1',
        board: 'bb',
        boardLabel: 'Bed & Breakfast',
        rateCode: 'NCOR1B',
        rateLabel: 'Corporate Negotiated',
        roomCode: 'STQN',
        roomLabel: 'Standard Queen',
        contract: true,
        onlyContract: false,
        matchesRequest: true,
        perNightMinor: 90_000,
        totalMinor: 180_000,
        currency: 'ZAR',
        priced: 'summary',
        selected: false,
      },
    ];
    const session = { ...sessionFromFixture('public-single'), rateOptions };
    const rateCatalogue: RatePlanCatalogueEntry[] = [
      { code: 'BAR', name: 'Best Available Rate', board: 'bed_breakfast' },
      { code: 'NCOR1B', name: 'Corporate Negotiated', board: 'unknown', contract: true },
      { code: 'NCOR2B', name: 'Corporate Negotiated 2', board: 'unknown', contract: true },
    ];

    function FilterHarness() {
      const [current, setCurrent] = useState<QuoteSession>(session);
      return (
        <QuoteWorkflowPanel
          session={current}
          rateCatalogue={rateCatalogue}
          onPatchStaffHeader={(header) =>
            setCurrent((previous) => reduceQuoteSession(previous, { type: 'patch_staff_header', header }))
          }
        />
      );
    }

    const { container } = render(<FilterHarness />);
    assertRatePlanVisible();
    const ratesStep = container.querySelector<HTMLElement>('#quote-rates');
    if (!ratesStep) throw new Error('Expected the nested Availability & rates controls.');
    const planSelect = within(ratesStep).getByLabelText('Rate plan') as unknown as HTMLSelectElement;
    const barCard = within(ratesStep).getByRole('button', { name: /Best Available Rate BAR/ });
    expect(planSelect.compareDocumentPosition(barCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(planSelect.querySelector('option[value="BAR"]')?.textContent).toContain('(read by Nava)');
    const contractOptions = Array.from(
      planSelect.querySelector('optgroup[label="Contract"]')?.querySelectorAll<HTMLOptionElement>('option') ?? [],
    );
    expect(contractOptions.map((option) => option.value)).toEqual(['NCOR1B', 'NCOR2B']);
    expect(contractOptions[0]?.textContent).toContain('(read by Nava)');
    expect(contractOptions[1]?.textContent).not.toContain('(read by Nava)');
    expect(
      Array.from(planSelect.options).every((option) => !/\bR\d[\d,.]*/.test(option.textContent ?? '')),
    ).toBe(true);
    fireEvent.change(planSelect, { target: { value: 'NCOR1B' } });

    expect(planSelect.value).toBe('NCOR1B');
    expect(within(ratesStep).queryByRole('button', { name: /Best Available Rate BAR/ })).toBeNull();
    expect(within(ratesStep).getByRole('button', { name: /Corporate Negotiated NCOR1B/ })).toBeDefined();
  });

  it('a government plan asks HMS for Government pricing; a public plan goes back to BAR', () => {
    const onPatchStaffHeader = vi.fn();
    const base = sessionFromFixture('public-single');
    const rateCatalogue: RatePlanCatalogueEntry[] = [
      { code: 'BAR', name: 'Best Available Rate', board: 'bed_breakfast' },
      { code: 'NGOVB', name: 'NGOVB', board: 'unknown', government: true },
    ];
    const first = render(
      <QuoteWorkflowPanel session={base} rateCatalogue={rateCatalogue} onPatchStaffHeader={onPatchStaffHeader} />,
    );
    assertRatePlanVisible();
    fireEvent.change(screen.getByLabelText('Rate plan'), { target: { value: 'NGOVB' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'Government' }, { staffEdit: true });
    first.unmount();

    const governmentSession = { ...base, staffHeader: { ...base.staffHeader, salesStrategy: 'Government' } } as never;
    render(
      <QuoteWorkflowPanel session={governmentSession} rateCatalogue={rateCatalogue} onPatchStaffHeader={onPatchStaffHeader} />,
    );
    assertRatePlanVisible();
    expect((screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement).value).toBe('government');
    fireEvent.change(screen.getByLabelText('Rate plan'), { target: { value: 'BAR' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'BAR' }, { staffEdit: true });
  });

  // Greptile P1 (PR #187): the Rate plan select must always be able to restore BAR.
  function RatePlanGate({
    initial,
    onPatch,
  }: {
    initial: QuoteSession;
    onPatch: (header: Partial<QuoteSession['staffHeader']>) => void;
  }) {
    const [current, setCurrent] = useState<QuoteSession>(initial);
    return (
      <QuoteWorkflowPanel
        session={current}
        rateCatalogue={[]}
        onPatchStaffHeader={(header) => {
          onPatch(header);
          setCurrent((previous) => reduceQuoteSession(previous, { type: 'patch_staff_header', header }));
        }}
      />
    );
  }

  it('catalogue down: All rates restores BAR after a government pick, and public is offered', () => {
    const onPatchStaffHeader = vi.fn();
    render(<RatePlanGate initial={sessionFromFixture('public-single')} onPatch={onPatchStaffHeader} />);
    const planSelect = screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement;
    expect([...planSelect.options].map((option) => option.value)).toEqual(
      expect.arrayContaining(['all', 'public', 'government']),
    );
    fireEvent.change(planSelect, { target: { value: 'government' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'Government' });
    fireEvent.change(planSelect, { target: { value: 'all' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'BAR' });
    expect(planSelect.value).toBe('all');
    fireEvent.change(planSelect, { target: { value: 'government' } });
    fireEvent.change(planSelect, { target: { value: 'public' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'BAR' });
  });

  it('a government party keeps Government when All rates is picked', () => {
    const onPatchStaffHeader = vi.fn();
    const session = headerSession({});
    const governmentSession = reduceQuoteSession(session, {
      type: 'analysis_ready',
      analysis: {
        ...session.analysis!,
        luna: {
          workflow: 'quote' as const,
          flags: [],
          groups: [],
          party: { kind: 'government' as const, name: 'Department X', reference: null },
          rateClaims: [],
          missing: [],
          evidence: [],
          tasks: [],
        },
      },
    });
    expect(governmentSession.staffHeader.salesStrategy).toBe('Government');
    render(<RatePlanGate initial={governmentSession} onPatch={onPatchStaffHeader} />);
    const planSelect = screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement;
    expect(planSelect.value).toBe('government');
    fireEvent.change(planSelect, { target: { value: 'all' } });
    expect(onPatchStaffHeader).not.toHaveBeenCalledWith(expect.objectContaining({ salesStrategy: 'BAR' }));
    fireEvent.change(planSelect, { target: { value: 'public' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'BAR' });
    fireEvent.change(planSelect, { target: { value: 'all' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'Government' });
  });

  it('All rates returns to Government for a Dinner B&B ask without a government party', () => {
    const onPatch = vi.fn();
    const base = headerSession({ salesStrategy: 'Government' });
    const analysis = {
      ...base.analysis!,
      groups: base.groups.map((group) => ({ ...group, board: 'dinner_bb' as const })),
      luna: {
        workflow: 'quote' as const,
        flags: [],
        groups: [],
        party: { kind: null, name: null, reference: null },
        rateClaims: [],
        missing: [],
        evidence: [],
        tasks: [],
      },
    };
    const dinnerSession = reduceQuoteSession(base, { type: 'analysis_ready', analysis });

    render(<RatePlanGate initial={dinnerSession} onPatch={onPatch} />);
    const planSelect = screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement;
    expect(planSelect.value).toBe('government');
    fireEvent.change(planSelect, { target: { value: 'public' } });
    expect(onPatch).toHaveBeenLastCalledWith({ salesStrategy: 'BAR' });
    fireEvent.change(planSelect, { target: { value: 'all' } });
    expect(onPatch).toHaveBeenLastCalledWith({ salesStrategy: 'Government' });
  });

  // Search, pick, chip and Clear for each field are covered in party-contract-picks.test.tsx.
  it('runs one HMS lookup per party and gives each party one retry control', async () => {
    resetPartyAutoLookupForTests();
    const find = vi.fn(noMatch);
    const { unmount } = render(
      <QuoteWorkflowPanel session={headerSession({ company: 'Acme Travel', agency: 'Travel Hub' })} findParty={find} />,
    );
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(screen.getAllByRole('region', { name: 'People' })).toHaveLength(1);
    expect(
      screen.getByLabelText('Search agency in HMS').compareDocumentPosition(screen.getByLabelText('Search company in HMS')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole('group', { name: /lookup in HMS$/i })).toHaveLength(2);
    expect(await screen.findAllByRole('button', { name: 'Find in HMS' })).toHaveLength(2);
    expect(find).toHaveBeenCalledWith('Acme Travel', 'company');
    expect(find).toHaveBeenCalledWith('Travel Hub', 'agency');
    unmount();
    render(<QuoteWorkflowPanel session={headerSession({ company: 'Acme Travel' })} />);
    expect(screen.queryByText(/Searching HMS/)).toBeNull();
  });

  it('prefills Company/agency from the email once, without restoring a cleared field', async () => {
    const initial = headerSession({ company: '', agency: '' });
    const namedInEmail = {
      name: 'Asha Patel',
      email: 'asha@example.test',
      phone: '+27 11 555 0123',
      company: 'Optimum Shared Services',
      endClient: 'Optimum Insure Consulting',
    };
    const seen: { latest: QuoteSession | null } = { latest: null };
    function EmailPrefilledPanel() {
      const [session, setSession] = useState(initial);
      seen.latest = session;
      return (
        <QuoteWorkflowPanel
          session={session}
          contact={namedInEmail}
          onPatchStaffHeader={(header) =>
            setSession((current) => reduceQuoteSession(current, { type: 'patch_staff_header', header }))
          }
        />
      );
    }

    render(<EmailPrefilledPanel />);
    await waitFor(() => {
      expect((screen.getByLabelText('Agency') as HTMLInputElement).value).toBe('Optimum Shared Services');
      expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('Optimum Insure Consulting');
    });

    fireEvent.change(screen.getByLabelText('Agency'), { target: { value: '' } });
    await waitFor(() => expect(seen.latest?.staffHeader.agency).toBe(''));
    expect((screen.getByLabelText('Agency') as HTMLInputElement).value).toBe('');
  });

  it('uses named email company and agency values over an unedited Luna party prefill', async () => {
    const base = headerSession({ company: 'Optimum Shared Services', agency: '' });
    const initial: QuoteSession = {
      ...base,
      analysis: {
        ...base.analysis!,
        luna: {
          workflow: 'quote',
          flags: [],
          groups: [],
          party: { kind: 'organization', name: 'Optimum Shared Services', reference: null },
          rateClaims: [],
          missing: [],
          evidence: [],
          tasks: [],
        },
      },
    };
    const namedInEmail = {
      name: 'Asha Patel',
      email: 'asha@example.test',
      phone: '+27 11 555 0123',
      company: 'Optimum Shared Services',
      endClient: 'Optimum Insure Consulting',
    };
    function EmailPrefilledPanel() {
      const [session, setSession] = useState(initial);
      return (
        <QuoteWorkflowPanel
          session={session}
          contact={namedInEmail}
          onPatchStaffHeader={(header) =>
            setSession((current) => reduceQuoteSession(current, { type: 'patch_staff_header', header }))
          }
        />
      );
    }

    render(<EmailPrefilledPanel />);
    await waitFor(() => {
      expect((screen.getByLabelText('Agency') as HTMLInputElement).value).toBe('Optimum Shared Services');
      expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('Optimum Insure Consulting');
    });
  });

  it('confirms a preset through the existing staff-edit path and collapses it', () => {
    const onPatchStaffHeader = vi.fn();
    render(
      <QuoteWorkflowPanel
        session={headerSession({ company: 'Acme Travel', parties: { company: ACME } })}
        findParty={noMatch}
        onPatchStaffHeader={onPatchStaffHeader}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Company' }));
    expect(onPatchStaffHeader).toHaveBeenCalledWith(
      expect.objectContaining({ company: 'Acme Travel', parties: { company: ACME } }),
      { staffEdit: true },
    );
    expect(screen.getByRole('button', { name: 'Edit Company' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Company from HMS' })).toBeNull();
  });

  it('drops a pick only when its own field is edited away from its name', () => {
    const seen: { latest: QuoteSession | null } = { latest: null };
    const editName = (kind: 'company' | 'agency', value: string) => {
      const label = kind === 'company' ? 'Company' : 'Agency';
      const picker = screen.getByRole('group', { name: `${label} lookup in HMS` });
      const select = within(picker).queryByRole('combobox');
      if (select) fireEvent.change(select, { target: { value: '__search_hms__' } });
      fireEvent.change(within(picker).getByRole('textbox', { name: `Search ${kind} in HMS` }), {
        target: { value },
      });
    };
    const { unmount } = render(
      <PartyGate
        initial={headerSession({ company: 'Acme Travel', parties: { company: ACME } })}
        seen={seen}
        findParty={noMatch}
      />,
    );
    editName('agency', 'Hub');
    expect(seen.latest?.staffHeader.parties?.company).toEqual(ACME);
    editName('company', 'Acme Travel Ltd');
    expect(seen.latest?.staffHeader.parties?.company).toBeUndefined();
    unmount();

    render(
      <PartyGate
        initial={headerSession({
          company: 'Acme Travel',
          agency: 'Travel Hub',
          parties: { company: ACME, agency: TRAVEL_HUB },
        })}
        seen={seen}
        findParty={noMatch}
      />,
    );
    editName('company', 'Acme Travel Ltd');
    expect(seen.latest?.staffHeader.parties?.company).toBeUndefined();
    expect(seen.latest?.staffHeader.parties?.agency).toEqual(TRAVEL_HUB);
    editName('agency', 'Travel Hub Ltd');
    expect(seen.latest?.staffHeader.parties?.agency).toBeUndefined();
  });

  it('holds Search availability with the lookup copy while an automatic company search still decides the pick', () => {
    const session = { ...headerSession({ company: 'Acme Travel' }), pendingPartyKinds: ['company' as const] };
    render(<QuoteWorkflowPanel session={session} />);
    expect((screen.getByRole('button', { name: 'Search availability' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Finding the company in HMS…').length).toBeGreaterThan(0);
  });

  it('says Nava, not Luna, when the automatic HMS lookup cannot reach HMS', async () => {
    resetPartyAutoLookupForTests();
    const unavailable = async () => ({ outcome: 'external_system_unavailable' as const, results: [], truncated: false });
    const { container } = render(
      <QuoteWorkflowPanel session={headerSession({ company: 'Acme Travel' })} findParty={unavailable} />,
    );
    expect(
      await screen.findByText(
        "Nava couldn't check HMS for this name. Try again, or quote at public rates.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeDefined();
    expect(container.textContent).not.toMatch(/Luna/);
  });
});

describe('an unread document is a needs-review row, never a stop', () => {
  it('shows the Nava copy without the blocking line', () => {
    const base = sessionFromFixture('agency-contract');
    const session: QuoteSession = {
      ...base,
      offers: [],
      phase: 'requirements',
      reviewItems: [
        {
          id: 'unread:doc',
          kind: 'document_failure',
          rank: 'unread_source',
          text: "Nava can't read rooming.docx yet — open it if it has booking details.",
          sourceLabel: 'rooming.docx',
          sourceRef: 'doc',
          sourceKind: 'attachment',
          filename: 'rooming.docx',
          reason: 'not a PDF',
          blocking: false,
        },
      ],
    };
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText("Nava can't read rooming.docx yet — open it if it has booking details.")).toBeDefined();
    expect(screen.getByText('Needs review. Nava did not read this file.')).toBeDefined();
    expect(screen.queryByText(/Blocks the quote/)).toBeNull();
  });
});

describe('quote strategy comparison', () => {
  it('renders every configured strategy BAR first, keeps no-room results visible, and waits for a staff pick', () => {
    const base = sessionFromFixture('public-single');
    const group = base.groups[0]!;
    const stayKey = stayKeyForGroup(group);
    const strategies: QuoteSalesStrategy[] = [
      { code: 'PROMO', label: 'Promotions', requestValue: 'PROMO' },
      { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
      { code: 'PRESET', label: 'Preset', requestValue: 'PRESET' },
      { code: 'WS', label: 'Wholesale', requestValue: 'WS' },
      { code: 'NC', label: 'Negoticated Contracted', requestValue: 'NC' },
      { code: 'GOV', label: 'Government', requestValue: 'Government' },
    ];
    const session: QuoteSession = {
      ...base,
      offers: [],
      selectedOfferIds: [],
      staffQuote: null,
      staffQuotes: {},
    };
    const strategyRows: Record<string, Partial<Record<QuoteSalesStrategy['code'], QuoteStrategyRow>>> = {
      [stayKey]: {
        WS: {
          status: 'ready',
          roomLabels: ['Standard King'],
          boardLabels: ['Bed & Breakfast'],
          nightlyMinor: [80000],
          totalMinor: 160000,
        },
        GOV: { status: 'not_offered', message: 'No rooms for these dates.' },
      },
    };
    const paneConfig: QuotePaneConfig = {
      transportId: 't1',
      propertyCode: HRDAV_PROPERTY_CODE,
      roomTypes: [],
      ratePlans: [],
      boards: ['bb'],
      salesStrategies: strategies,
      overrideRateCodes: [],
      eventRateCodes: [],
    };
    const onSelectQuoteStrategy = vi.fn();

    const rendered = render(
      <QuoteWorkflowPanel
        session={session}
        paneConfig={paneConfig}
        quoteStrategyRows={strategyRows}
        onSelectQuoteStrategy={onSelectQuoteStrategy}
      />,
    );

    const table = screen.getByRole('table', { name: /quote strategy comparison/i });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(7);
    expect(rows[1]?.textContent).toContain('BAR');
    expect(rows.map((row) => row.textContent).join(' ')).toContain('PROMO');
    expect(rows.map((row) => row.textContent).join(' ')).toContain('PRESET');
    expect(rows.map((row) => row.textContent).join(' ')).toContain('WS');
    expect(rows.map((row) => row.textContent).join(' ')).toContain('NC');
    expect(rows.map((row) => row.textContent).join(' ')).toContain('GOV');
    expect(within(table).getByText('Not offered for these dates')).toBeDefined();
    expect(within(table).getAllByText('Not checked')).toHaveLength(4);
    expect(within(table).getByText('Standard King')).toBeDefined();
    expect(within(table).getByText('R800,00')).toBeDefined();
    expect(within(table).getByText(/R1\s600,00/)).toBeDefined();
    expect(session.selectedOfferIds).toEqual([]);
    expect(session.staffQuote).toBeNull();
    expect(onSelectQuoteStrategy).not.toHaveBeenCalled();
    const chooseWholesale = screen.getByRole('button', { name: /use wholesale \(WS\) rates/i });
    expect(chooseWholesale.hasAttribute('disabled')).toBe(true);

    const wholesaleRow = strategyRows[stayKey]?.WS;
    const completedRows = Object.fromEntries(strategies.map((strategy) => [
      strategy.code,
      strategy.code === 'WS'
        ? wholesaleRow!
        : { status: 'not_offered' as const, message: 'No rooms for these dates.' },
    ]));
    rendered.rerender(
      <QuoteWorkflowPanel
        session={session}
        paneConfig={paneConfig}
        quoteStrategyRows={{ [stayKey]: completedRows }}
        onSelectQuoteStrategy={onSelectQuoteStrategy}
      />,
    );
    const completedChoice = screen.getByRole('button', { name: /use wholesale \(WS\) rates/i });
    expect(completedChoice.hasAttribute('disabled')).toBe(false);
    fireEvent.click(completedChoice);
    expect(onSelectQuoteStrategy).toHaveBeenCalledWith(stayKey, 'WS');
  });
});
