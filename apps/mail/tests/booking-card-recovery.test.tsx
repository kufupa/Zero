/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingCards, SavedStayReceipt, type SavedStayCommit } from '../components/quote-workflow/booking-card';
import {
  PANE_SAVE_UNCONFIRMED_REASON,
  type PaneStayClient,
  type PaneStayResult,
} from '../lib/quote-workflow/pane-stay-bind';
import type { BookingDraftReady, StayGroupRequirement } from '../lib/quote-workflow/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
afterEach(cleanup);

const group: StayGroupRequirement = {
  id: 'g1', stayId: 's_aaaa1111', arrivalDate: '2027-01-15', departureDate: '2027-01-17',
  quantity: 2, adults: 1, childrenAges: [], board: 'bb', specialRequests: [],
  fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' },
};

function draft(): BookingDraftReady {
  const room = {
    arrival: '2027-01-15', departure: '2027-01-17', adults: 1, childAges: [], roomType: 'STQN',
    ratePlan: 'TAXYZ', bookerEmail: 'booker@example.invalid', firstName: 'Synthetic', lastName: 'Traveller',
  };
  return {
    draft: {
      rooms: [1, 2].map((roomIndex) => ({ groupId: 'g1', roomIndex, request: { ...room }, schemaErrors: [] })),
      rateCheck: [], missing: [], flags: [],
    },
    options: { track: ['COR'], sourceOfBusiness: ['E-Mail'], guaranteeType: ['Confirmation Received'], roomType: ['STQN'] },
    messageId: 'synthetic-mail', selectionEpoch: 1, inputRevision: 1, revisionRef: 'synthetic-revision',
  };
}

const previewResult: PaneStayResult = {
  status: 'ok', outcome: 'previewed', previewDigest: 'c'.repeat(64), screenshots: [],
};
const firstVerified: PaneStayResult = {
  status: 'ok', outcome: 'committed', confirmationNumber: 'TEST-FIRST', screenshots: [],
};
const secondVerified: PaneStayResult = {
  status: 'ok', outcome: 'committed', confirmationNumber: 'TEST-SECOND', screenshots: [],
};
const unconfirmed: PaneStayResult = { status: 'refused', reason: PANE_SAVE_UNCONFIRMED_REASON };
let workItemSequence = 0;

function renderCase(commit: PaneStayClient['commit'], savedStays?: Record<string, SavedStayCommit>, withWorkItem = true) {
  // The preview cache is module-scoped; give each case its own work item.
  const workItemId = `00000000-0000-4000-8000-${String(++workItemSequence).padStart(12, '0')}`;
  const preview = vi.fn<PaneStayClient['preview']>().mockResolvedValue(previewResult);
  const client: PaneStayClient = { preview, commit, screenshot: vi.fn(async () => null), mode: () => 'on' };
  const bookingDraft = draft();
  const card = (stored?: Record<string, SavedStayCommit>) => (
    <BookingCards
      draft={bookingDraft} groups={[group]} paneSave={client} workItemId={withWorkItem ? workItemId : undefined} savedStays={stored}
      propertyCode="HRCEN"
      contact={{ name: 'Example Booker', company: null, endClient: null, email: 'booker@example.invalid', phone: null }}
      confirmation={{ userEmail: 'staff@example.invalid', setting: { mode: 'self' } }}
    />
  );
  const view = render(card(savedStays));
  return { ...view, preview, workItemId, rerenderWithSaved: (stored: Record<string, SavedStayCommit>) => view.rerender(card(stored)) };
}

async function previewBoth() {
  for (let index = 0; index < 2; index += 1) {
    fireEvent.change(screen.getAllByLabelText('Track')[index]!, { target: { value: 'COR' } });
    fireEvent.change(screen.getAllByLabelText('Source of business')[index]!, { target: { value: 'E-Mail' } });
    fireEvent.change(screen.getAllByLabelText('Guarantee')[index]!, { target: { value: 'Confirmation Received' } });
  }
  fireEvent.click(screen.getAllByRole('button', { name: 'Preview in HMS' })[0]!);
  fireEvent.click(screen.getAllByRole('button', { name: 'Preview in HMS' })[1]!);
  const button = screen.getByRole('button', { name: 'Book this stay' });
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  return button;
}

describe('multi-room save recovery', () => {
  it('lets another date retry after the server clears a hold, even with a stale off-draft receipt', async () => {
    const commit = vi.fn<PaneStayClient['commit']>()
      .mockResolvedValueOnce({ status: 'refused', reason: 'pane_save_dependency_unconfirmed' })
      .mockResolvedValueOnce(firstVerified).mockResolvedValueOnce(secondVerified);
    renderCase(commit, { s_other_1: { confirmationNumber: null, status: 'unknown', screenshotRef: null } });
    fireEvent.click(await previewBoth());
    await screen.findByText('An earlier booking is unconfirmed, so Nava did not save this room.');
    expect(commit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview in HMS' })[0]!);
    const batch = screen.getByRole('button', { name: 'Book this stay' });
    await waitFor(() => expect(batch).toHaveProperty('disabled', false));
    fireEvent.click(batch);
    expect(await screen.findByText('Booked 2 of 2 – TEST-FIRST, TEST-SECOND')).toBeDefined();
    expect(commit).toHaveBeenCalledTimes(3);
  });

  it('disables preview and booking until the request identity is available', () => {
    const commit = vi.fn<PaneStayClient['commit']>();
    const { preview } = renderCase(commit, undefined, false);
    for (let index = 0; index < 2; index += 1) {
      fireEvent.change(screen.getAllByLabelText('Track')[index]!, { target: { value: 'COR' } });
      fireEvent.change(screen.getAllByLabelText('Source of business')[index]!, { target: { value: 'E-Mail' } });
      fireEvent.change(screen.getAllByLabelText('Guarantee')[index]!, { target: { value: 'Confirmation Received' } });
    }
    expect(screen.getByText('Nava could not connect this booking to the request. Reopen the request to continue.')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Preview in HMS' })
      .every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByRole('button', { name: 'Book this stay' })).toHaveProperty('disabled', true);
    expect(preview).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(['unconfirmed result', 'interrupted request'] as const)(
    'holds both later batch and individual actions after an %s',
    async (failure) => {
      const commit = vi.fn<PaneStayClient['commit']>();
      if (failure === 'unconfirmed result') commit.mockResolvedValueOnce(unconfirmed);
      else commit.mockRejectedValueOnce(new Error('Synthetic interruption'));
      commit.mockResolvedValueOnce(secondVerified);
      renderCase(commit);
      const batch = await previewBoth();
      fireEvent.click(batch);
      await screen.findByText('Unconfirmed');
      const individual = screen.getByRole('button', { name: 'Create provisional booking' });
      expect(batch).toHaveProperty('disabled', true);
      expect(individual).toHaveProperty('disabled', true);
      fireEvent.click(batch);
      fireEvent.click(individual);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/Booked \d of 2/)).toBeNull();
    },
  );

  it('shows an unverified number without counting it and blocks dependent rooms', async () => {
    const commit = vi.fn<PaneStayClient['commit']>().mockResolvedValueOnce({
      status: 'ok', outcome: 'committed_unverified', confirmationNumber: 'TEST-UNCERTAIN', screenshots: [],
    });
    renderCase(commit);
    const batch = await previewBoth();
    fireEvent.click(batch);
    await screen.findByText('Booking not verified in HMS.');
    expect(screen.getByText('Possible confirmation: TEST-UNCERTAIN (not verified)')).toBeDefined();
    expect(screen.queryByText(/Booked \d of 2/)).toBeNull();
    expect(batch).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Create provisional booking' })).toHaveProperty('disabled', true);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('keeps a restored unknown confirmation visible without treating it as booked', () => {
    const commit = vi.fn<PaneStayClient['commit']>();
    renderCase(commit, {
      s_aaaa1111_1: { confirmationNumber: 'TEST-UNCERTAIN', status: 'unknown', screenshotRef: null },
    });
    expect(screen.getByText('Possible confirmation: TEST-UNCERTAIN (not verified)')).toBeDefined();
    expect(screen.queryByText(/Booked \d of 2/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Book this stay' })).toHaveProperty('disabled', true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('shows an uncertain CMS mismatch and number without a booked label, even without a draft', () => {
    const saved: SavedStayCommit = {
      confirmationNumber: 'TEST-UNCERTAIN', status: 'unknown', screenshotRef: null,
      cmsReason: 'saved_cms_mismatch',
    };
    const view = renderCase(vi.fn<PaneStayClient['commit']>(), { s_aaaa1111_1: saved });
    expect(screen.getByText('HMS confirmation settings did not match. Booking is unverified.')).toBeDefined();
    expect(screen.getByText('Possible confirmation: TEST-UNCERTAIN (not verified)')).toBeDefined();
    expect(screen.queryByText(/^Booked/)).toBeNull();
    view.unmount();
    render(<SavedStayReceipt saved={saved} />);
    expect(screen.getByText('Possible confirmation: TEST-UNCERTAIN (not verified)')).toBeDefined();
    expect(screen.queryByText(/^Booked/)).toBeNull();
  });

  it('retains the first confirmed number when a linked second room is uncertain', async () => {
    const commit = vi.fn<PaneStayClient['commit']>().mockResolvedValueOnce(firstVerified).mockResolvedValueOnce(unconfirmed);
    renderCase(commit);
    fireEvent.click(await previewBoth());
    await screen.findByText('Unconfirmed');
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]?.[0]).toMatchObject({ stayId: 's_aaaa1111_2', parentStayId: 's_aaaa1111_1' });
    expect(screen.getByText('Booked in HMS – confirmation TEST-FIRST')).toBeDefined();
    expect(screen.getByText('Booked 1 of 2 – TEST-FIRST')).toBeDefined();
  });

  it('continues a batch after its in-flight unknown claim resolves to a verified parent', async () => {
    let finish!: (value: PaneStayResult) => void;
    const commit = vi.fn<PaneStayClient['commit']>()
      .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(secondVerified);
    const view = renderCase(commit);
    fireEvent.click(await previewBoth());
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    view.rerenderWithSaved({ s_aaaa1111_1: { confirmationNumber: null, status: 'unknown', screenshotRef: null } });
    await act(async () => finish(firstVerified));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit.mock.calls[1]?.[0]).toMatchObject({ parentStayId: 's_aaaa1111_1' });
    expect(await screen.findByText('Booked 2 of 2 – TEST-FIRST, TEST-SECOND')).toBeDefined();
  });

  it('lets the remaining room proceed when a verified receipt arrives before a lost response', async () => {
    let fail!: (reason: Error) => void;
    const commit = vi.fn<PaneStayClient['commit']>()
      .mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }))
      .mockResolvedValueOnce(secondVerified);
    const view = renderCase(commit);
    const batch = await previewBoth();
    fireEvent.click(batch);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    view.rerenderWithSaved({ s_aaaa1111_1: { confirmationNumber: 'TEST-FIRST', status: 'booked', screenshotRef: null } });
    expect(await screen.findByText('Booked in HMS – confirmation TEST-FIRST')).toBeDefined();
    await act(async () => fail(new Error('Synthetic lost response')));
    await waitFor(() => expect(batch).toHaveProperty('disabled', false));
    fireEvent.click(batch);
    expect(await screen.findByText('Booked 2 of 2 – TEST-FIRST, TEST-SECOND')).toBeDefined();
    expect(commit.mock.calls[1]?.[0]).toMatchObject({ parentStayId: 's_aaaa1111_1' });
  });

  it('keeps the hold if a later unverified number conflicts with the loaded receipt', async () => {
    let finish!: (value: PaneStayResult) => void;
    const commit = vi.fn<PaneStayClient['commit']>().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderCase(commit);
    const batch = await previewBoth();
    fireEvent.click(batch);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    view.rerenderWithSaved({ s_aaaa1111_1: { confirmationNumber: 'TEST-FIRST', status: 'booked', screenshotRef: null } });
    await act(async () => finish({
      status: 'ok', outcome: 'committed_unverified', confirmationNumber: 'TEST-OTHER', screenshots: [],
    }));
    expect(batch).toHaveProperty('disabled', true);
    view.rerenderWithSaved({ s_aaaa1111_1: { confirmationNumber: 'TEST-FIRST', status: 'booked', screenshotRef: null } });
    expect(batch).toHaveProperty('disabled', true);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('shows a number returned after an in-flight claim was loaded, while keeping the hold', async () => {
    let finish!: (value: PaneStayResult) => void;
    const commit = vi.fn<PaneStayClient['commit']>().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderCase(commit);
    await previewBoth();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create provisional booking' })[0]!);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    view.rerenderWithSaved({ s_aaaa1111_1: { confirmationNumber: null, status: 'unknown', screenshotRef: null } });
    await act(async () => finish({
      status: 'ok', outcome: 'committed_unverified', confirmationNumber: 'TEST-UNCERTAIN', screenshots: [],
    }));
    expect(screen.getByText('Possible confirmation: TEST-UNCERTAIN (not verified)')).toBeDefined();
    expect(screen.queryByText(/Booked \d of 2/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Book this stay' })).toHaveProperty('disabled', true);
  });

  it('clears its loaded in-flight claim after a definite refusal, but holds a later unknown snapshot', async () => {
    let finish!: (value: PaneStayResult) => void;
    const commit = vi.fn<PaneStayClient['commit']>().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderCase(commit);
    await previewBoth();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create provisional booking' })[0]!);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    view.rerenderWithSaved({ s_aaaa1111_1: { confirmationNumber: null, status: 'unknown', screenshotRef: null } });
    await act(async () => finish({ status: 'refused', reason: 'pane_save_preflight_unavailable', clickedSave: false }));
    expect(screen.getByText("Nava couldn't check the booking, so nothing was saved. Preview again later.")).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Create provisional booking' })[1]).toHaveProperty('disabled', false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview in HMS' })[0]!);
    const batch = screen.getByRole('button', { name: 'Book this stay' });
    await waitFor(() => expect(batch).toHaveProperty('disabled', false));
    view.rerenderWithSaved({ s_aaaa1111_1: { confirmationNumber: null, status: 'unknown', screenshotRef: null } });
    expect(batch).toHaveProperty('disabled', true);
  });

  it.each([
    { result: { status: 'refused', reason: PANE_SAVE_UNCONFIRMED_REASON, clickedSave: false } as PaneStayResult, number: null },
    { result: { status: 'refused', reason: 'pane_save_preflight_unavailable', clickedSave: false } as PaneStayResult, number: 'TEST-UNKNOWN' },
  ])('does not clear an unconfirmed refusal or a loaded possible number', async ({ result, number }) => {
    let finish!: (value: PaneStayResult) => void;
    const commit = vi.fn<PaneStayClient['commit']>().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderCase(commit);
    await previewBoth();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create provisional booking' })[0]!);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    view.rerenderWithSaved({ s_aaaa1111_1: { confirmationNumber: number, status: 'unknown', screenshotRef: null } });
    await act(async () => finish(result));
    expect(screen.getByRole('button', { name: 'Book this stay' })).toHaveProperty('disabled', true);
    if (number) expect(screen.getByText(`Possible confirmation: ${number} (not verified)`)).toBeDefined();
  });

  it('does not start another room while the first single-room action is in flight', async () => {
    let finish!: (value: PaneStayResult) => void;
    const commit = vi.fn<PaneStayClient['commit']>().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    renderCase(commit);
    await previewBoth();
    const buttons = screen.getAllByRole('button', { name: 'Create provisional booking' });
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(buttons[1]).toHaveProperty('disabled', true);
    fireEvent.click(buttons[1]!);
    expect(commit).toHaveBeenCalledTimes(1);
    await act(async () => finish(unconfirmed));
    expect(buttons[1]).toHaveProperty('disabled', true);
  });
});
