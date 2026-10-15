/**
 * @vitest-environment happy-dom
 */
import {
  partyFinderFromTrpc,
  type PartyFindReply,
  type PartyFinder,
} from '../lib/quote-workflow/party-lookup';
import {
  hmsJobTransport,
  type HmsJobClient,
  type HmsJobTransport,
} from '../lib/quote-workflow/amend-find';
import {
  PartyPicker,
  resetPartyAutoLookupForTests,
} from '../components/quote-workflow/party-picker';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { StaffQuoteParties, StaffQuoteParty } from '../lib/quote-workflow/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  resetPartyAutoLookupForTests();
});

const WOOLWORTHS: StaffQuoteParty = {
  kind: 'company',
  nativeId: '49',
  name: 'Woolworths Holdings',
};
const WOOLWORTHS_FOODS: StaffQuoteParty = {
  kind: 'company',
  nativeId: '50',
  name: 'Woolworths Foods',
};

function reply(overrides: Partial<PartyFindReply>): PartyFindReply {
  return {
    outcome: 'resolved',
    results: [],
    truncated: false,
    best: null,
    searchedFor: null,
    ...overrides,
  };
}

/** A picker that keeps its picks the way the quote header does: a pick sets the field, a clear empties it. */
function Harness({
  find,
  autoLookup = true,
  initial = {},
  name = 'Woolworths',
  kind = 'company',
  jobTransport,
}: {
  find: PartyFinder;
  autoLookup?: boolean;
  initial?: StaffQuoteParties;
  name?: string;
  kind?: StaffQuoteParty['kind'];
  jobTransport?: HmsJobTransport | null;
}) {
  const [parties, setParties] = useState<StaffQuoteParties>(initial);
  return (
    <PartyPicker
      name={name}
      kind={kind}
      parties={parties}
      find={find}
      autoLookup={autoLookup}
      jobTransport={jobTransport}
      threadId="thread-1"
      onPick={(party) => setParties((current) => ({ ...current, [party.kind]: party }))}
      onClear={(cleared) => setParties((current) => ({ ...current, [cleared]: undefined }))}
    />
  );
}

function inlinePartyJobTransport(find: PartyFinder): HmsJobTransport {
  const client: HmsJobClient = {
    queueFind: async () => ({ runId: null }),
    queueSearchGuest: async () => ({ runId: null }),
    queueParty: async () => ({ runId: null }),
    jobQueueEnabled: async () => false,
    findParty: ({ name, kind, threadId }) => find(name, kind, threadId ? { threadId } : undefined),
    jobStatus: async () => null,
    screenshot: async () => ({ status: 'unavailable', reason: 'screenshot_unavailable' }),
  };
  return hmsJobTransport(client, 'thread-1')!;
}

/** Lets the debounce pass without a search, so "no search ran" is a real check. */
function waitForDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 800));
}

describe('automatic HMS lookup for a company or agency field', () => {
  it('searches inline when the queue is off and offers the best match for staff confirmation', async () => {
    const find = vi.fn(async () =>
      reply({
        outcome: 'ambiguous',
        results: [WOOLWORTHS, WOOLWORTHS_FOODS],
        best: WOOLWORTHS,
        searchedFor: 'Woolworths',
      }),
    );
    render(<Harness find={find} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Looking up in HMS — you can keep working');
    expect(status.textContent).toContain('elapsed');
    expect(status.textContent).toContain('Searching HMS for "Woolworths" (company)');
    expect(status.querySelector('svg')).toBeNull();
    const confirm = await screen.findByRole('button', { name: 'Confirm Woolworths Holdings' });
    expect(screen.queryByText(/✓ Woolworths Holdings/)).toBeNull();
    fireEvent.click(confirm);
    expect(await screen.findByText('✓ Woolworths Holdings (#49)')).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith('Woolworths', 'company', { threadId: 'thread-1' });
  });

  it('keeps queue-off explicit Find inline and lists manual results for a staff pick', async () => {
    const find = vi.fn(async () =>
      reply({
        outcome: 'ambiguous',
        results: [WOOLWORTHS, WOOLWORTHS_FOODS],
        best: WOOLWORTHS,
        searchedFor: 'Woolworths',
      }),
    );
    const jobTransport = inlinePartyJobTransport(find);
    render(<Harness find={find} jobTransport={jobTransport} />);

    await waitForDebounce();
    expect(find).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    const results = await screen.findByRole('list', {
      name: 'Companies and agencies found in HMS',
    });
    expect(find).toHaveBeenCalledTimes(2);
    fireEvent.click(within(results).getByRole('button', { name: 'Woolworths Holdings' }));
    expect(await screen.findByText('✓ Woolworths Holdings (#49)')).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenCalledWith('Woolworths', 'company', { threadId: 'thread-1' });
  });

  it('does not queue HMS jobs while typing; explicit Find queues one user lookup', async () => {
    const find = vi.fn<PartyFinder>();
    const queueParty = vi.fn<NonNullable<HmsJobClient['queueParty']>>(async () => ({
      runId: 'party-run',
    }));
    const jobStatus: HmsJobClient['jobStatus'] = async () => null;
    const client: HmsJobClient = {
      queueFind: async () => ({ runId: null }),
      queueSearchGuest: async () => ({ runId: null }),
      queueParty,
      jobQueueEnabled: async () => true,
      jobStatus,
      screenshot: async () => ({ status: 'unavailable', reason: 'screenshot_unavailable' }),
    };
    const jobTransport = hmsJobTransport(client, 'thread-1')!;
    const rendered = render(<Harness find={find} name="Woolw" jobTransport={jobTransport} />);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(queueParty).not.toHaveBeenCalled();
    rendered.rerender(<Harness find={find} name="Woolworths" jobTransport={jobTransport} />);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(queueParty).not.toHaveBeenCalled();
    await waitForDebounce();
    expect(queueParty).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    await waitFor(() => expect(queueParty).toHaveBeenCalledTimes(1), { timeout: 3000 });

    expect(queueParty).toHaveBeenCalledWith({
      threadId: 'thread-1',
      name: 'Woolworths',
      partyKind: 'company',
    });
    expect(find).not.toHaveBeenCalled();
  });

  it('lists other matches as chips, and Change leaves one Find in HMS control', async () => {
    const find = vi.fn(async () =>
      reply({
        outcome: 'ambiguous',
        results: [WOOLWORTHS, WOOLWORTHS_FOODS],
        best: WOOLWORTHS,
        searchedFor: 'Woolworths',
      }),
    );
    render(<Harness find={find} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Woolworths Holdings' }));
    expect(await screen.findByText('✓ Woolworths Holdings (#49)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Woolworths Foods (#50)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm Woolworths Holdings' })).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: 'Find in HMS' })).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('a pick from the chips is staff-confirmed', async () => {
    const find = vi.fn(async () =>
      reply({
        outcome: 'ambiguous',
        results: [WOOLWORTHS, WOOLWORTHS_FOODS],
        best: WOOLWORTHS,
        searchedFor: 'Woolworths',
      }),
    );
    render(<Harness find={find} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Woolworths Holdings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Woolworths Foods (#50)' }));
    expect(await screen.findByText('✓ Woolworths Foods (#50)')).toBeTruthy();
    expect(screen.queryByText(/picked by Nava/)).toBeNull();
  });

  it('a name with no match says so, and staff can confirm a new Find in HMS result', async () => {
    const find = vi
      .fn<PartyFinder>()
      .mockResolvedValueOnce(reply({ outcome: 'no_match', searchedFor: 'Woolworths' }))
      .mockResolvedValueOnce(
        reply({
          outcome: 'resolved',
          results: [WOOLWORTHS],
          best: WOOLWORTHS,
          searchedFor: 'Woolworths',
        }),
      );
    render(<Harness find={find} />);
    expect(
      await screen.findByText(
        'No company in HMS matches “Woolworths”. Check the spelling or search a shorter name.',
        undefined,
        { timeout: 3000 },
      ),
    ).toBeTruthy();
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
    render(
      <PartyPicker
        name="Woolworths"
        kind="company"
        parties={{}}
        find={find}
        onPick={onPick}
        onClear={vi.fn()}
        autoLookup
      />,
    );
    expect(
      await screen.findByText('HMS is busy with another lookup. Nava will retry.', undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Find in HMS' })).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('runs no search without autoLookup, and keeps one Find in HMS button', async () => {
    const find = vi.fn(async () =>
      reply({ outcome: 'resolved', results: [WOOLWORTHS], best: WOOLWORTHS }),
    );
    render(<Harness find={find} autoLookup={false} />);
    await waitForDebounce();
    expect(find).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    expect(
      await screen.findByRole('button', { name: 'Woolworths Holdings' }, { timeout: 3000 }),
    ).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith('Woolworths', 'company', { threadId: 'thread-1' });
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
    expect(
      (screen.getByRole('button', { name: 'Find in HMS' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    rerender(<Harness find={find} name="Ab" autoLookup={false} />);
    const button = screen.getByRole('button', { name: 'Find in HMS' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(find).toHaveBeenCalledWith('Ab', 'company', { threadId: 'thread-1' }));
  });

  it('shows manual HMS matches under the party field so staff can confirm one', async () => {
    const find = vi.fn(async () =>
      reply({
        outcome: 'ambiguous',
        results: [WOOLWORTHS, WOOLWORTHS_FOODS],
        searchedFor: 'Woolworths',
      }),
    );
    render(<Harness find={find} autoLookup={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    expect(
      await screen.findByRole('list', { name: 'Companies and agencies found in HMS' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Woolworths Holdings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Woolworths Foods' })).toBeTruthy();
  });

  it('runs no search when the field already holds its pick', async () => {
    const find = vi.fn(async () =>
      reply({ outcome: 'resolved', results: [WOOLWORTHS], best: WOOLWORTHS }),
    );
    render(<Harness find={find} initial={{ company: WOOLWORTHS }} />);
    await waitForDebounce();
    expect(find).not.toHaveBeenCalled();
    expect(screen.getByText('✓ Woolworths Holdings (#49)')).toBeTruthy();
  });

  it('runs no search for a name under three characters', async () => {
    const find = vi.fn(async () =>
      reply({ outcome: 'resolved', results: [WOOLWORTHS], best: WOOLWORTHS }),
    );
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
    await waitFor(() =>
      expect(find).toHaveBeenCalledWith('Woolworths', 'company', { threadId: 'thread-1' }),
    );
    rerender(<Harness find={find} name="Pick n Pay" />);
    finish(reply({ results: [WOOLWORTHS], best: WOOLWORTHS, searchedFor: 'Woolworths' }));
    rerender(<Harness find={find} name="Woolworths" />);
    await screen.findByRole('button', { name: 'Confirm Woolworths Holdings' }, { timeout: 3000 });
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
    await find?.('Foschini', 'company', { threadId: 'thread-1' });
    expect(mutate).toHaveBeenNthCalledWith(1, { name: 'Foschini', kind: 'company' });
    expect(mutate).toHaveBeenNthCalledWith(2, { name: 'Foschini' });
    expect(mutate).toHaveBeenNthCalledWith(3, {
      name: 'Foschini',
      kind: 'company',
      threadId: 'thread-1',
    });
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
