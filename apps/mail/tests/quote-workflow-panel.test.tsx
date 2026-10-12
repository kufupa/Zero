/**
 * @vitest-environment happy-dom
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { resetPartyAutoLookupForTests } from '../components/quote-workflow/party-picker';
import { fixtureResultsReady, loadQuoteFixture } from '../lib/quote-workflow/fixtures';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteSession, RateOption, RatePlanCatalogueEntry } from '../lib/quote-workflow/types';
import { CENTURION_RATE_PLANS } from '../../server-pilot/src/hms/rate-catalogue';

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

function openAdvanced() {
  fireEvent.click(screen.getByText('Advanced'));
}

function EditableStayPanel({ initial }: { initial: QuoteSession }) {
  const [session, setSession] = useState(initial);
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
    expect(screen.getByText(/not a quote or booking/i)).toBeDefined();
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
    expect(screen.getAllByText(/Each date range is searched and booked independently/)).toHaveLength(2);
  });

  it('keeps duplicated room edits independent', () => {
    const initial = sessionFromFixture('mixed-same-dates');
    const originalCode = initial.groups[0]?.roomTypeCode ?? initial.groups[0]?.roomPreference;
    render(<EditableStayPanel initial={initial} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Duplicate room' })[0]!);
    const roomsBeforeEdit = screen.getAllByLabelText('Room type') as HTMLSelectElement[];
    expect(roomsBeforeEdit).toHaveLength(3);
    fireEvent.change(roomsBeforeEdit[0]!, { target: { value: 'LUXKNG' } });
    const roomsAfterEdit = screen.getAllByLabelText('Room type') as HTMLSelectElement[];
    expect(roomsAfterEdit[0]?.value).toBe('LUXKNG');
    expect(roomsAfterEdit[1]?.value).toBe('single');
    expect(roomsAfterEdit[2]?.value).toBe(originalCode);
  });

  it('has one Booked by block with agency and company, not a per-room organisation field', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('agency-contract')} />);
    expect(screen.getAllByRole('heading', { name: 'Booked by' })).toHaveLength(1);
    expect(screen.getByLabelText('Agency (travel agent)')).toBeTruthy();
    expect(screen.getByLabelText('Company (end client)')).toBeTruthy();
    expect(screen.queryByLabelText('Company or agency')).toBeNull();
  });

  it('keeps Book in HMS disabled with a Coming soon reason in the quote flow', () => {
    const session = { ...sessionFromFixture('mixed-same-dates'), reviewedReplyHtml: 'Reply draft' };
    render(<QuoteWorkflowPanel session={session} />);
    expect((screen.getByRole('button', { name: 'Book in HMS' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Coming soon')).toBeTruthy();
  });

  it('adds room types and explains why Search availability is disabled until all rows are matchable', () => {
    const onStayAction = vi.fn();
    const base = sessionFromFixture('failed-run');
    const session = {
      ...base,
      groups: base.groups.map((group) => ({ ...group, roomPreference: '', roomTypeCode: undefined })),
    };
    render(<QuoteWorkflowPanel session={session} onStayAction={onStayAction} />);
    fireEvent.click(screen.getByRole('button', { name: /Add room type/ }));
    expect(onStayAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'add_row', stayId: expect.any(String) }));
    const search = screen.getByRole('button', { name: 'Search availability' }) as HTMLButtonElement;
    expect(search.disabled).toBe(true);
    expect(screen.getByText('Choose a room type for each row.')).toBeTruthy();
  });

  it('labels missing fields and extracted provenance', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('missing-fields')} />);
    expect(screen.getAllByText('Missing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('from email').length).toBeGreaterThan(0);
  });

  it('retries the failed stay search directly and keeps the detailed HMS steps behind Details', () => {
    const onRunNext = vi.fn();
    const onRunStep = vi.fn();
    let session = sessionFromFixture('failed-run');
    // The fixture's free-text room is not a room type yet, and Get rates needs one.
    const groups = session.groups.map((group) => ({ ...group, roomPreference: 'SKNG' }));
    session = { ...session, groups, steps: [{
      id: 'quote-1',
      kind: 'quote_stay',
      title: 'Search availability for 12–14 Nov',
      inputs: { quoteRequestKey: '2026-11-12:2026-11-14', groupIds: ['g1'] },
      shareKey: '2026-11-12:2026-11-14',
      dependsOn: [],
      status: 'failed',
      retryGuidance: sessionFromFixture('failed-run').errorMessage ??
        'The read failed before a quote result was stored. Approve the same step again; do not assume inventory is held.',
    }], phase: 'tools' };
    render(<QuoteWorkflowPanel session={session} onRunNext={onRunNext} onRunStep={onRunStep} />);
    expect(screen.getByText(/do not assume inventory is held/i)).toBeDefined();
    expect(screen.getByText(/Dates 2026-11-12 → 2026-11-14/i)).toBeDefined();
    expect(screen.getByText('Details')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Search availability' }));
    expect(onRunNext).not.toHaveBeenCalled();
    expect(onRunStep).toHaveBeenCalledWith('quote-1');
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByRole('button', { name: /Run Search availability for 12–14 Nov/i })).toBeTruthy();
  });

  it('shows the two-minute checking state on the stay that is running', () => {
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
    expect(screen.getByRole('status').textContent).toContain('Checking HMS… about 2 min');
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

  it('does not show signature noise and does not let a secondary ask disable an authorised PDF', () => {
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
    render(<QuoteWorkflowPanel session={ready} />);
    expect(screen.getByRole('button', { name: /^Prepare PDF$/i })).toHaveProperty('disabled', false);
    expect(screen.getByText('Is an airport shuttle available?')).toBeDefined();
  });

  it('keeps a trailing decimal while typing a dinner allowance', () => {
    const onPatchStaffHeader = vi.fn();
    render(
      <QuoteWorkflowPanel
        session={sessionFromFixture('mixed-same-dates')}
        onPatchStaffHeader={onPatchStaffHeader}
      />,
    );
    openAdvanced();
    const input = screen.getByLabelText('Dinner allowance (R per person per night)') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '125.' } });
    expect(input.value).toBe('125.');
  });

  it('shows one labelled field group per extra, and sends each change as its own patch', () => {
    const onPatchStaffHeader = vi.fn();
    render(
      <QuoteWorkflowPanel
        session={sessionFromFixture('mixed-same-dates')}
        onPatchStaffHeader={onPatchStaffHeader}
      />,
    );
    openAdvanced();
    expect(screen.getByLabelText('Dinner allowance (R per person per night)')).toBeDefined();
    expect(screen.getByLabelText('Lunch allowance (R per person per night)')).toBeDefined();
    expect(screen.getByLabelText('Office transfer (R per person per day)')).toBeDefined();
    expect(screen.getByRole('group', { name: 'Other: label, amount, unit' })).toBeDefined();
    fireEvent.change(screen.getByLabelText('Other label'), { target: { value: 'Parking' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({
      other: expect.objectContaining({ label: 'Parking', unit: 'item' }),
    });
    fireEvent.change(screen.getByLabelText('Notes for the quote'), {
      target: { value: 'Breakfast only on day 2.' },
    });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ notes: 'Breakfast only on day 2.' });
  });

  it('asks for trips and a price once shuttle is requested, and says so while the price is missing', () => {
    const onPatchStaffHeader = vi.fn();
    const base = sessionFromFixture('mixed-same-dates');
    render(
      <QuoteWorkflowPanel
        session={{ ...base, staffHeader: { ...base.staffHeader, shuttleRequested: true } }}
        onPatchStaffHeader={onPatchStaffHeader}
      />,
    );
    openAdvanced();
    expect(screen.getByRole('group', { name: 'Shuttle: trips × R per trip' })).toBeDefined();
    expect(screen.getByText(/No price yet/)).toBeDefined();
    fireEvent.change(screen.getByLabelText('Shuttle trips'), { target: { value: '2' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ shuttleTrips: 2 });
  });

  it('asks for a label when an other amount has none, and stops asking once it has one', () => {
    const base = sessionFromFixture('mixed-same-dates');
    const withOther = (other: QuoteSession['staffHeader']['other']) => ({
      ...base,
      staffHeader: { ...base.staffHeader, other },
    });
    render(<QuoteWorkflowPanel session={withOther({ label: '', amountMinor: 30_000, unit: 'item' })} />);
    openAdvanced();
    expect(screen.getByText('Add a label for this amount')).toBeDefined();
    expect((screen.getByLabelText('Other label') as HTMLInputElement).required).toBe(true);
    cleanup();
    render(<QuoteWorkflowPanel session={withOther({ label: '', unit: 'item' })} />);
    expect(screen.queryByText('Add a label for this amount')).toBeNull();
    cleanup();
    render(<QuoteWorkflowPanel session={withOther({ label: 'Parking', amountMinor: 30_000, unit: 'item' })} />);
    expect(screen.queryByText('Add a label for this amount')).toBeNull();
    expect((screen.getByLabelText('Other label') as HTMLInputElement).required).toBe(false);
  });

  it('keeps unreadable amount text on screen with an inline message, and saves nothing', () => {
    const onPatchStaffHeader = vi.fn();
    render(
      <QuoteWorkflowPanel
        session={sessionFromFixture('mixed-same-dates')}
        onPatchStaffHeader={onPatchStaffHeader}
      />,
    );
    openAdvanced();
    const input = screen.getByLabelText('Dinner allowance (R per person per night)') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(input.value).toBe('abc');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter an amount in rand, like 450 or 1,250.50')).toBeDefined();
    expect(onPatchStaffHeader).not.toHaveBeenCalledWith({ dinnerAllowanceMinor: undefined });
  });

  it('reads R and thousands separators, and shows an inline message for an amount over R1,000,000', () => {
    const onPatchStaffHeader = vi.fn();
    render(
      <QuoteWorkflowPanel
        session={sessionFromFixture('mixed-same-dates')}
        onPatchStaffHeader={onPatchStaffHeader}
      />,
    );
    openAdvanced();
    const input = screen.getByLabelText('Dinner allowance (R per person per night)') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'R 1,250.50' } });
    fireEvent.blur(input);
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ dinnerAllowanceMinor: 125_050 });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '2,000,000' } });
    expect(screen.getByText('Amounts above R1,000,000 are not accepted')).toBeDefined();
    fireEvent.blur(input);
    expect(onPatchStaffHeader).not.toHaveBeenCalledWith({ dinnerAllowanceMinor: 200_000_000 });
    expect(onPatchStaffHeader).toHaveBeenCalledWith({ dinnerAllowanceMinor: 125_050 });
  });

  it('caps shuttle trips at 50 with an inline message, and saves a count within the cap', () => {
    const onPatchStaffHeader = vi.fn();
    const base = sessionFromFixture('mixed-same-dates');
    render(
      <QuoteWorkflowPanel
        session={{ ...base, staffHeader: { ...base.staffHeader, shuttleRequested: true } }}
        onPatchStaffHeader={onPatchStaffHeader}
      />,
    );
    openAdvanced();
    const trips = screen.getByLabelText('Shuttle trips') as HTMLInputElement;
    fireEvent.change(trips, { target: { value: '60' } });
    expect(screen.getByText('Up to 50 allowed')).toBeDefined();
    expect(onPatchStaffHeader).not.toHaveBeenCalledWith({ shuttleTrips: 60 });
    fireEvent.change(trips, { target: { value: '50' } });
    expect(screen.queryByText('Up to 50 allowed')).toBeNull();
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ shuttleTrips: 50 });
  });

  it('blocks every Run while an amount is unreadable, and drops the charge only when the field is cleared', () => {
    const seen: { latest: QuoteSession | null } = { latest: null };
    const base = staggeredDatesSession();
    const initial = { ...base, staffHeader: { ...base.staffHeader, dinnerAllowanceMinor: 45_000 } };
    render(<RunGate initial={initial} seen={seen} />);
    openAdvanced();
    const runButtons = () => screen.getAllByRole('button', { name: 'Search availability' }) as HTMLButtonElement[];
    expect(runButtons().every((button) => !button.disabled)).toBe(true);
    const dinner = screen.getByLabelText('Dinner allowance (R per person per night)') as HTMLInputElement;
    // R450 is saved; the typed text is unreadable. The quote must not run on the saved R450 silently.
    fireEvent.focus(dinner);
    fireEvent.change(dinner, { target: { value: '450,50x' } });
    expect(runButtons().every((button) => button.disabled)).toBe(true);
    expect((screen.getAllByRole('button', { name: 'Search availability' })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/Fix the amounts before running this search\. Dinner allowance:/).length).toBeGreaterThan(0);
    expect(seen.latest?.staffHeader.dinnerAllowanceMinor).toBe(45_000);
    // Clearing the field drops the charge and unblocks the Run.
    fireEvent.change(dinner, { target: { value: '' } });
    fireEvent.blur(dinner);
    expect(seen.latest?.staffHeader.dinnerAllowanceMinor).toBeUndefined();
    expect(seen.latest?.staffHeader.fieldErrors?.dinnerAllowance).toBeUndefined();
    expect(runButtons().every((button) => !button.disabled)).toBe(true);
    // An amount over the cap blocks the Run as well.
    fireEvent.change(dinner, { target: { value: '2,000,000' } });
    expect(screen.getByText('Amounts above R1,000,000 are not accepted')).toBeDefined();
    expect(runButtons().every((button) => button.disabled)).toBe(true);
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

  it('gives each date option its own Run button', () => {
    const onRunStep = vi.fn();
    const session = staggeredDatesSession();
    render(<QuoteWorkflowPanel session={session} onRunStep={onRunStep} onRunNext={vi.fn()} />);
    const runs = screen.getAllByRole('button', { name: 'Search availability' }) as HTMLButtonElement[];
    expect(runs).toHaveLength(2);
    expect(runs.every((button) => !button.disabled)).toBe(true);
    fireEvent.click(runs[1]!);
    expect(onRunStep).toHaveBeenCalledWith(session.steps[1]!.id);
  });

  it('lists each date range as its own stay and totals the quote across stays', () => {
    const onRunStep = vi.fn();
    const quoted = staggeredDatesWithOptionA();
    render(<QuoteWorkflowPanel session={quoted} onRunStep={onRunStep} onRunNext={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /Stay 1 of 2/ })).toBeDefined();
    expect(screen.getByRole('heading', { name: /Stay 2 of 2/ })).toBeDefined();
    expect(screen.getByRole('article', { name: 'Stay 1 details' }).textContent).toMatch(/Separate HMS booking/);
    expect(screen.getByRole('article', { name: 'Stay 2 details' }).textContent).toMatch(/Separate HMS booking/);
    expect(screen.getAllByText('1 of 2 stays rated').length).toBeGreaterThan(0);
    const firstSubtotal = screen.getAllByText('Stay subtotal')[0]!;
    const addRange = screen.getByRole('button', { name: '+ Add another date range' });
    const allStaysTotal = screen.getByRole('heading', { name: 'Quotation total (all stays)' });
    expect(firstSubtotal.compareDocumentPosition(addRange) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(addRange.compareDocumentPosition(allStaysTotal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const runB = screen.getAllByRole('button', { name: 'Search availability' })[1] as HTMLButtonElement;
    expect(runB.disabled).toBe(false);
    fireEvent.click(runB);
    expect(onRunStep).toHaveBeenCalledWith(quoted.steps[1]!.id);
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

/** Two date options (2 Nov and 10 Nov) with no results yet. */
/** The panel with its session held in state and changed by the real reducer, as the page does. */
function RunGate({ initial, seen }: { initial: QuoteSession; seen: { latest: QuoteSession | null } }) {
  const [session, setSession] = useState(initial);
  seen.latest = session;
  return (
    <QuoteWorkflowPanel
      session={session}
      onPatchStaffHeader={(header) =>
        setSession((current) => reduceQuoteSession(current, { type: 'patch_staff_header', header }))
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
    openAdvanced();
    const planSelect = screen.getByLabelText('Rate plan') as HTMLSelectElement;
    const values = [...planSelect.options].map((option) => option.value);
    expect(planSelect.value).toBe('all');
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
    openAdvanced();
    expect((screen.getByLabelText('Rate plan') as HTMLSelectElement).value).toBe('government');
    expect(screen.getByRole('option', { name: 'All government rates' })).toBeDefined();
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

    render(<FilterHarness />);
    openAdvanced();
    expect(screen.getByRole('button', { name: /BAR: Best Available Rate/ })).toBeDefined();
    fireEvent.change(screen.getByLabelText('Rate plan'), { target: { value: 'NCOR1B' } });

    expect((screen.getByLabelText('Rate plan') as HTMLSelectElement).value).toBe('NCOR1B');
    expect(screen.queryByRole('button', { name: /BAR: Best Available Rate/ })).toBeNull();
    expect(screen.getByRole('button', { name: /NCOR1B: Corporate Negotiated/ })).toBeDefined();
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
    openAdvanced();
    fireEvent.change(screen.getByLabelText('Rate plan'), { target: { value: 'NGOVB' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'Government' });
    first.unmount();

    const governmentSession = { ...base, staffHeader: { ...base.staffHeader, salesStrategy: 'Government' } } as never;
    render(
      <QuoteWorkflowPanel session={governmentSession} rateCatalogue={rateCatalogue} onPatchStaffHeader={onPatchStaffHeader} />,
    );
    openAdvanced();
    expect((screen.getByLabelText('Rate plan') as HTMLSelectElement).value).toBe('government');
    fireEvent.change(screen.getByLabelText('Rate plan'), { target: { value: 'BAR' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'BAR' });
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
    const planSelect = screen.getByLabelText('Rate plan') as HTMLSelectElement;
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
    const planSelect = screen.getByLabelText('Rate plan') as HTMLSelectElement;
    expect(planSelect.value).toBe('government');
    fireEvent.change(planSelect, { target: { value: 'all' } });
    expect(onPatchStaffHeader).not.toHaveBeenCalledWith(expect.objectContaining({ salesStrategy: 'BAR' }));
    fireEvent.change(planSelect, { target: { value: 'public' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'BAR' });
    fireEvent.change(planSelect, { target: { value: 'all' } });
    expect(onPatchStaffHeader).toHaveBeenLastCalledWith({ salesStrategy: 'Government' });
  });

  // Search, pick, chip and Clear for each field are covered in party-contract-picks.test.tsx.
  it('runs one HMS lookup per party and gives each party one retry control', async () => {
    resetPartyAutoLookupForTests();
    const find = vi.fn(noMatch);
    const { unmount } = render(
      <QuoteWorkflowPanel session={headerSession({ company: 'Acme Travel', agency: 'Travel Hub' })} findParty={find} />,
    );
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(screen.getAllByRole('heading', { name: 'Booked by' })).toHaveLength(1);
    expect(
      screen.getByLabelText('Agency (travel agent)').compareDocumentPosition(screen.getByLabelText('Company (end client)')) &
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

  it('drops a pick only when its own field is edited away from its name', () => {
    const seen: { latest: QuoteSession | null } = { latest: null };
    const { unmount } = render(
      <PartyGate
        initial={headerSession({ company: 'Acme Travel', parties: { company: ACME } })}
        seen={seen}
        findParty={noMatch}
      />,
    );
    fireEvent.change(screen.getByLabelText('Agency (travel agent)'), { target: { value: 'Hub' } });
    expect(seen.latest?.staffHeader.parties?.company).toEqual(ACME);
    fireEvent.change(screen.getByLabelText('Company (end client)'), { target: { value: 'Acme Travel Ltd' } });
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
    fireEvent.change(screen.getByLabelText('Company (end client)'), { target: { value: 'Acme Travel Ltd' } });
    expect(seen.latest?.staffHeader.parties?.company).toBeUndefined();
    expect(seen.latest?.staffHeader.parties?.agency).toEqual(TRAVEL_HUB);
    fireEvent.change(screen.getByLabelText('Agency (travel agent)'), { target: { value: 'Travel Hub Ltd' } });
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
