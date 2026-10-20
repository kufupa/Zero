/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { initialQuoteSession, planQuoteSteps } from '../lib/quote-workflow/session';
import type { QuoteSession, StaffQuoteAllocation, StayGroupRequirement } from '../lib/quote-workflow/types';

afterEach(cleanup);

const dateA = { arrivalDate: '2026-11-12', departureDate: '2026-11-14' };
const dateB = { arrivalDate: '2026-12-01', departureDate: '2026-12-03' };

function row(id: string, dates: typeof dateA, over: Partial<StayGroupRequirement> = {}): StayGroupRequirement {
  return {
    id,
    ...dates,
    board: 'bb',
    quantity: 1,
    adults: 2,
    roomPreference: 'STWN',
    childrenAges: [],
    specialRequests: [],
    fields: {},
    ...over,
  };
}

function requestSession(groups: StayGroupRequirement[], over: Partial<QuoteSession> = {}): QuoteSession {
  return { ...initialQuoteSession(), phase: 'requirements', groups, steps: planQuoteSteps(groups), ...over };
}

function renderPanel(session: QuoteSession) {
  const onPatchGroup = vi.fn();
  const onStayAction = vi.fn();
  render(<QuoteWorkflowPanel session={session} onPatchGroup={onPatchGroup} onStayAction={onStayAction} />);
  return { onPatchGroup, onStayAction };
}

function getRatesButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Search availability' }) as HTMLButtonElement;
}

describe('stay and room builder', () => {
  it('renders two stays, each with its own dates and rooms', () => {
    renderPanel(requestSession([row('a1', dateA), row('b1', dateB)]));
    expect(screen.getByRole('heading', { name: /^Stay 1 of 2\b/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Stay 2 of 2\b/ })).toBeTruthy();
    expect(screen.getAllByText('Check-in')).toHaveLength(2);
    expect(screen.getAllByText('Check-out')).toHaveLength(2);
  });

  it('totals 30 rooms and 50 guests for 20 twin rooms and 10 single rooms', () => {
    renderPanel(
      requestSession([
        row('t', dateA, { quantity: 20, adults: 2 }),
        row('s', dateA, { quantity: 10, adults: 1, roomPreference: 'STQN' }),
      ]),
    );
    expect(screen.getByText('30 rooms · 50 guests total')).toBeTruthy();
  });

  it('names each room type with its HMS code, e.g. Standard Queen (STQN)', () => {
    renderPanel(requestSession([row('a1', dateA, { roomPreference: 'STQN' })]));
    expect(screen.getByRole('option', { name: 'Standard Queen (STQN)' })).toBeTruthy();
    expect((screen.getByLabelText('Room type') as HTMLSelectElement).value).toBe('STQN');
  });

  it('shows the unknown room code the email asked for and still allows search on dates and occupancy', () => {
    renderPanel(requestSession([row('a1', dateA, { roomPreference: 'PENTHOUSE' })]));
    const roomType = screen.getByLabelText('Room type');
    if (!(roomType instanceof HTMLSelectElement)) throw new Error('Room type is not a select');
    expect(roomType.value).toBe('PENTHOUSE');
    expect(screen.getByRole('option', { name: 'Email request' })).toBeTruthy();
    expect(screen.queryByText('Choose a room type for each room before searching.')).toBeNull();
    expect(getRatesButton().disabled).toBe(false);
  });

  it('keeps date-range search enabled when a stay has no room type yet', () => {
    renderPanel(requestSession([row('a1', dateA), row('b1', dateB, { roomPreference: undefined })]));
    const searches = screen.getAllByRole('button', { name: /Search this date range for Stay/ }) as HTMLButtonElement[];
    expect(searches).toHaveLength(2);
    expect(searches[1]!.disabled).toBe(false);
    expect(screen.queryByText('Choose a room type for each room before searching.')).toBeNull();
  });

  it('hands stay actions to the shell: duplicate, remove and add', () => {
    const { onStayAction } = renderPanel(requestSession([row('a1', dateA), row('b1', dateB)]));
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy stay' })[0]!);
    expect(onStayAction).toHaveBeenLastCalledWith({
      type: 'duplicate_stay',
      stayId: 'd:2026-11-12:2026-11-14',
      token: expect.any(String),
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    expect(onStayAction).toHaveBeenLastCalledWith({ type: 'remove_stay', stayId: 'd:2026-12-01:2026-12-03' });
    fireEvent.click(screen.getByRole('button', { name: '+ Add another date range' }));
    expect(onStayAction).toHaveBeenLastCalledWith({ type: 'add_stay', token: expect.any(String) });
  });

  it('shows the Available chip once HMS has found the selected stay', () => {
    renderPanel(
      requestSession([row('a1', dateA)], {
        selectedStayKey: '2026-11-12:2026-11-14',
        staffQuote: { revisionRef: 'oa' } as StaffQuoteAllocation,
      }),
    );
    expect(screen.getByText('Available')).toBeTruthy();
  });
});
