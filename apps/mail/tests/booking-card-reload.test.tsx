/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingCards } from '../components/quote-workflow/booking-card';
import type { PaneStayClient } from '../lib/quote-workflow/pane-stay-bind';
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
            agency: 'XYZ TRAVEL',
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
});
