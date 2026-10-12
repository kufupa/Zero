/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('lists other matches as chips, and Change leaves one Find in HMS control', async () => {
    const find = vi.fn(async () =>
      reply({ outcome: 'ambiguous', results: [WOOLWORTHS, WOOLWORTHS_FOODS], best: WOOLWORTHS, searchedFor: 'Woolworths' }),
    );
    render(<Harness find={find} />);
    expect(await screen.findByText('✓ Woolworths Holdings (#49) — picked by Nava', undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Woolworths Foods (#50)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Woolworths Holdings (#49)' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Find in HMS' })).toBeTruthy();
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

  it('a name with no match says so, and staff can confirm a new Find in HMS result', async () => {
    const find = vi
      .fn<PartyFinder>()
      .mockResolvedValueOnce(reply({ outcome: 'no_match', searchedFor: 'Woolworths' }))
      .mockResolvedValueOnce(reply({ outcome: 'resolved', results: [WOOLWORTHS], best: WOOLWORTHS, searchedFor: 'Woolworths' }));
    render(<Harness find={find} />);
    expect(await screen.findByText('Not found in HMS — quote uses public rates', undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Search again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    const result = await screen.findByRole('list', { name: 'Companies and agencies found in HMS' });
    expect(screen.queryByText(/Not found in HMS/)).toBeNull();
    fireEvent.click(within(result).getByRole('button', { name: 'Woolworths Holdings' }));
    expect(await screen.findByText('✓ Woolworths Holdings (#49)')).toBeTruthy();
    expect(screen.queryByText(/picked by Nava/)).toBeNull();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('a busy HMS shows its copy and Find in HMS, and picks nothing', async () => {
    const find = vi.fn(async () => reply({ outcome: 'refused_lock_busy' }));
    const onPick = vi.fn();
    render(<PartyPicker name="Woolworths" kind="company" parties={{}} find={find} onPick={onPick} onClear={vi.fn()} autoLookup />);
    expect(await screen.findByText('HMS is busy with another run. Try again in a minute.', undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Find in HMS' })).toBeTruthy();
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

  it('keeps Find in HMS visible for an empty Company field, disabled until a name is entered', () => {
    const find = vi.fn(async () => reply({ outcome: 'no_match' }));
    render(<Harness find={find} name="" kind="company" />);
    const button = screen.getByRole('button', { name: 'Find in HMS' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(find).not.toHaveBeenCalled();
  });

  it('enables manual Find in HMS from two characters, not one', async () => {
    const find = vi.fn<PartyFinder>().mockResolvedValue(reply({ outcome: 'no_match' }));
    const { rerender } = render(<Harness find={find} name="A" autoLookup={false} />);
    expect((screen.getByRole('button', { name: 'Find in HMS' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<Harness find={find} name="Ab" autoLookup={false} />);
    const button = screen.getByRole('button', { name: 'Find in HMS' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(find).toHaveBeenCalledWith('Ab', 'company'));
  });

  it('shows manual HMS matches under the party field so staff can confirm one', async () => {
    const find = vi.fn(async () =>
      reply({ outcome: 'ambiguous', results: [WOOLWORTHS, WOOLWORTHS_FOODS], searchedFor: 'Woolworths' }),
    );
    render(<Harness find={find} autoLookup={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    expect(await screen.findByRole('list', { name: 'Companies and agencies found in HMS' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Woolworths Holdings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Woolworths Foods' })).toBeTruthy();
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

describe('automatic lookup when the name changes mid-search', () => {
  it('shows the finished search when staff come back to its name, instead of staying on Searching', async () => {
    let finish: (value: PartyFindReply) => void = () => undefined;
    const find = vi.fn<PartyFinder>((name) =>
      name === 'Woolworths'
        ? new Promise<PartyFindReply>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(reply({ outcome: 'no_match' })),
    );
    const { rerender } = render(<Harness find={find} name="Woolworths" />);
    await waitFor(() => expect(find).toHaveBeenCalledWith('Woolworths', 'company'));
    rerender(<Harness find={find} name="Pick n Pay" />);
    finish(reply({ results: [WOOLWORTHS], best: WOOLWORTHS, searchedFor: 'Woolworths' }));
    rerender(<Harness find={find} name="Woolworths" />);
    await screen.findByText(/Woolworths Holdings \(#49\)/, undefined, { timeout: 3000 });
    expect(screen.queryByText(/Searching HMS/)).toBeNull();
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

describe('automatic lookup reports whether it still decides the pick', () => {
  it('holds the field until its search has picked the best match', async () => {
    const onLookupPending = vi.fn();
    const find = vi.fn(async () => reply({ best: WOOLWORTHS, results: [WOOLWORTHS] }));
    render(
      <PartyPicker
        name="Woolworths"
        kind="company"
        parties={{}}
        find={find}
        onPick={vi.fn()}
        onClear={vi.fn()}
        autoLookup
        onLookupPending={onLookupPending}
      />,
    );
    expect(onLookupPending).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(onLookupPending).toHaveBeenLastCalledWith(false), { timeout: 3000 });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('releases the field when the search finds no match', async () => {
    const onLookupPending = vi.fn();
    const find = vi.fn(async () => reply({}));
    render(
      <PartyPicker
        name="Woolworths"
        kind="company"
        parties={{}}
        find={find}
        onPick={vi.fn()}
        onClear={vi.fn()}
        autoLookup
        onLookupPending={onLookupPending}
      />,
    );
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await waitFor(() => expect(onLookupPending).toHaveBeenLastCalledWith(false), { timeout: 3000 });
  });
});
