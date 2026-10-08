/**
 * @vitest-environment happy-dom
 */
import {
  partyChipText,
  partyFinderFromTrpc,
  partyNoCandidateNote,
  type PartyFindReply,
} from '../lib/quote-workflow/party-lookup';
import { PARTY_PICKER_HINT, PartyPicker } from '../components/quote-workflow/party-picker';
import { emptyStaffQuoteHeader, type StaffQuoteParty } from '../lib/quote-workflow/types';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { bindExecuteStaffQuote } from '../lib/quote-workflow/staff-quote-bind';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

const ABC: StaffQuoteParty = { kind: 'company', nativeId: '4411', name: 'ABC Travel (Pty) Ltd' };

describe('partyFinderFromTrpc', () => {
  it('is null when the panePartyLookup route is not bound', () => {
    expect(partyFinderFromTrpc(null)).toBeNull();
    expect(partyFinderFromTrpc({ workstation: {} })).toBeNull();
  });

  it('calls panePartyLookup.findParty with the pane kind and the typed name', async () => {
    const mutate = vi.fn(
      async () => ({ outcome: 'no_match', candidates: [] }) satisfies PartyFindReply,
    );
    const find = partyFinderFromTrpc({ panePartyLookup: { findParty: { mutate } } });
    expect(find).not.toBeNull();
    await expect(find!('agency', 'Safari')).resolves.toEqual({
      outcome: 'no_match',
      candidates: [],
    });
    expect(mutate).toHaveBeenCalledWith({ kind: 'agency', name: 'Safari' });
  });
});

describe('party copy', () => {
  it('shows the picked name with the HMS mark, and says why a lookup found nothing', () => {
    expect(partyChipText(ABC)).toBe('✓ ABC Travel (Pty) Ltd (HMS)');
    expect(partyNoCandidateNote('no_match')).toContain('no company or agency by that name');
    expect(partyNoCandidateNote('refused_lock_busy')).toContain('busy');
    expect(partyNoCandidateNote('refused_flag_off')).toContain('public rates');
    expect(partyNoCandidateNote('execution_failure')).toContain("couldn't check HMS");
  });
});

describe('PartyPicker', () => {
  it('shows the hint, and keeps Find in HMS disabled until a name is typed', () => {
    const find = vi.fn();
    render(
      <PartyPicker
        kind="company"
        name="  "
        party={undefined}
        find={find}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText(PARTY_PICKER_HINT)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Find in HMS' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(find).not.toHaveBeenCalled();
  });

  it('lists every candidate, and a click on one picks it with its HMS id and name', async () => {
    const find = vi.fn(
      async (): Promise<PartyFindReply> => ({
        outcome: 'ambiguous',
        candidates: [
          { nativeId: '4411', displayName: 'ABC Travel (Pty) Ltd', kind: 'company' },
          { nativeId: '4412', displayName: 'ABC Travel Holdings', kind: 'company' },
        ],
      }),
    );
    const onPick = vi.fn();
    render(
      <PartyPicker
        kind="company"
        name="ABC"
        party={undefined}
        find={find}
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    expect(screen.getByRole('status').textContent).toContain('about 30 seconds');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'ABC Travel Holdings' })).toBeTruthy(),
    );
    expect(find).toHaveBeenCalledWith('company', 'ABC');
    fireEvent.click(screen.getByRole('button', { name: 'ABC Travel (Pty) Ltd' }));
    expect(onPick).toHaveBeenCalledWith(ABC);
  });

  it('shows the reason when a lookup gives no candidate, and picks nothing', async () => {
    const find = vi.fn(
      async () => ({ outcome: 'no_match', candidates: [] }) satisfies PartyFindReply,
    );
    const onPick = vi.fn();
    render(
      <PartyPicker
        kind="agency"
        name="Nobody"
        party={undefined}
        find={find}
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    await waitFor(() => expect(screen.getByText(/no company or agency by that name/)).toBeTruthy());
    expect(onPick).not.toHaveBeenCalled();
  });

  it('turns a failed lookup into the plain reason, not a thrown error', async () => {
    const find = vi.fn(async () => {
      throw new Error('network down');
    });
    render(
      <PartyPicker
        kind="agency"
        name="Safari"
        party={undefined}
        find={find}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    await waitFor(() => expect(screen.getByText(/couldn't check HMS/)).toBeTruthy());
  });

  it('shows the chip with Clear once a company is picked, and Clear calls back', () => {
    const onClear = vi.fn();
    render(
      <PartyPicker
        kind="company"
        name="ABC Travel (Pty) Ltd"
        party={ABC}
        find={vi.fn()}
        onPick={vi.fn()}
        onClear={onClear}
      />,
    );
    expect(screen.getByText('✓ ABC Travel (Pty) Ltd (HMS)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Find in HMS' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('does not show a company pick in the agency picker', () => {
    render(
      <PartyPicker
        kind="agency"
        name="ABC"
        party={ABC}
        find={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.queryByText(/\(HMS\)/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Find in HMS' })).toBeTruthy();
  });
});

describe('executeStaffQuote party on the pane bind', () => {
  const source = { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) };
  const stay = {
    id: 'g1',
    arrivalDate: '2026-11-12',
    departureDate: '2026-11-14',
    quantity: 1,
    adults: 1,
    childrenAges: [] as number[],
    board: 'bb' as const,
    specialRequests: [] as string[],
    fields: {},
  };
  const readyResult = {
    status: 'ready' as const,
    workflowRunId: 'run-1',
    revisionRef: 'rev-1',
    messageId: source.messageId,
    threadId: source.threadId,
    factRefs: [],
    selectionEpoch: 1,
    inputRevision: 1,
    inputDigest: 'digest',
    totalMinor: 850000,
    currency: 'ZAR',
    arrivalDate: '2026-11-12',
    departureDate: '2026-11-14',
    description: 'STWN NGOVDB',
  };

  it('sends no party key when no party was picked, so the request is unchanged', async () => {
    const mutate = vi.fn(async (_input: unknown) => readyResult);
    await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay],
      header: { ...emptyStaffQuoteHeader(), company: 'ABC Travel (Pty) Ltd' },
    });
    const sent = mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain('party');
  });

  it('sends the picked party as kind, nativeId and name, and nothing else of the header', async () => {
    const mutate = vi.fn(async (_input: unknown) => readyResult);
    await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay],
      header: { ...emptyStaffQuoteHeader(), company: ABC.name, party: { ...ABC } },
    });
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      party: { kind: 'company', nativeId: '4411', name: ABC.name },
    });
    const sent = mutate.mock.calls[0]?.[0] as { party: object };
    expect(Object.keys(sent.party).sort()).toEqual(['kind', 'name', 'nativeId']);
  });
});

describe('the picked party in the session header', () => {
  it('stores the pick on the header, bumps the input revision, and Clear removes it', () => {
    const before = reduceQuoteSession(initialQuoteSession(), {
      type: 'patch_staff_header',
      header: { company: 'x' },
    });
    const picked = reduceQuoteSession(before, {
      type: 'patch_staff_header',
      header: { party: { ...ABC }, company: ABC.name },
    });
    expect(picked.staffHeader.party).toEqual(ABC);
    expect(picked.staffHeader.company).toBe(ABC.name);
    expect(picked.inputRevision).toBe(before.inputRevision + 1);
    const cleared = reduceQuoteSession(picked, {
      type: 'patch_staff_header',
      header: { party: undefined },
    });
    expect(cleared.staffHeader.party).toBeUndefined();
    expect(emptyStaffQuoteHeader()).not.toHaveProperty('party');
  });
});
