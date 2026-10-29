/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingCards, stayIdForRoom } from '../components/quote-workflow/booking-card';
import { ConfirmationSourcesProvider } from '../components/quote-workflow/confirmation-recipient';
import { QuoteBookingHost } from '../components/quote-workflow/quote-booking-host';
import type { PaneStayClient } from '../lib/quote-workflow/pane-stay-bind';
import { initialQuoteSession } from '../lib/quote-workflow/session';
import type { BookingDraftReady, StayGroupRequirement } from '../lib/quote-workflow/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
afterEach(cleanup);

const group: StayGroupRequirement = {
  id: 'g1', stayId: 's_aaaa1111', arrivalDate: '2027-01-15', departureDate: '2027-01-17',
  quantity: 1, adults: 1, childrenAges: [], board: 'bb', specialRequests: [], fields: {},
};
const request = {
  firstName: 'Synthetic', lastName: 'Traveller', arrival: '2027-01-15', departure: '2027-01-17',
  adults: 1, childAges: [], roomType: 'STQN', ratePlan: 'BAR', track: 'COR',
  sourceOfBusiness: 'E-Mail', guaranteeType: 'Confirmation Received',
};
function draft(groups = ['g1']): BookingDraftReady {
  return {
    draft: { rooms: groups.map((groupId) => ({ groupId, roomIndex: 1, request: { ...request }, schemaErrors: [] })),
      rateCheck: [], missing: [], flags: [] },
    options: { track: ['COR'], sourceOfBusiness: ['E-Mail'], guaranteeType: ['Confirmation Received'], roomType: ['STQN'] },
    messageId: 'mail', selectionEpoch: 1, inputRevision: 1, revisionRef: 'revision',
  };
}
const workItemId = '00000000-0000-4000-8000-000000000001';
const confirmation = { userEmail: 'staff@example.invalid', setting: { mode: 'self' as const } };
function client() {
  const preview = vi.fn<PaneStayClient['preview']>().mockResolvedValue({
    status: 'ok', outcome: 'previewed', previewDigest: 'c'.repeat(64),
  });
  const commit = vi.fn<PaneStayClient['commit']>().mockResolvedValue({
    status: 'ok', outcome: 'committed', confirmationNumber: '11111111-1',
  });
  return { preview, commit, pane: { preview, commit, screenshot: vi.fn(async () => null), mode: () => 'on' as const } };
}

describe('booking case safety', () => {
  it('encodes different row identities without colliding with legacy keys and retains the stay prefix', () => {
    const second = { ...group, id: 'g2' };
    const one = stayIdForRoom({ groupId: 'g1', roomIndex: 1 }, [group, second]);
    const two = stayIdForRoom({ groupId: 'g2', roomIndex: 1 }, [group, second]);
    const next = stayIdForRoom({ groupId: 'g1', roomIndex: 2 }, [group, second]);
    expect(new Set([one, two, next]).size).toBe(3);
    for (const id of [one, two, next]) {
      expect(id).toMatch(/^s_aaaa1111_0\d+$/);
      expect(id.length).toBeLessThanOrEqual(40);
      expect(id.replace(/_\d+$/, '')).toBe('s_aaaa1111');
    }
    expect(one).toBe(stayIdForRoom({ groupId: 'g1', roomIndex: 1 }, [second, group]));
    expect(one).toBe(stayIdForRoom({ groupId: '2027-01-15:2027-01-17', roomIndex: 1 }, [group]));
    expect(one).not.toBe('s_aaaa1111_1');
    const synthetic = { ...group, id: 's_aaaa1111_row' };
    const syntheticId = stayIdForRoom({ groupId: synthetic.id, roomIndex: 1 }, [synthetic]);
    expect(syntheticId).toMatch(/^s_aaaa1111_0\d+$/);
    expect(syntheticId.length).toBeLessThanOrEqual(40);
    expect(syntheticId).not.toBe(stayIdForRoom({ groupId: group.stayId!, roomIndex: 1 }, [{ ...group, id: group.stayId! }]));
    expect(stayIdForRoom({ groupId: 'g'.repeat(60), roomIndex: 1 }, [{ ...group, id: 'g'.repeat(60) }])).toBe('');
    expect(stayIdForRoom({ groupId: 'g1', roomIndex: 1 }, [group, group])).toBe('');
    expect(stayIdForRoom({ groupId: '2027-01-15:2027-01-17', roomIndex: 1 }, [group, second])).toBe('');
    expect(stayIdForRoom({ groupId: 'removed', roomIndex: 1 }, [group])).toBe('');
  });

  it('holds a draft whose room is no longer in the current groups', () => {
    const { pane, preview, commit } = client();
    render(<BookingCards draft={draft(['removed'])} groups={[group]} paneSave={pane}
      workItemId={workItemId} confirmation={confirmation} />);
    expect(screen.getAllByText('Nava could not identify this room. Book it in HMS.').length).toBeGreaterThan(0);
    const previewButton = screen.getByRole('button', { name: 'Preview in HMS' });
    const createButton = screen.getByRole('button', { name: 'Create provisional booking' });
    expect(previewButton).toHaveProperty('disabled', true);
    expect(createButton).toHaveProperty('disabled', true);
    fireEvent.click(previewButton);
    fireEvent.click(createButton);
    expect(preview).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('allows read-only previews but disables individual and batch creates for multiple rooms', async () => {
    const { pane, preview, commit } = client();
    const second = { ...group, id: 'g2' };
    render(<BookingCards draft={draft(['g1', 'g2'])} groups={[group, second]} paneSave={pane}
      workItemId={workItemId} confirmation={confirmation} />);
    expect(screen.getAllByText('Multiple rooms or stays need to be booked in HMS for now.').length).toBeGreaterThan(0);
    for (const button of screen.getAllByRole('button', { name: 'Preview in HMS' })) fireEvent.click(button);
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    const firstId = (preview.mock.calls[0]![0] as { stayId?: string }).stayId;
    const secondId = (preview.mock.calls[1]![0] as { stayId?: string }).stayId;
    expect(firstId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    for (const button of screen.getAllByRole('button', { name: 'Create provisional booking' })) {
      expect(button).toHaveProperty('disabled', true);
      fireEvent.click(button);
    }
    const batch = screen.getByRole('button', { name: 'Book this stay' });
    expect(batch).toHaveProperty('disabled', true);
    fireEvent.click(batch);
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not create the first room from a partial draft of a multi-room request', async () => {
    const { pane, preview, commit } = client();
    render(<BookingCards draft={draft()} groups={[{ ...group, quantity: 2 }]} paneSave={pane}
      workItemId={workItemId} confirmation={confirmation} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview in HMS' }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Create provisional booking' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Book this stay' })).toHaveProperty('disabled', true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps a legacy confirmation separate from any guest after reload', () => {
    const { pane, commit } = client();
    const savedStays = { s_aaaa1111_1: { status: 'booked' as const, confirmationNumber: '11111111-1', screenshotRef: null } };
    const changed = draft();
    changed.draft.rooms[0]!.request.firstName = 'Other';
    const view = (saved?: typeof savedStays) => <BookingCards draft={changed} groups={[group]} paneSave={pane} workItemId={workItemId}
      confirmation={confirmation} savedStays={saved} />;
    const { rerender } = render(view(savedStays));
    const receipt = screen.getByText('Booked in HMS – confirmation 11111111-1');
    expect(receipt.closest('article')).toBeNull();
    expect(within(screen.getByRole('article')).queryByText(/11111111-1/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create provisional booking' })).toHaveProperty('disabled', true);
    rerender(view());
    expect(screen.getByText('Booked in HMS – confirmation 11111111-1').closest('article')).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview in HMS' })).toHaveProperty('disabled', true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('retains an unverified number on reload without attaching it to the current guest', () => {
    const { pane, commit } = client();
    render(<BookingCards draft={draft()} groups={[group]} paneSave={pane} workItemId={workItemId}
      confirmation={confirmation} savedStays={{ s_aaaa1111_1: {
        status: 'unknown', confirmationNumber: '11111111-1', screenshotRef: null,
      } }} />);
    expect(screen.getByText('Possible confirmation: 11111111-1 (not verified)').closest('article')).toBeNull();
    expect(screen.queryByText(/Booked in HMS/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create provisional booking' })).toHaveProperty('disabled', true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps a single-room result detached if the displayed guest changes', async () => {
    const { pane, preview, commit } = client();
    const original = draft();
    const view = (current: BookingDraftReady) => <BookingCards draft={current} groups={[group]} paneSave={pane}
      workItemId={workItemId} confirmation={confirmation} />;
    const { rerender } = render(view(original));
    fireEvent.click(screen.getByRole('button', { name: 'Preview in HMS' }));
    const book = screen.getByRole('button', { name: 'Create provisional booking' });
    await waitFor(() => expect(book).toHaveProperty('disabled', false));
    fireEvent.click(book);
    const receipt = await screen.findByText('Booked in HMS – confirmation 11111111-1');
    expect(receipt.closest('article')).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ stayId: (preview.mock.calls[0]![0] as { stayId?: string }).stayId, workItemId });
    expect(commit.mock.calls[0]?.[0]).not.toHaveProperty('parentStayId');
    const changed = draft();
    changed.draft.rooms[0]!.request.firstName = 'Other';
    changed.inputRevision += 1;
    rerender(view(changed));
    expect(screen.getByText('Booked in HMS – confirmation 11111111-1').closest('article')).toBeNull();
    expect(within(screen.getByRole('article')).queryByText(/11111111-1/)).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('keeps one receipt outside all date cards through a refresh and scopes it to its work item', () => {
    const { pane } = client();
    const session = initialQuoteSession();
    const second = { ...group, id: 'g2', stayId: 's_bbbb2222', arrivalDate: '2027-02-15', departureDate: '2027-02-17' };
    session.groups = [group, second];
    session.bookingDrafts = { '2027-01-15:2027-01-17': draft(), '2027-02-15:2027-02-17': draft(['g2']) };
    const saved = { s_aaaa1111_1: { status: 'booked' as const, confirmationNumber: '11111111-1', screenshotRef: null } };
    const view = (id: string, savedStays?: typeof saved) =>
      <QuoteBookingHost session={session} paneSave={pane} workItemId={id} savedStays={savedStays} />;
    const { rerender } = render(view(workItemId, saved));
    const assertDetached = () => {
      const outcomes = screen.getByRole('region', { name: 'Booking outcomes' });
      expect(within(outcomes).getAllByText('Booked in HMS – confirmation 11111111-1')).toHaveLength(1);
      for (const card of screen.getAllByRole('region', { name: 'Booking details' })) {
        expect(within(card).queryByText(/11111111-1/)).toBeNull();
      }
    };
    assertDetached();
    rerender(view(workItemId));
    assertDetached();
    rerender(view('00000000-0000-4000-8000-000000000002'));
    expect(screen.queryByText(/11111111-1/)).toBeNull();
    rerender(view(workItemId));
    assertDetached();
  });

  it('preserves a verified receipt and shows a later conflicting unknown outcome', () => {
    const { pane } = client();
    const session = initialQuoteSession();
    session.groups = [group];
    session.bookingDrafts = { '2027-01-15:2027-01-17': draft() };
    const view = (status: 'booked' | 'unknown', number: string | null) => <QuoteBookingHost session={session} paneSave={pane}
      workItemId={workItemId} savedStays={{ s_aaaa1111_1: { status, confirmationNumber: number, screenshotRef: null } }} />;
    const { rerender } = render(view('booked', '11111111-1'));
    rerender(view('unknown', null));
    const outcomes = screen.getByRole('region', { name: 'Booking outcomes' });
    expect(within(outcomes).getByText('Booked in HMS – confirmation 11111111-1')).toBeDefined();
    expect(within(outcomes).getByText('Unconfirmed')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Preview in HMS' })).toHaveProperty('disabled', true);
  });

  it('clears only the exact in-flight unknown snapshot after a proven pre-save refusal', async () => {
    let finish!: (result: Awaited<ReturnType<PaneStayClient['commit']>>) => void;
    const { pane, preview, commit } = client();
    commit.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const session = initialQuoteSession();
    session.groups = [group];
    session.bookingDrafts = { '2027-01-15:2027-01-17': draft() };
    const view = (savedStays?: Record<string, { status: 'unknown'; confirmationNumber: null; screenshotRef: null }>) =>
      <ConfirmationSourcesProvider value={confirmation}>
        <QuoteBookingHost session={session} paneSave={pane} workItemId={workItemId} savedStays={savedStays} />
      </ConfirmationSourcesProvider>;
    const { rerender } = render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Preview in HMS' }));
    const book = screen.getByRole('button', { name: 'Create provisional booking' });
    await waitFor(() => expect(book).toHaveProperty('disabled', false));
    fireEvent.click(book);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const id = (preview.mock.calls[0]![0] as { stayId?: string }).stayId;
    if (!id) throw new Error('preview did not carry a stay id');
    rerender(view({ [id]: { status: 'unknown', confirmationNumber: null, screenshotRef: null } }));
    expect(screen.getByRole('region', { name: 'Booking outcomes' })).toBeDefined();
    await act(async () => finish({ status: 'refused', reason: 'pane_save_preflight_unavailable', clickedSave: false }));
    expect(screen.queryByRole('region', { name: 'Booking outcomes' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview in HMS' })).toHaveProperty('disabled', false);
    rerender(view({ [id]: { status: 'unknown', confirmationNumber: null, screenshotRef: null } }));
    expect(screen.getByRole('region', { name: 'Booking outcomes' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Preview in HMS' })).toHaveProperty('disabled', true);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed result outside any replacement guest or date after the original card unmounts', async () => {
    let finish!: (result: Awaited<ReturnType<PaneStayClient['commit']>>) => void;
    const { pane, commit } = client();
    commit.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const session = initialQuoteSession();
    session.groups = [group];
    session.bookingDrafts = { '2027-01-15:2027-01-17': draft() };
    const view = () => <ConfirmationSourcesProvider value={confirmation}>
      <QuoteBookingHost session={session} paneSave={pane} workItemId={workItemId} />
    </ConfirmationSourcesProvider>;
    const { rerender } = render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Preview in HMS' }));
    const book = screen.getByRole('button', { name: 'Create provisional booking' });
    await waitFor(() => expect(book).toHaveProperty('disabled', false));
    fireEvent.click(book);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    session.groups = [{ ...group, id: 'g2', arrivalDate: '2027-02-15', departureDate: '2027-02-17' }];
    session.bookingDrafts = { '2027-02-15:2027-02-17': draft(['g2']) };
    rerender(view());
    await act(async () => finish({ status: 'ok', outcome: 'committed', confirmationNumber: '11111111-1' }));
    const outcomes = screen.getByRole('region', { name: 'Booking outcomes' });
    expect(within(outcomes).getByText('Booked in HMS – confirmation 11111111-1')).toBeDefined();
    expect(within(screen.getByRole('region', { name: 'Booking details' })).queryByText(/11111111-1/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview in HMS' })).toHaveProperty('disabled', true);
  });
});
