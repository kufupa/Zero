/**
 * @vitest-environment happy-dom
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { fixtureResultsReady, loadQuoteFixture } from '../lib/quote-workflow/fixtures';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteSession } from '../lib/quote-workflow/types';

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
    expect(screen.getByText(/not a quote request/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Run next/i })).toBeNull();
  });

  it('renders one editable card per stay group with month and year dates', () => {
    const onPatchGroup = vi.fn();
    render(
      <QuoteWorkflowPanel session={sessionFromFixture('mixed-same-dates')} onPatchGroup={onPatchGroup} />,
    );
    const arrivals = screen.getAllByLabelText(/Arrival/i);
    expect(arrivals).toHaveLength(2);
    expect((arrivals[0] as HTMLInputElement).value).toBe('2026-10-16');
    fireEvent.change(screen.getAllByLabelText(/Adults/i)[0]!, { target: { value: '3' } });
    expect(onPatchGroup).toHaveBeenCalledWith('g-double', expect.objectContaining({ adults: 3 }));
  });

  it('labels missing fields and extracted provenance', () => {
    render(<QuoteWorkflowPanel session={sessionFromFixture('missing-fields')} />);
    expect(screen.getAllByText('Missing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Email').length).toBeGreaterThan(0);
  });

  it('runs next only when not already running, and shows retry guidance on failure', () => {
    const onRunNext = vi.fn();
    const onRunStep = vi.fn();
    let session = sessionFromFixture('failed-run');
    session = { ...session, steps: [{
      id: 'quote-1',
      kind: 'quote_stay',
      title: 'Search availability for 12–14 Nov',
      inputs: { quoteRequestKey: '2026-11-12:2026-11-14', groupIds: ['g1'] },
      dependsOn: [],
      status: 'failed',
      retryGuidance: sessionFromFixture('failed-run').errorMessage ??
        'The read failed before a quote result was stored. Approve the same step again; do not assume inventory is held.',
    }], phase: 'tools' };
    render(<QuoteWorkflowPanel session={session} onRunNext={onRunNext} onRunStep={onRunStep} />);
    expect(screen.getByText(/do not assume inventory is held/i)).toBeDefined();
    expect(screen.getByText(/Dates 2026-11-12 → 2026-11-14/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Run next/i }));
    expect(onRunNext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Run Search availability for 12–14 Nov/i }));
    expect(onRunStep).toHaveBeenCalledWith('quote-1');
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
    const stay = screen.getByRole('button', { name: /Run Search availability/i });
    expect((stay as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stay);
    expect(onRunStep).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Children ages'), { target: { value: ' , ' } });
    expect(onPatchGroup).toHaveBeenCalledWith('g1', { childrenAges: [] });
  });

  it('keeps two date-group allocations selected and blocks a partial PDF', () => {
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
    expect(screen.getByRole('button', { name: /Prepare quotation PDF/i })).toHaveProperty('disabled', true);
    session = { ...session, selectedOfferIds: ['st-a', 'st-b'] };
    cleanup();
    render(<QuoteWorkflowPanel session={session} onSelectOffer={onSelectOffer} />);
    expect(screen.getByRole('button', { name: /Prepare quotation PDF/i })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Each date search keeps its own quote and PDF/)).toBeDefined();
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
    expect(screen.getByRole('button', { name: /Prepare quotation PDF/i })).toHaveProperty('disabled', true);
    cleanup();
    render(
      <QuoteWorkflowPanel
        session={{ ...session, selectedOfferIds: ['mix-a', 'mix-b'] }}
        onSelectOffer={onSelectOffer}
      />,
    );
    expect(screen.getByRole('button', { name: /Prepare quotation PDF/i })).toHaveProperty('disabled', false);
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
    expect(screen.getByRole('button', { name: /Prepare quotation PDF/i })).toHaveProperty('disabled', false);
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
    const runButtons = () => screen.getAllByRole('button', { name: /^Run Search availability/i }) as HTMLButtonElement[];
    expect(runButtons().every((button) => !button.disabled)).toBe(true);
    const dinner = screen.getByLabelText('Dinner allowance (R per person per night)') as HTMLInputElement;
    // R450 is saved; the typed text is unreadable. The quote must not run on the saved R450 silently.
    fireEvent.focus(dinner);
    fireEvent.change(dinner, { target: { value: '450,50x' } });
    expect(runButtons().every((button) => button.disabled)).toBe(true);
    expect((screen.getByRole('button', { name: 'Run next' }) as HTMLButtonElement).disabled).toBe(true);
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

  it('puts Download Excel beside the PDF button and passes the click on', () => {
    const onDownloadWorkbook = vi.fn();
    const ready = {
      ...sessionFromFixture('public-single'),
      staffSource: { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) },
      evidence: { kind: 'authorised' as const, selectionEpoch: 1, inputRevision: 1 },
      selectedOfferIds: ['pub-1'],
      reviewedReplyHtml: '<p>Full staff-edited reply</p>',
    };
    render(<QuoteWorkflowPanel session={ready} onDownloadWorkbook={onDownloadWorkbook} />);
    const pdf = screen.getByRole('button', { name: /Prepare quotation PDF/i }) as HTMLButtonElement;
    const excel = screen.getByRole('button', { name: 'Download Excel' }) as HTMLButtonElement;
    expect(excel.parentElement).toBe(pdf.parentElement);
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
    const runs = screen.getAllByRole('button', { name: /^Run Search availability/i }) as HTMLButtonElement[];
    expect(runs).toHaveLength(2);
    expect(runs.every((button) => !button.disabled)).toBe(true);
    fireEvent.click(runs[1]!);
    expect(onRunStep).toHaveBeenCalledWith(session.steps[1]!.id);
  });

  it('lists date options with totals and says why a later option waits for the earlier PDF', () => {
    const onRunStep = vi.fn();
    const quoted = staggeredDatesWithOptionA();
    render(<QuoteWorkflowPanel session={quoted} onRunStep={onRunStep} onRunNext={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Date options' })).toBeDefined();
    expect(
      screen.getByText('This email asks for more than one set of dates. Run each option; Nava keeps every result.'),
    ).toBeDefined();
    const optionA = screen.getByRole('button', { name: 'Select date scope 2026-11-02 to 2026-11-04' });
    expect(optionA.textContent).toMatch(/Quoted R.*PDF not built/);
    expect(screen.getByText('Finish the PDF for option A first, then run option B.')).toBeDefined();
    const runB = screen.getByRole('button', { name: /^Run Search availability 2026-11-10/i }) as HTMLButtonElement;
    expect(runB.disabled).toBe(true);
    fireEvent.click(runB);
    expect(onRunStep).not.toHaveBeenCalled();
  });

  it('removes the wait once option A has its PDF', () => {
    const withPdf = {
      ...staggeredDatesWithOptionA(),
      stayPdfs: {
        '2026-11-02:2026-11-04': {
          fileName: 'Quote-rev-a.pdf',
          bytesBase64: 'JVBERi0xLjQK',
          pdfHash: 'cd'.repeat(32),
          revisionId: 'rev-a',
          totalMinor: 850000,
        },
      },
    };
    render(<QuoteWorkflowPanel session={withPdf} onRunStep={vi.fn()} onRunNext={vi.fn()} />);
    expect(screen.queryByText(/Finish the PDF for option A/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Select date scope 2026-11-02 to 2026-11-04' }).textContent).toMatch(
      /PDF ready/,
    );
    const runB = screen.getByRole('button', { name: /^Run Search availability 2026-11-10/i }) as HTMLButtonElement;
    expect(runB.disabled).toBe(false);
  });

  it('prepares the PDF for a quoted date option from its own row', () => {
    const onPreparePdfFor = vi.fn();
    render(
      <QuoteWorkflowPanel
        session={staggeredDatesWithOptionA()}
        onPreparePdfFor={onPreparePdfFor}
        onRunStep={vi.fn()}
        onRunNext={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Prepare PDF for option B' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare PDF for option A' }));
    expect(onPreparePdfFor).toHaveBeenCalledWith('2026-11-02:2026-11-04');
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
