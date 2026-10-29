/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingCards, stayIdForRoom } from '../components/quote-workflow/booking-card';
import type { PaneStayClient } from '../lib/quote-workflow/pane-stay-bind';
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
    expect(one).not.toBe('s_aaaa1111_1');
    expect(stayIdForRoom({ groupId: 'g'.repeat(60), roomIndex: 1 }, [{ ...group, id: 'g'.repeat(60) }])).toBe('');
    expect(stayIdForRoom({ groupId: 'g1', roomIndex: 1 }, [group, group])).toBe('');
  });

  it('allows read-only previews but disables individual and batch creates for multiple rooms', async () => {
    const { pane, preview, commit } = client();
    const second = { ...group, id: 'g2' };
    render(<BookingCards draft={draft(['g1', 'g2'])} groups={[group, second]} paneSave={pane}
      workItemId={workItemId} confirmation={confirmation} />);
    expect(screen.getByText('Multiple rooms need to be booked in HMS for now.')).toBeDefined();
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
});
