/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingCards, SavedStayReceipt, stayIdForRoom, type SavedStayCommit } from '../components/quote-workflow/booking-card';
import { PANE_SAVE_UNCONFIRMED_REASON, type PaneStayClient, type PaneStayResult } from '../lib/quote-workflow/pane-stay-bind';
import type { BookingDraftReady, StayGroupRequirement } from '../lib/quote-workflow/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
afterEach(cleanup);

const group: StayGroupRequirement = {
  id: 'g1', stayId: 's_aaaa1111', arrivalDate: '2027-01-15', departureDate: '2027-01-17',
  quantity: 1, adults: 1, childrenAges: [], board: 'bb', specialRequests: [],
  fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' },
};
const stayId = stayIdForRoom({ groupId: 'g1', roomIndex: 1 }, [group]);
function draft(): BookingDraftReady {
  return {
    draft: {
      rooms: [{ groupId: 'g1', roomIndex: 1, request: {
        arrival: '2027-01-15', departure: '2027-01-17', adults: 1, childAges: [], roomType: 'STQN',
        ratePlan: 'TAXYZ', bookerEmail: 'booker@example.invalid', firstName: 'Synthetic', lastName: 'Traveller',
        track: 'COR', sourceOfBusiness: 'E-Mail', guaranteeType: 'Confirmation Received',
      }, schemaErrors: [] }],
      rateCheck: [], missing: [], flags: [],
    },
    options: { track: ['COR'], sourceOfBusiness: ['E-Mail'], guaranteeType: ['Confirmation Received'], roomType: ['STQN'] },
    messageId: 'synthetic-mail', selectionEpoch: 1, inputRevision: 1, revisionRef: 'synthetic-revision',
  };
}
let workItemSequence = 0;
function renderCase(commit: PaneStayClient['commit'], savedStays?: Record<string, SavedStayCommit>, withWorkItem = true) {
  const workItemId = `00000000-0000-4000-8000-${String(++workItemSequence).padStart(12, '0')}`;
  const preview = vi.fn<PaneStayClient['preview']>().mockResolvedValue({
    status: 'ok', outcome: 'previewed', previewDigest: 'c'.repeat(64), screenshots: [],
  });
  const paneSave: PaneStayClient = { preview, commit, screenshot: vi.fn(async () => null), mode: () => 'on' };
  const bookingDraft = draft();
  const card = (stored?: Record<string, SavedStayCommit>) => <BookingCards draft={bookingDraft} groups={[group]}
    paneSave={paneSave} workItemId={withWorkItem ? workItemId : undefined} savedStays={stored} propertyCode="HRCEN"
    confirmation={{ userEmail: 'staff@example.invalid', setting: { mode: 'self' } }} />;
  const view = render(card(savedStays));
  return { ...view, preview, rerenderWithSaved: (stored: Record<string, SavedStayCommit>) => view.rerender(card(stored)) };
}
async function previewOne() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview in HMS' }));
  const button = screen.getByRole('button', { name: 'Create provisional booking' });
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  return button;
}

describe('single-room save recovery', () => {
  it('disables preview and booking until the request identity is available', () => {
    const commit = vi.fn<PaneStayClient['commit']>();
    const { preview } = renderCase(commit, undefined, false);
    expect(screen.getByText('Nava could not connect this booking to the request. Reopen the request to continue.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Preview in HMS' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Book this stay' })).toHaveProperty('disabled', true);
    expect(preview).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(['unconfirmed result', 'interrupted request'] as const)('never retries after an %s', async (failure) => {
    const commit = vi.fn<PaneStayClient['commit']>();
    if (failure === 'unconfirmed result') commit.mockResolvedValueOnce({ status: 'refused', reason: PANE_SAVE_UNCONFIRMED_REASON });
    else commit.mockRejectedValueOnce(new Error('Synthetic interruption'));
    renderCase(commit);
    fireEvent.click(await previewOne());
    await screen.findByText('Unconfirmed');
    expect(screen.queryByRole('button', { name: 'Preview in HMS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create provisional booking' })).toBeNull();
    expect(screen.queryByText(/^Booked in HMS/)).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('shows an unverified number without a booked label or another create', async () => {
    const commit = vi.fn<PaneStayClient['commit']>().mockResolvedValueOnce({
      status: 'ok', outcome: 'committed_unverified', confirmationNumber: '11111111-1', screenshots: [],
    });
    renderCase(commit);
    fireEvent.click(await previewOne());
    expect(await screen.findByText('Possible confirmation: 11111111-1 (not verified)')).toBeDefined();
    expect(screen.queryByText(/^Booked in HMS/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create provisional booking' })).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('holds an unknown receipt even when it belongs to a different draft', () => {
    const commit = vi.fn<PaneStayClient['commit']>();
    renderCase(commit, { s_other_1: { confirmationNumber: null, status: 'unknown', screenshotRef: null } });
    expect(screen.getByText('Unconfirmed')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Preview in HMS' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Create provisional booking' })).toHaveProperty('disabled', true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps a restored CMS mismatch and number without a booked label', () => {
    const saved: SavedStayCommit = { confirmationNumber: '11111111-1', status: 'unknown', screenshotRef: null,
      cmsReason: 'saved_cms_mismatch' };
    const view = renderCase(vi.fn<PaneStayClient['commit']>(), { s_aaaa1111_1: saved });
    expect(screen.getByText('HMS confirmation settings did not match. Booking is unverified.')).toBeDefined();
    expect(screen.getByText('Possible confirmation: 11111111-1 (not verified)')).toBeDefined();
    expect(screen.queryByText(/^Booked in HMS/)).toBeNull();
    view.unmount();
    render(<SavedStayReceipt saved={saved} />);
    expect(screen.getByText('Possible confirmation: 11111111-1 (not verified)')).toBeDefined();
  });

  it('does not label a fallback pre-save picture as saved evidence', async () => {
    const saved: SavedStayCommit = { confirmationNumber: '11111111-1', status: 'booked',
      screenshotRef: { runId: 'synthetic-run', name: 'filled.png' } };
    render(<SavedStayReceipt saved={saved} screenshot={vi.fn(async () => 'data:image/png;base64,AA==')} />);
    expect(await screen.findByRole('button', { name: 'View HMS screenshot' })).toBeDefined();
    expect(screen.queryByText('See what Nava saved in HMS')).toBeNull();
  });

  it('preserves a verified receipt and a conflicting in-flight unverified number', async () => {
    let finish!: (value: PaneStayResult) => void;
    const commit = vi.fn<PaneStayClient['commit']>().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderCase(commit);
    fireEvent.click(await previewOne());
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    view.rerenderWithSaved({ [stayId]: { confirmationNumber: '11111111-1', status: 'booked', screenshotRef: null } });
    await act(async () => finish({ status: 'ok', outcome: 'committed_unverified', confirmationNumber: '22222222-1' }));
    expect(screen.getByText('Booked in HMS – confirmation 11111111-1')).toBeDefined();
    expect(screen.getByText('Possible confirmation: 22222222-1 (not verified)')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Create provisional booking' })).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('releases only a loaded null-number claim after a definite pre-save refusal', async () => {
    let finish!: (value: PaneStayResult) => void;
    const commit = vi.fn<PaneStayClient['commit']>().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderCase(commit);
    fireEvent.click(await previewOne());
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    view.rerenderWithSaved({ [stayId]: { confirmationNumber: null, status: 'unknown', screenshotRef: null } });
    await act(async () => finish({ status: 'refused', reason: 'pane_save_preflight_unavailable', clickedSave: false }));
    expect(screen.getByRole('button', { name: 'Preview in HMS' })).toHaveProperty('disabled', false);
    view.rerenderWithSaved({ [stayId]: { confirmationNumber: null, status: 'unknown', screenshotRef: null } });
    expect(screen.getByRole('button', { name: 'Preview in HMS' })).toHaveProperty('disabled', true);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { result: { status: 'refused', reason: PANE_SAVE_UNCONFIRMED_REASON, clickedSave: false } as PaneStayResult, number: null },
    { result: { status: 'refused', reason: 'pane_save_preflight_unavailable', clickedSave: false } as PaneStayResult, number: '11111111-1' },
  ])('does not release an unconfirmed refusal or a possible number', async ({ result, number }) => {
    let finish!: (value: PaneStayResult) => void;
    const commit = vi.fn<PaneStayClient['commit']>().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderCase(commit);
    fireEvent.click(await previewOne());
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    view.rerenderWithSaved({ [stayId]: { confirmationNumber: number, status: 'unknown', screenshotRef: null } });
    await act(async () => finish(result));
    const batch = screen.queryByRole('button', { name: 'Book this stay' });
    if (batch) expect(batch).toHaveProperty('disabled', true);
    if (number) expect(screen.getByText(`Possible confirmation: ${number} (not verified)`)).toBeDefined();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not start a second action while the first is in flight', async () => {
    let finish!: (value: PaneStayResult) => void;
    const commit = vi.fn<PaneStayClient['commit']>().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    renderCase(commit);
    const button = await previewOne();
    fireEvent.click(button);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(commit).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: 'refused', reason: PANE_SAVE_UNCONFIRMED_REASON }));
  });
});
