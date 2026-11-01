/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingCards } from '../components/quote-workflow/booking-card';
import { QuoteBookingHost } from '../components/quote-workflow/quote-booking-host';
import type { PaneStayClient } from '../lib/quote-workflow/pane-stay-bind';
import { initialQuoteSession } from '../lib/quote-workflow/session';
import type { BookingDraftReady, StayGroupRequirement } from '../lib/quote-workflow/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

afterEach(() => cleanup());

const RUN = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const SHOT_AT = '2026-10-27T04:00:00.000Z';

const group: StayGroupRequirement = {
  id: 'g1',
  stayId: 's_aaaa1111',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  quantity: 1,
  adults: 1,
  childrenAges: [],
  board: 'bb',
  specialRequests: [],
  fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' },
};

function bookedDraft(): BookingDraftReady {
  return {
    draft: {
      rooms: [
        {
          groupId: 'g1',
          roomIndex: 1,
          request: {
            arrival: '2026-11-12',
            departure: '2026-11-14',
            adults: 1,
            childAges: [],
            roomType: 'STQN',
            ratePlan: 'TAXYZ',
            bookerEmail: 'booker@example.invalid',
            firstName: 'John',
            lastName: 'Smith',
          },
          schemaErrors: [],
        },
      ],
      rateCheck: [],
      missing: [],
      flags: [],
    },
    options: {
      track: ['BAR'],
      sourceOfBusiness: ['E-Mail'],
      guaranteeType: ['Guaranteed By Agent'],
      roomType: ['STQN'],
    },
    messageId: 'mail-1',
    selectionEpoch: 1,
    inputRevision: 1,
    revisionRef: 'rev-1',
  };
}

describe('booking card reload', () => {
  it('shows the stored booking, confirmation, and before/saved screenshots', async () => {
    const screenshot = vi.fn<PaneStayClient['screenshot']>(async (_runId, name) => `data:image/png;base64,${name}`);
    const commit = vi.fn<PaneStayClient['commit']>();
    const client: PaneStayClient = {
      preview: vi.fn(),
      commit,
      screenshot,
      mode: () => 'on',
    };
    render(
      <BookingCards
        draft={bookedDraft()}
        groups={[group]}
        paneSave={client}
        workItemId="11111111-1111-1111-1111-111111111111"
        savedStays={{
          s_aaaa1111_1: {
            confirmationNumber: '98765-1',
            status: 'booked',
            screenshotRef: null,
            runId: RUN,
            shots: [
              { name: 'before.png', sha256: 'a'.repeat(64), at: SHOT_AT },
              { name: 'filled.png', sha256: 'b'.repeat(64), at: SHOT_AT },
              { name: 'saved.png', sha256: 'c'.repeat(64), at: SHOT_AT },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText('Booked')).toBeDefined();
    expect(screen.getByText('Booked in HMS – confirmation 98765-1')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(screenshot).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'View HMS screenshots' }));
    expect(await screen.findByRole('dialog', { name: 'HMS screenshots' })).toBeDefined();
    expect(screen.getByText('Before')).toBeDefined();
    expect(screen.getByText('Saved')).toBeDefined();
    expect(screen.queryByText('filled.png')).toBeNull();
    await waitFor(() => {
      expect(screenshot).toHaveBeenCalledWith(RUN, 'before.png');
      expect(screenshot).toHaveBeenCalledWith(RUN, 'saved.png');
    });
    expect(screenshot).not.toHaveBeenCalledWith(RUN, 'filled.png');
  });

  it('does not mark every row booked when two rows share one saved stay id', () => {
    const client: PaneStayClient = {
      preview: vi.fn(),
      commit: vi.fn(),
      screenshot: vi.fn(async () => null),
      mode: () => 'on',
    };
    const draft = bookedDraft();
    draft.draft.rooms.push({
      ...draft.draft.rooms[0]!,
      groupId: 'g2',
      roomIndex: 1,
    });
    const shared = { ...group, id: 'g1' };
    render(
      <BookingCards
        draft={draft}
        groups={[shared, { ...group, id: 'g2' }]}
        paneSave={client}
        savedStays={{
          s_aaaa1111_1: {
            confirmationNumber: '98765-1',
            status: 'booked',
            screenshotRef: null,
          },
        }}
      />,
    );
    expect(screen.queryByText('Booked in HMS – confirmation 98765-1')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Preview in HMS' })).toHaveLength(2);

    const session = initialQuoteSession();
    session.groups = [shared, { ...group, id: 'g2' }];
    session.bookingDrafts = { '2026-11-12:2026-11-14': draft };
    cleanup();
    render(
      <QuoteBookingHost session={session} paneSave={client} savedStays={{
        s_aaaa1111_1: {
          confirmationNumber: '98765-1',
          status: 'booked',
          screenshotRef: null,
        },
      }} />,
    );
    expect(screen.getAllByText('Booked in HMS – confirmation 98765-1')).toHaveLength(1);
  });

  it('shows the stored confirmation when the matching room has children', () => {
    const client: PaneStayClient = {
      preview: vi.fn(),
      commit: vi.fn(),
      screenshot: vi.fn(async () => null),
      mode: () => 'on',
    };
    const session = initialQuoteSession();
    const childGroup = { ...group, childrenAges: [7] };
    const draft = bookedDraft();
    draft.draft.rooms[0]!.request.childAges = [7];
    session.groups = [childGroup];
    session.bookingDrafts = { '2026-11-12:2026-11-14': draft };
    const savedStays = {
      s_aaaa1111_1: {
        confirmationNumber: '98765-1', status: 'booked' as const, screenshotRef: null,
        runId: RUN, shots: [{ name: 'saved.png', sha256: 'c'.repeat(64), at: SHOT_AT }],
      },
    };
    const direct = render(<BookingCards draft={draft} groups={[childGroup]} paneSave={client} savedStays={savedStays} />);
    expect(screen.getAllByText('Booked in HMS – confirmation 98765-1')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
    direct.unmount();
    render(
      <QuoteBookingHost
        session={session}
        paneSave={client}
        savedStays={{
          s_aaaa1111_1: {
            confirmationNumber: '98765-1',
            status: 'booked',
            screenshotRef: null,
            runId: RUN,
            shots: [{ name: 'saved.png', sha256: 'c'.repeat(64), at: SHOT_AT }],
          },
        }}
      />,
    );
    expect(screen.getAllByText('Booked in HMS – confirmation 98765-1')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'View HMS screenshots' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
  });

  it('never offers preview or retry after an unknown save without a confirmation number', () => {
    const preview = vi.fn<PaneStayClient['preview']>();
    const commit = vi.fn<PaneStayClient['commit']>();
    const client: PaneStayClient = { preview, commit, screenshot: vi.fn(async () => null), mode: () => 'on' };
    const savedStays = {
      s_aaaa1111_1: { confirmationNumber: null, status: 'unknown' as const, screenshotRef: null },
    };
    const draft = bookedDraft();
    const session = initialQuoteSession();
    session.groups = [group];
    session.bookingDrafts = { '2026-11-12:2026-11-14': draft };

    const assertNoRetry = () => {
      expect(screen.getAllByText(/unconfirmed/i).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Create provisional booking' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Book this stay' })).toBeNull();
      expect(preview).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    };
    const direct = render(<BookingCards draft={draft} groups={[group]} paneSave={client} savedStays={savedStays} />);
    assertNoRetry();
    direct.unmount();
    render(<QuoteBookingHost session={session} paneSave={client} savedStays={savedStays} />);
    assertNoRetry();
  });

  it('locks the matching room if its saved outcome arrives after the card mounts', () => {
    const client: PaneStayClient = {
      preview: vi.fn(), commit: vi.fn(), screenshot: vi.fn(async () => null), mode: () => 'on',
    };
    const draft = bookedDraft();
    const view = render(<BookingCards draft={draft} groups={[group]} paneSave={client} />);
    expect(screen.getByRole('button', { name: 'Preview in HMS' })).toBeDefined();
    view.rerender(<BookingCards draft={draft} groups={[group]} paneSave={client} savedStays={{
      s_aaaa1111_1: { confirmationNumber: '98765-1', status: 'unknown', screenshotRef: null,
        cmsReason: 'saved_cms_mismatch' },
    }} />);
    expect(screen.getByText('HMS confirmation settings did not match. Booking is unverified.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create provisional booking' })).toBeNull();
    view.rerender(<BookingCards draft={draft} groups={[group]} paneSave={client} />);
    expect(screen.getByText('HMS confirmation settings did not match. Booking is unverified.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
  });

  it('shows a stored CMS mismatch without offering another booking', () => {
    const client: PaneStayClient = {
      preview: vi.fn(), commit: vi.fn(), screenshot: vi.fn(async () => null), mode: () => 'on',
    };
    const savedStays = {
      s_aaaa1111_1: {
        confirmationNumber: '98765-1', status: 'unknown' as const, screenshotRef: null,
        cmsReason: 'saved_cms_mismatch',
      },
    };
    const draft = bookedDraft();
    const warning = 'HMS confirmation settings did not match. Booking is unverified.';
    const direct = render(<BookingCards draft={draft} groups={[group]} paneSave={client} savedStays={savedStays} />);
    expect(screen.getByText(warning)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create provisional booking' })).toBeNull();
    direct.unmount();
    // The same saved receipt must remain meaningful when no booking draft survives the reload.
    render(<QuoteBookingHost session={initialQuoteSession()} paneSave={client} savedStays={savedStays} />);
    expect(screen.getByText(warning)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create provisional booking' })).toBeNull();
    expect(client.commit).not.toHaveBeenCalled();
  });

  it('shows a stored booking when the mail has no booking draft', () => {
    const client: PaneStayClient = {
      preview: vi.fn(),
      commit: vi.fn(),
      screenshot: vi.fn(async () => null),
      mode: () => 'on',
    };
    render(
      <QuoteBookingHost
        session={initialQuoteSession()}
        paneSave={client}
        savedStays={{
          s_aaaa1111_1: {
            confirmationNumber: '98765-1',
            status: 'booked',
            screenshotRef: null,
            runId: RUN,
            shots: [{ name: 'saved.png', sha256: 'c'.repeat(64), at: SHOT_AT }],
          },
        }}
      />,
    );
    expect(screen.getByText('Booked')).toBeDefined();
    expect(screen.getByText('Booked in HMS – confirmation 98765-1')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'View HMS screenshots' })).toBeDefined();
  });
});
