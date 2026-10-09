/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { PartyPicker, resetPartyAutoLookupForTests } from '../components/quote-workflow/party-picker';
import { partyFinderFromTrpc, type PartyFindReply, type PartyFinder } from '../lib/quote-workflow/party-lookup';
import type { StaffQuoteParties, StaffQuoteParty } from '../lib/quote-workflow/types';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  resetPartyAutoLookupForTests();
});

const WOOLWORTHS: StaffQuoteParty = { kind: 'company', nativeId: '49', name: 'Woolworths Holdings' };
const WOOLWORTHS_FOODS: StaffQuoteParty = { kind: 'company', nativeId: '50', name: 'Woolworths Foods' };

function reply(overrides: Partial<PartyFindReply>): PartyFindReply {
  return { outcome: 'resolved', results: [], truncated: false, best: null, searchedFor: null, ...overrides };
}

/** A picker that keeps its picks the way the quote header does: a pick sets the field, a clear empties it. */
function Harness({
  find,
  autoLookup = true,
  initial = {},
  name = 'Woolworths',
  kind = 'company',
}: {
  find: PartyFinder;
  autoLookup?: boolean;
  initial?: StaffQuoteParties;
  name?: string;
  kind?: StaffQuoteParty['kind'];
}) {
  const [parties, setParties] = useState<StaffQuoteParties>(initial);
  return (
    <PartyPicker
      name={name}
      kind={kind}
      parties={parties}
      find={find}
      autoLookup={autoLookup}
      onPick={(party) => setParties((current) => ({ ...current, [party.kind]: party }))}
      onClear={(cleared) => setParties((current) => ({ ...current, [cleared]: undefined }))}
    />
  );
}

/** Lets the debounce pass without a search, so "no search ran" is a real check. */
function waitForDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 800));
}

describe('automatic HMS lookup for a company or agency field', () => {
  it('searches HMS once for its kind and name, and picks the best match by itself', async () => {
    const find = vi.fn(async () =>
      reply({ outcome: 'ambiguous', results: [WOOLWORTHS, WOOLWORTHS_FOODS], best: WOOLWORTHS, searchedFor: 'Woolworths' }),
    );
    render(<Harness find={find} />);
    expect(screen.getByRole('status').textContent).toContain('Searching HMS for "Woolworths"');
    expect(await screen.findByText('✓ Woolworths Holdings (#49) — picked by Nava', undefined, { timeout: 3000 })).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith('Woolworths', 'company');
  });

  it('lists the other matches as chips, and Change clears the pick and shows them with Search again', async () => {
    const find = vi.fn(async () =>
      reply({ outcome: 'ambiguous', results: [WOOLWORTHS, WOOLWORTHS_FOODS], best: WOOLWORTHS, searchedFor: 'Woolworths' }),
    );
    render(<Harness find={find} />);
    expect(await screen.findByText('✓ Woolworths Holdings (#49) — picked by Nava', undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Woolworths Foods (#50)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Woolworths Holdings (#49)' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Search again' })).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('a pick from the chips is a plain pick, not "picked by Nava"', async () => {
    const find = vi.fn(async () =>
      reply({ outcome: 'ambiguous', results: [WOOLWORTHS, WOOLWORTHS_FOODS], best: WOOLWORTHS, searchedFor: 'Woolworths' }),
    );
    render(<Harness find={find} />);
    expect(await screen.findByText('✓ Woolworths Holdings (#49) — picked by Nava', undefined, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Woolworths Foods (#50)' }));
    expect(await screen.findByText('✓ Woolworths Foods (#50)')).toBeTruthy();
    expect(screen.queryByText(/picked by Nava/)).toBeNull();
  });

  it('a name with no match says so, and Search again runs a new search', async () => {
    const find = vi
      .fn<PartyFinder>()
      .mockResolvedValueOnce(reply({ outcome: 'no_match', searchedFor: 'Woolworths' }))
      .mockResolvedValueOnce(reply({ outcome: 'resolved', results: [WOOLWORTHS], best: WOOLWORTHS, searchedFor: 'Woolworths' }));
    render(<Harness find={find} />);
    expect(await screen.findByText('Not found in HMS — quote uses public rates', undefined, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
    expect(await screen.findByText('✓ Woolworths Holdings (#49) — picked by Nava', undefined, { timeout: 3000 })).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('a busy HMS shows its copy and Search again, and picks nothing', async () => {
    const find = vi.fn(async () => reply({ outcome: 'refused_lock_busy' }));
    const onPick = vi.fn();
    render(<PartyPicker name="Woolworths" kind="company" parties={{}} find={find} onPick={onPick} onClear={vi.fn()} autoLookup />);
    expect(await screen.findByText('HMS is busy with another run. Try again in a minute.', undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search again' })).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('runs no search without autoLookup, and keeps one Find in HMS button', async () => {
    const find = vi.fn(async () => reply({ outcome: 'resolved', results: [WOOLWORTHS], best: WOOLWORTHS }));
    render(<Harness find={find} autoLookup={false} />);
    await waitForDebounce();
    expect(find).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    expect(await screen.findByRole('button', { name: 'Woolworths Holdings' }, { timeout: 3000 })).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith('Woolworths', 'company');
  });

  it('runs no search when the field already holds its pick', async () => {
    const find = vi.fn(async () => reply({ outcome: 'resolved', results: [WOOLWORTHS], best: WOOLWORTHS }));
    render(<Harness find={find} initial={{ company: WOOLWORTHS }} />);
    await waitForDebounce();
    expect(find).not.toHaveBeenCalled();
    expect(screen.getByText('✓ Woolworths Holdings (#49)')).toBeTruthy();
  });

  it('runs no search for a name under three characters', async () => {
    const find = vi.fn(async () => reply({ outcome: 'resolved', results: [WOOLWORTHS], best: WOOLWORTHS }));
    render(<Harness find={find} name="Wo" />);
    await waitForDebounce();
    expect(find).not.toHaveBeenCalled();
  });
});

describe('the finder passes the kind it was given', () => {
  it('sends the kind with the name, and the name alone when there is none', async () => {
    const mutate = vi.fn(async () => reply({ outcome: 'resolved' }));
    // A function-typed client, as the real tRPC proxy is.
    const trpc = Object.assign(() => undefined, { panePartyLookup: { findParty: { mutate } } });
    const find = partyFinderFromTrpc(trpc);
    expect(find).not.toBeNull();
    await find?.('Foschini', 'company');
    await find?.('Foschini');
    expect(mutate).toHaveBeenNthCalledWith(1, { name: 'Foschini', kind: 'company' });
    expect(mutate).toHaveBeenNthCalledWith(2, { name: 'Foschini' });
  });
});
