/**
 * @vitest-environment happy-dom
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { StayRateGrid } from '../components/quote-workflow/stay-rate-grid';
import type { BarGridCell } from '../components/quote-workflow/rate-cards';
import type { RatePlanChoice } from '../components/quote-workflow/rate-plan-select';
import { draftMoney } from '../lib/quote-workflow/multi-option-draft';
import { initialQuoteSession, reduceQuoteSession, stayKeyForGroup } from '../lib/quote-workflow/session';
import type { QuoteSession, StaffQuoteAllocation, StayGroupRequirement } from '../lib/quote-workflow/types';

afterEach(cleanup);

describe('StayRateGrid', () => {
  it('emits the clicked room/rate/board tuple and displays that cell’s price and inventory', () => {
    const onSelect = vi.fn();
    const cells: BarGridCell[] = [
      {
        groupId: 'stay-a',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'RATE-1',
        rateLabel: 'Flexible',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: 215_000,
        roomsLeft: 5,
      },
      {
        groupId: 'stay-a',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'RATE-2',
        rateLabel: 'Flexible',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: 197_500,
        roomsLeft: 2,
      },
      {
        groupId: 'stay-b',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'RATE-2',
        rateLabel: 'Flexible',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: 180_000,
        roomsLeft: 1,
      },
    ];

    render(
      <StayRateGrid
        groupId="stay-a"
        cells={cells}
        contractChecked={false}
        plans={[]}
        onSelect={onSelect}
      />,
    );

    const grid = screen.getByRole('group', { name: 'Room, rate and board choices' });
    const selectedCell = within(grid).getByRole('button', { name: /RATE-2/ });
    fireEvent.click(selectedCell);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ roomCode: 'STWN', rateCode: 'RATE-2', board: 'bb' });
    expect(selectedCell.textContent).toContain(draftMoney(197_500));
    expect(selectedCell.getAttribute('aria-label')).toContain('Average price per room per night');
    expect(within(selectedCell).getByText('Rooms left: 2')).toBeDefined();
    expect(screen.getByText(/reference only/i)).toBeDefined();
    expect(within(grid).queryByText(draftMoney(180_000))).toBeNull();
  });

  it('preserves rate category tags and warns until contract context is checked', () => {
    const onSelect = vi.fn();
    const cells: BarGridCell[] = [
      {
        groupId: 'stay-a',
        roomCode: 'ROOM1',
        roomLabel: 'Room One',
        rateCode: 'BAR',
        rateLabel: 'Best Available Rate',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: null,
        roomsLeft: null,
        rateScope: 'public',
      },
      {
        groupId: 'stay-a',
        roomCode: 'ROOM1',
        roomLabel: 'Room One',
        rateCode: 'GOV1',
        rateLabel: 'Government plan',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: null,
        roomsLeft: null,
        rateScope: 'unknown',
      },
      {
        groupId: 'stay-a',
        roomCode: 'ROOM1',
        roomLabel: 'Room One',
        rateCode: 'CON1',
        rateLabel: 'PRESET plan',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: null,
        roomsLeft: null,
        rateScope: 'contextual',
      },
    ];
    const plans = [
      {
        code: 'GOV1',
        name: 'Government plan',
        board: 'bed_breakfast',
        government: true,
        category: 'government',
        readByNava: true,
      },
      {
        code: 'CON1',
        name: 'PRESET plan',
        board: 'bed_breakfast',
        contract: true,
        category: 'contract',
        readByNava: true,
      },
    ] satisfies RatePlanChoice[];
    const { rerender } = render(
      <StayRateGrid
        groupId="stay-a"
        cells={cells}
        contractChecked={false}
        plans={plans}
        onSelect={onSelect}
      />,
    );
    const grid = screen.getByRole('group', { name: 'Room, rate and board choices' });

    expect(screen.getByText('Public rates — contract not checked')).toBeDefined();
    expect(within(grid).getByText('Public')).toBeDefined();
    expect(within(grid).getByText('Government')).toBeDefined();
    expect(within(grid).queryByText('Contract')).toBeNull();

    rerender(
      <StayRateGrid
        groupId="stay-a"
        cells={cells}
        contractChecked={true}
        plans={plans}
        onSelect={onSelect}
      />,
    );

    expect(screen.queryByText('Public rates — contract not checked')).toBeNull();
    const checkedGrid = screen.getByRole('group', { name: 'Room, rate and board choices' });
    expect(within(checkedGrid).getByText('Contract')).toBeDefined();
  });
});

const GRID_STAY: StayGroupRequirement = {
  id: 'row-1',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  quantity: 1,
  adults: 2,
  childrenPerRoom: 0,
  childrenAges: [],
  board: 'bb',
  specialRequests: [],
  fields: {},
};

function gridPickSession(): QuoteSession {
  let session = reduceQuoteSession(initialQuoteSession(), {
    type: 'selection',
    binding: {
      transportId: 't1',
      mailboxEmail: 'desk@example.test',
      storeId: 'store',
      folderEntryId: 'inbox',
      entryId: 'e1',
      selectionEpoch: 1,
      scopeEpoch: 1,
    },
  });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: { intent: 'quote', groups: [GRID_STAY], secondaryAsks: [], alternatives: [] },
  });
  const group = session.groups[0]!;
  const stayKey = stayKeyForGroup(group);
  const quote = {
    workflowRunId: 'run-1',
    revisionRef: 'rev-1',
    factRefs: [],
    messageId: 'mail-1',
    threadId: 'thread-1',
    sourceHash: 'ab'.repeat(32),
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
    inputDigest: 'digest',
    totalMinor: 120_000,
    currency: 'ZAR',
    quoteRequestKey: stayKey,
    approvedHeader: session.staffHeader,
    availabilityBoard: [
      {
        groupId: group.id,
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'FLEX',
        rateLabel: 'Flexible',
        board: 'Bed & Breakfast R',
        boardLabel: 'Bed and breakfast',
        nightlyPriceMinor: 120_000,
        roomsLeft: 3,
      },
    ],
  } satisfies StaffQuoteAllocation;
  return {
    ...session,
    staffQuote: quote,
    staffQuotes: { ...session.staffQuotes, [stayKey]: quote },
  };
}

function WiredGridPanel({
  initial,
  onRunStep,
  seen,
}: {
  initial: QuoteSession;
  onRunStep: (stepId: string) => void;
  seen: { session: QuoteSession | null };
}) {
  const [session, setSession] = useState(initial);
  seen.session = session;
  return (
    <QuoteWorkflowPanel
      session={session}
      onStayAction={(action) => setSession((current) => reduceQuoteSession(current, action))}
      onPatchGroup={(groupId, patch) =>
        setSession((current) => reduceQuoteSession(current, { type: 'patch_group', groupId, patch }))
      }
      onRunStep={onRunStep}
    />
  );
}

describe('StayRateGrid in the quote panel', () => {
  it('pins the clicked room, rate and board and re-runs that stay', async () => {
    const onRunStep = vi.fn();
    const seen = { session: null as QuoteSession | null };
    const initial = gridPickSession();
    const stayKey = stayKeyForGroup(initial.groups[0]!);
    render(<WiredGridPanel initial={initial} onRunStep={onRunStep} seen={seen} />);

    fireEvent.click(screen.getByRole('button', { name: /Select Standard Twin \(STWN\), Flexible \(FLEX\)/ }));

    await waitFor(() => expect(onRunStep).toHaveBeenCalledWith(`quote-stay-${stayKey}`));
    expect(seen.session?.groups[0]).toMatchObject({ roomCodes: ['STWN'], rateCode: 'FLEX', board: 'bb' });
    expect(seen.session?.roomRateBoardSelections?.[initial.groups[0]!.id]).toEqual({
      roomCode: 'STWN',
      rateCode: 'FLEX',
      board: 'Bed & Breakfast R',
    });
  });
});
