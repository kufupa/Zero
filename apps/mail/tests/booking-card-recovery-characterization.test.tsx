/**
 * @vitest-environment happy-dom
 *
 * Offline characterization of the existing pane. These assertions describe current
 * behavior, including unsafe behavior; convert them to safety expectations when
 * the recovery fix is implemented rather than merging them as acceptance tests.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingCards } from '../components/quote-workflow/booking-card';
import {
  PANE_SAVE_UNCONFIRMED_REASON,
  type PaneStayClient,
  type PaneStayResult,
} from '../lib/quote-workflow/pane-stay-bind';
import type { BookingDraftReady, StayGroupRequirement } from '../lib/quote-workflow/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

afterEach(() => cleanup());

const group: StayGroupRequirement = {
  id: 'g1',
  stayId: 's_aaaa1111',
  arrivalDate: '2027-01-15',
  departureDate: '2027-01-17',
  quantity: 2,
  adults: 1,
  childrenAges: [],
  board: 'bb',
  specialRequests: [],
  fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' },
};

function draft(): BookingDraftReady {
  const room = {
    arrival: '2027-01-15',
    departure: '2027-01-17',
    adults: 1,
    childAges: [],
    roomType: 'STQN',
    ratePlan: 'TAXYZ',
    bookerEmail: 'booker@example.invalid',
    firstName: 'Synthetic',
    lastName: 'Traveller',
  };
  return {
    draft: {
      rooms: [
        { groupId: 'g1', roomIndex: 1, request: { ...room }, schemaErrors: [] },
        { groupId: 'g1', roomIndex: 2, request: { ...room }, schemaErrors: [] },
      ],
      rateCheck: [],
      missing: [],
      flags: [],
    },
    options: {
      track: ['COR'],
      sourceOfBusiness: ['E-Mail'],
      guaranteeType: ['Confirmation Received'],
      roomType: ['STQN'],
    },
    messageId: 'synthetic-mail',
    selectionEpoch: 1,
    inputRevision: 1,
    revisionRef: 'synthetic-revision',
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

function renderCase(commit: PaneStayClient['commit']) {
  // The real component's preview cache is module-scoped. A fresh identity keeps cases independent.
  const workItemId = `00000000-0000-4000-8000-${String(++workItemSequence).padStart(12, '0')}`;
  const preview = vi.fn<PaneStayClient['preview']>().mockResolvedValue(previewResult);
  const client: PaneStayClient = {
    preview,
    commit,
    screenshot: vi.fn(async () => null),
    mode: () => 'on',
  };
  const view = render(
    <BookingCards
      draft={draft()}
      groups={[group]}
      paneSave={client}
      workItemId={workItemId}
      propertyCode="HRCEN"
      contact={{ name: 'Example Booker', company: null, endClient: null, email: 'booker@example.invalid', phone: null }}
      confirmation={{ userEmail: 'staff@example.invalid', setting: { mode: 'self' } }}
    />,
  );
  return { ...view, preview, workItemId };
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

describe('offline characterization of multi-room recovery', () => {
  it.each(['unconfirmed result', 'interrupted request'])(
    'currently allows the second room on a later click after an %s',
    async (failure) => {
      const commit = vi.fn<PaneStayClient['commit']>();
      if (failure === 'unconfirmed result') commit.mockResolvedValueOnce(unconfirmed);
      else commit.mockRejectedValueOnce(new Error('Synthetic interruption'));
      commit.mockResolvedValueOnce(secondVerified);
      const { preview, workItemId } = renderCase(commit);
      const button = await previewBoth();
      expect(preview).toHaveBeenCalledTimes(2);

      fireEvent.click(button);
      await screen.findByText('Check HMS');
      expect(commit).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(button).toHaveProperty('disabled', false));

      fireEvent.click(button);
      await screen.findByText('Booked 1 of 2 – TEST-SECOND');
      expect(commit).toHaveBeenCalledTimes(2);
      expect(commit.mock.calls[0]?.[0]).toMatchObject({ workItemId, stayId: 's_aaaa1111_1' });
      expect(commit.mock.calls[1]?.[0]).toMatchObject({ workItemId, stayId: 's_aaaa1111_2' });
      expect(commit.mock.calls[1]?.[0]).not.toHaveProperty('parentStayId');
      expect(screen.getByText('Check HMS')).toBeDefined();
    },
  );

  it('currently counts an unverified confirmation as booked, including after the second click', async () => {
    const commit = vi.fn<PaneStayClient['commit']>()
      .mockResolvedValueOnce({
        status: 'ok', outcome: 'committed_unverified', confirmationNumber: 'TEST-UNCERTAIN', screenshots: [],
      })
      .mockResolvedValueOnce(secondVerified);
    renderCase(commit);
    const button = await previewBoth();

    fireEvent.click(button);
    await screen.findByText('Saved — check in Infor');
    expect(screen.getByText('Check HMS')).toBeDefined();
    expect(screen.getByText('Booked 1 of 2 – TEST-UNCERTAIN')).toBeDefined();
    expect(commit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button).toHaveProperty('disabled', false));

    fireEvent.click(button);
    await screen.findByText('Booked 2 of 2 – TEST-UNCERTAIN, TEST-SECOND');
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]?.[0]).not.toHaveProperty('parentStayId');
    expect(screen.getByText('Check HMS')).toBeDefined();
  });

  it('keeps the first verified confirmation when the linked second room becomes uncertain', async () => {
    const commit = vi.fn<PaneStayClient['commit']>()
      .mockResolvedValueOnce(firstVerified)
      .mockResolvedValueOnce(unconfirmed);
    renderCase(commit);
    fireEvent.click(await previewBoth());

    await screen.findByText('Check HMS');
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]?.[0]).toMatchObject({
      stayId: 's_aaaa1111_2', parentStayId: 's_aaaa1111_1',
    });
    expect(screen.getByText('Booked in HMS – confirmation TEST-FIRST')).toBeDefined();
    expect(screen.getByText('Booked 1 of 2 – TEST-FIRST')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Book this stay' })).toBeNull();
  });

  it('does not start the second room after the pane unmounts during the first commit', async () => {
    let finishFirst!: (result: PaneStayResult) => void;
    const firstInFlight = new Promise<PaneStayResult>((resolve) => { finishFirst = resolve; });
    const commit = vi.fn<PaneStayClient['commit']>().mockReturnValueOnce(firstInFlight);
    const view = renderCase(commit);
    fireEvent.click(await previewBoth());
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => finishFirst(firstVerified));
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
