/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PARTY_INDEX_DEBOUNCE_MS, PartyPicker } from '../components/quote-workflow/party-picker';
import {
  PARTY_INDEX_STALE_MS,
  partyIndexAge,
  partyIndexFromTrpc,
  partyIndexHeading,
  type PartyFindReply,
  type PartyIndexReply,
} from '../lib/quote-workflow/party-lookup';
import { emptyStaffQuoteHeader } from '../lib/quote-workflow/types';

afterEach(() => {
  cleanup();
});

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const WOOLWORTHS_COMPANY = { kind: 'company' as const, nativeId: '49', name: 'Woolworths Holdings' };
const WOOLWORTHS_AGENCY = { kind: 'agency' as const, nativeId: '571', name: 'Woolworths Travel' };
const ACME_AGENCY = { kind: 'agency' as const, nativeId: '612', name: 'Acme Travel HQ' };

function indexReply(results: PartyIndexReply['results'], ageMs: number | null = 3 * HOUR): PartyIndexReply {
  return { source: 'index', available: true, updatedAt: '2026-10-01T00:00:00.000Z', ageMs, results };
}

const NO_LIVE_MATCH = async (): Promise<PartyFindReply> => ({ outcome: 'no_match', results: [], truncated: false });

function picker(overrides: Partial<ComponentProps<typeof PartyPicker>> = {}) {
  return (
    <PartyPicker
      name="Woolworths"
      parties={{}}
      find={vi.fn<(name: string) => Promise<PartyFindReply>>(NO_LIVE_MATCH)}
      onPick={vi.fn()}
      onClear={vi.fn()}
      {...overrides}
    />
  );
}

describe('the HMS list age and heading', () => {
  it('words the age in steps', () => {
    expect(partyIndexAge(0)).toBe('just now');
    expect(partyIndexAge(59_999)).toBe('just now');
    expect(partyIndexAge(-5)).toBe('just now');
    expect(partyIndexAge(12 * 60_000)).toBe('12 min ago');
    expect(partyIndexAge(3 * HOUR)).toBe('3 h ago');
    expect(partyIndexAge(DAY)).toBe('1 day ago');
    expect(partyIndexAge(9 * DAY)).toBe('9 days ago');
  });

  it('warns only once the list is older than seven days', () => {
    expect(partyIndexHeading(3 * HOUR)).toBe('From HMS list (updated 3 h ago)');
    expect(partyIndexHeading(PARTY_INDEX_STALE_MS)).toBe('From HMS list (updated 7 days ago)');
    expect(partyIndexHeading(9 * DAY)).toBe('From HMS list (updated 9 days ago, may be out of date)');
  });
});

describe('panePartyLookup.typeahead off the tRPC client', () => {
  it('binds off a function-typed proxy, as the pane passes it, and is null without the route', async () => {
    const reply = indexReply([WOOLWORTHS_COMPANY]);
    const query = vi.fn(async () => reply);
    const routes = { panePartyLookup: { typeahead: { query } } };
    const proxy = new Proxy(function () {}, {
      get: (_target, key) =>
        typeof key === 'string' && key in routes ? routes[key as keyof typeof routes] : undefined,
    });
    expect(typeof proxy).toBe('function');
    const search = partyIndexFromTrpc(proxy);
    expect(search).not.toBeNull();
    await expect(search!('Wool')).resolves.toEqual(reply);
    expect(query).toHaveBeenCalledWith({ query: 'Wool' });
    expect(partyIndexFromTrpc(undefined)).toBeNull();
    expect(partyIndexFromTrpc({ panePartyLookup: {} })).toBeNull();
  });
});

describe('PartyPicker: matches from the HMS list', () => {
  it('asks the list once the typing rests, with the name as it stands then', async () => {
    const indexSearch = vi.fn(async () => indexReply([WOOLWORTHS_COMPANY]));
    const { rerender } = render(picker({ name: 'Wool', indexSearch }));
    rerender(picker({ name: 'Woolworths', indexSearch }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Woolworths Holdings' })).toBeTruthy());
    expect(indexSearch).toHaveBeenCalledTimes(1);
    expect(indexSearch).toHaveBeenCalledWith('Woolworths');
  });

  it('shows the matches under the list heading, and says so once the list is stale', async () => {
    const indexSearch = vi.fn(async () => indexReply([WOOLWORTHS_COMPANY], 9 * DAY));
    render(picker({ indexSearch }));
    const section = await screen.findByRole('region', { name: 'Matches from the HMS list' });
    expect(within(section).getByText('From HMS list (updated 9 days ago, may be out of date)')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Woolworths Holdings' })).toBeTruthy();
  });

  it('shows no list section without a list, or when the list is not available, and keeps the live button', async () => {
    const { unmount } = render(picker());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, PARTY_INDEX_DEBOUNCE_MS + 20));
    });
    expect(screen.queryByRole('region', { name: 'Matches from the HMS list' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Find in HMS' })).toBeTruthy();
    unmount();

    const indexSearch = vi.fn(async (): Promise<PartyIndexReply> => ({
      source: 'index',
      available: false,
      updatedAt: null,
      ageMs: null,
      results: [],
    }));
    render(picker({ indexSearch }));
    await waitFor(() => expect(indexSearch).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Matches from the HMS list' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Find in HMS' })).toBeTruthy();
  });

  it('a list reply for a name that has since changed is ignored', async () => {
    let resolveWool: (reply: PartyIndexReply) => void = () => undefined;
    const indexSearch = vi.fn((query: string): Promise<PartyIndexReply> => {
      if (query === 'Wool') {
        return new Promise<PartyIndexReply>((resolve) => {
          resolveWool = resolve;
        });
      }
      return Promise.resolve(indexReply([WOOLWORTHS_COMPANY]));
    });
    const { rerender } = render(picker({ name: 'Wool', indexSearch }));
    await waitFor(() => expect(indexSearch).toHaveBeenCalledWith('Wool'));
    rerender(picker({ name: 'Woolworths', indexSearch }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Woolworths Holdings' })).toBeTruthy());
    await act(async () => {
      resolveWool(indexReply([{ kind: 'company', nativeId: '1', name: 'Wool Stale Co' }]));
    });
    expect(screen.queryByRole('button', { name: 'Wool Stale Co' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Woolworths Holdings' })).toBeTruthy();
  });

  it('a pick from the list binds nothing by itself: no live search runs, and Find in HMS still does one', async () => {
    const onPick = vi.fn();
    const find = vi.fn<(name: string) => Promise<PartyFindReply>>(async () => ({
      outcome: 'resolved',
      results: [{ kind: 'company', nativeId: '50', name: 'Live Only Co' }],
      truncated: false,
    }));
    const indexSearch = vi.fn(async () => indexReply([WOOLWORTHS_COMPANY]));
    render(picker({ find, onPick, indexSearch }));
    fireEvent.click(await screen.findByRole('button', { name: 'Woolworths Holdings' }));
    expect(onPick).toHaveBeenCalledWith({ kind: 'company', nativeId: '49', name: 'Woolworths Holdings' });
    expect(find).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Live Only Co' })).toBeTruthy());
    expect(find).toHaveBeenCalledWith('Woolworths');
  });

  it('a field with a kind lists only matches of its kind', async () => {
    const indexSearch = vi.fn(async () => indexReply([WOOLWORTHS_COMPANY, WOOLWORTHS_AGENCY]));
    render(picker({ kind: 'agency', indexSearch }));
    const section = await screen.findByRole('region', { name: 'Matches from the HMS list' });
    expect(within(section).getByRole('button', { name: 'Woolworths Travel' })).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Woolworths Holdings' })).toBeNull();
  });
});

describe('the quote workflow header: the HMS list is asked with each field\'s own text', () => {
  it('the company and agency lists each answer their own field, and each shows only its kind', async () => {
    const { QuoteWorkflowPanel } = await import('../components/quote-workflow/quote-workflow-panel');
    const { initialQuoteSession } = await import('../lib/quote-workflow/session');
    const partyIndex = vi.fn(async (query: string) =>
      indexReply(query === 'Acme Travel' ? [ACME_AGENCY] : [WOOLWORTHS_COMPANY, WOOLWORTHS_AGENCY]),
    );
    const session = {
      ...initialQuoteSession(),
      phase: 'review' as const,
      staffHeader: { ...emptyStaffQuoteHeader(), company: 'Woolworths', agency: 'Acme Travel' },
    };
    render(
      <QuoteWorkflowPanel
        session={session}
        onPatchStaffHeader={vi.fn()}
        findParty={vi.fn<(name: string) => Promise<PartyFindReply>>(NO_LIVE_MATCH)}
        partySuggestions={[]}
        partyIndex={partyIndex}
      />,
    );
    const agencyGroup = screen.getByRole('group', { name: 'Agency lookup in HMS' });
    const companyGroup = screen.getByRole('group', { name: 'Company lookup in HMS' });
    await waitFor(() => expect(within(agencyGroup).getByRole('button', { name: 'Acme Travel HQ' })).toBeTruthy());
    await waitFor(() =>
      expect(within(companyGroup).getByRole('button', { name: 'Woolworths Holdings' })).toBeTruthy(),
    );
    expect(within(companyGroup).queryByRole('button', { name: 'Woolworths Travel' })).toBeNull();
    expect(within(agencyGroup).queryByRole('button', { name: 'Woolworths Holdings' })).toBeNull();
    expect(partyIndex.mock.calls.map(([query]) => query).sort()).toEqual(['Acme Travel', 'Woolworths']);
  });
});
