/**
 * @vitest-environment happy-dom
 */
import {
  PARTY_TRUNCATED_NOTE,
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

  it('binds off a function-typed proxy client, as the pane passes the real tRPC client', async () => {
    const reply: PartyFindReply = { outcome: 'no_match', results: [], truncated: false };
    const mutate = vi.fn(async () => reply);
    const routes = { panePartyLookup: { findParty: { mutate } } };
    const proxy = new Proxy(function () {}, {
      get: (_target, key) =>
        typeof key === 'string' && key in routes ? routes[key as keyof typeof routes] : undefined,
    });
    expect(typeof proxy).toBe('function');
    const find = partyFinderFromTrpc(proxy);
    expect(find).not.toBeNull();
    await expect(find!('Safari')).resolves.toEqual(reply);
    expect(mutate).toHaveBeenCalledWith({ name: 'Safari' });
  });

  it('calls panePartyLookup.findParty with the typed name only', async () => {
    const reply: PartyFindReply = { outcome: 'no_match', results: [], truncated: false };
    const mutate = vi.fn(async () => reply);
    const find = partyFinderFromTrpc({ panePartyLookup: { findParty: { mutate } } });
    expect(find).not.toBeNull();
    await expect(find!('Safari')).resolves.toEqual(reply);
    expect(mutate).toHaveBeenCalledWith({ name: 'Safari' });
  });
});

describe('party copy', () => {
  it('shows the picked name with the HMS mark, and says why a search found nothing', () => {
    expect(partyChipText(ABC)).toBe('✓ ABC Travel (Pty) Ltd (HMS)');
    expect(partyNoCandidateNote('no_match')).toBe(
      'No match in HMS. Quote will use BAR unless you pick a company or agency.',
    );
    expect(partyNoCandidateNote('refused_lock_busy')).toContain('busy');
    expect(partyNoCandidateNote('refused_flag_off')).toBe(
      'HMS rate lookup is turned off here, so company and agency rates are not checked.',
    );
    expect(partyNoCandidateNote('execution_failure')).toBe("HMS search didn't apply — try again");
    expect(PARTY_TRUNCATED_NOTE).toBe('50+ matches — type more of the name');
  });
});

describe('PartyPicker', () => {
  it('shows the hint, and keeps Find in HMS disabled until a name is typed', () => {
    const find = vi.fn();
    render(
      <PartyPicker name="  " parties={{}} find={find} onPick={vi.fn()} onClear={vi.fn()} />,
    );
    expect(screen.getByText(PARTY_PICKER_HINT)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Search HMS now' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(find).not.toHaveBeenCalled();
  });

  it('lists companies and agencies from one search, and a click picks one with its kind, HMS id and name', async () => {
    const find = vi.fn(
      async (): Promise<PartyFindReply> => ({
        outcome: 'ambiguous',
        results: [
          { kind: 'company', nativeId: '4411', name: 'ABC Travel (Pty) Ltd' },
          { kind: 'agency', nativeId: '4412', name: 'ABC Travel Holdings' },
        ],
        truncated: false,
      }),
    );
    const onPick = vi.fn();
    render(
      <PartyPicker name="ABC" parties={{}} find={find} onPick={onPick} onClear={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS now' }));
    expect(screen.getByRole('status').textContent).toContain('about a minute');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'ABC Travel Holdings' })).toBeTruthy(),
    );
    expect(find).toHaveBeenCalledWith('ABC');
    expect(screen.getByText('Company')).toBeTruthy();
    expect(screen.getByText('Agency')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ABC Travel (Pty) Ltd' }));
    expect(onPick).toHaveBeenCalledWith(ABC);
  });

  it('shows the reason when a search gives no candidate, and picks nothing', async () => {
    const find = vi.fn(
      async (): Promise<PartyFindReply> => ({ outcome: 'no_match', results: [], truncated: false }),
    );
    const onPick = vi.fn();
    render(
      <PartyPicker name="Nobody" parties={{}} find={find} onPick={onPick} onClear={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS now' }));
    await waitFor(() => expect(screen.getByText(/No match in HMS/)).toBeTruthy());
    expect(onPick).not.toHaveBeenCalled();
  });

  it('says the search did not apply when the search itself failed, and never says no match', async () => {
    const find = vi.fn(
      async (): Promise<PartyFindReply> => ({
        outcome: 'execution_failure',
        results: [],
        truncated: false,
      }),
    );
    render(
      <PartyPicker name="360" parties={{}} find={find} onPick={vi.fn()} onClear={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS now' }));
    await waitFor(() => expect(screen.getByText("HMS search didn't apply — try again")).toBeTruthy());
    expect(screen.queryByText(/No match in HMS/)).toBeNull();
  });

  it('shows the 50-match copy when a search is truncated, with the candidates it did get', async () => {
    const find = vi.fn(
      async (): Promise<PartyFindReply> => ({
        outcome: 'ambiguous',
        results: [{ kind: 'company', nativeId: '1', name: 'Tourvest Branch One' }],
        truncated: true,
      }),
    );
    render(
      <PartyPicker name="Tour" parties={{}} find={find} onPick={vi.fn()} onClear={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS now' }));
    await waitFor(() => expect(screen.getByText(PARTY_TRUNCATED_NOTE)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Tourvest Branch One' })).toBeTruthy();
  });

  it('turns a failed search into the plain reason, not a thrown error', async () => {
    const find = vi.fn(async () => {
      throw new Error('network down');
    });
    render(
      <PartyPicker name="Safari" parties={{}} find={find} onPick={vi.fn()} onClear={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS now' }));
    await waitFor(() => expect(screen.getByText(/didn't apply/)).toBeTruthy());
  });

  it('shows the chip with Clear once a party is picked, whichever kind it is, and Clear calls back', () => {
    const onClear = vi.fn();
    render(
      <PartyPicker
        name="ABC Travel (Pty) Ltd"
        parties={{ company: ABC }}
        find={vi.fn()}
        onPick={vi.fn()}
        onClear={onClear}
      />,
    );
    expect(screen.getByText('✓ ABC Travel (Pty) Ltd (HMS)')).toBeTruthy();
    // Find stays: the other kind (agency) can still be picked alongside the company.
    expect(screen.queryByRole('button', { name: 'Search HMS now' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledWith('company');
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
    const mutate = vi.fn<(input: unknown) => Promise<typeof readyResult>>(async () => readyResult);
    await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay],
      header: { ...emptyStaffQuoteHeader(), company: 'ABC Travel (Pty) Ltd' },
    });
    const sent = mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain('parties');
  });

  it('sends the picked party as kind, nativeId and name, and nothing else of the header', async () => {
    const mutate = vi.fn<(input: unknown) => Promise<typeof readyResult>>(async () => readyResult);
    await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay],
      header: { ...emptyStaffQuoteHeader(), company: ABC.name, parties: { company: { ...ABC } } },
    });
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      parties: { company: { kind: 'company', nativeId: '4411', name: ABC.name } },
    });
    const sent = mutate.mock.calls[0]?.[0] as { parties: { company: object } };
    expect(Object.keys(sent.parties.company).sort()).toEqual(['kind', 'name', 'nativeId']);
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
      header: { parties: { company: { ...ABC } }, company: ABC.name },
    });
    expect(picked.staffHeader.parties).toEqual({ company: ABC });
    expect(picked.staffHeader.company).toBe(ABC.name);
    expect(picked.inputRevision).toBe(before.inputRevision + 1);
    const cleared = reduceQuoteSession(picked, {
      type: 'patch_staff_header',
      header: { parties: undefined },
    });
    expect(cleared.staffHeader.parties).toBeUndefined();
    expect(emptyStaffQuoteHeader()).not.toHaveProperty('parties');
  });
});
