/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartyPicker } from '../components/quote-workflow/party-picker';
import {
  partyFromSuggestion,
  partySuggesterFromTrpc,
  type PartyFindReply,
  type PartySuggestion,
} from '../lib/quote-workflow/party-lookup';
import { bindExecuteStaffQuote, pickedParties } from '../lib/quote-workflow/staff-quote-bind';
import { emptyStaffQuoteHeader, type StaffQuoteParty } from '../lib/quote-workflow/types';

afterEach(() => {
  cleanup();
});

const WOOLWORTHS: StaffQuoteParty = { kind: 'company', nativeId: '49', name: 'Woolworths' };
const AGENCY: StaffQuoteParty = { kind: 'agency', nativeId: '569', name: 'Woolworths Agency' };
const CWT: PartySuggestion = {
  source: 'sender',
  kind: 'agency',
  name: 'CWT JNB',
  nativeId: '290',
  idStatus: 'listed',
};
const RENNIES: PartySuggestion = {
  source: 'body',
  kind: 'agency',
  name: 'RENNIES TRAVEL (PTY) LTD',
  nativeId: null,
  idStatus: 'unverified',
};

describe('the company and agency the quote sends', () => {
  it('keeps one company and one agency, each with a plain HMS id, and drops anything else', () => {
    expect(pickedParties({ company: WOOLWORTHS, agency: AGENCY })).toEqual({
      company: WOOLWORTHS,
      agency: AGENCY,
    });
    expect(pickedParties({ company: { ...WOOLWORTHS, nativeId: null as unknown as string } })).toBeUndefined();
    expect(pickedParties({ company: { ...AGENCY, kind: 'agency' } as StaffQuoteParty })).toBeUndefined();
    expect(pickedParties({ agency: { ...AGENCY, nativeId: 'id with spaces' } })).toBeUndefined();
    expect(pickedParties({})).toBeUndefined();
    expect(pickedParties(undefined)).toBeUndefined();
  });

  it('sends both picks on the pane bind, and nothing for an unverified pick', async () => {
    const mutate = vi.fn<(input: unknown) => Promise<{ status: 'unavailable' }>>(async () => ({ status: 'unavailable' as const }));
    const header = { ...emptyStaffQuoteHeader(), parties: { company: WOOLWORTHS, agency: AGENCY } };
    await bindExecuteStaffQuote({
      mutate,
      source: { messageId: 'm', threadId: 't', sourceHash: 'ab'.repeat(32) },
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [
        {
          id: 'g1',
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          quantity: 1,
          adults: 1,
          childrenAges: [] as number[],
          board: 'bb' as const,
          specialRequests: [] as string[],
          fields: {},
        },
      ],
      header,
    });
    const sent = mutate.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(sent?.parties).toEqual({ company: WOOLWORTHS, agency: AGENCY });
  });
});

describe('suggestions from the email', () => {
  it('only a suggestion HMS listed can become a party; an unverified one never does', () => {
    expect(partyFromSuggestion(CWT)).toEqual({ kind: 'agency', nativeId: '290', name: 'CWT JNB' });
    expect(partyFromSuggestion(RENNIES)).toBeNull();
    expect(partyFromSuggestion({ ...CWT, nativeId: null, idStatus: 'listed' })).toBeNull();
  });

  it('binds panePartyLookup.suggest off a function-typed proxy client, as the pane passes it', async () => {
    const reply = { suggestions: [CWT] };
    const query = vi.fn(async () => reply);
    const routes = { panePartyLookup: { suggest: { query } } };
    const proxy = new Proxy(function () {}, {
      get: (_target, key) =>
        typeof key === 'string' && key in routes ? routes[key as keyof typeof routes] : undefined,
    });
    expect(typeof proxy).toBe('function');
    const suggest = partySuggesterFromTrpc(proxy);
    expect(suggest).not.toBeNull();
    await expect(suggest!({ sender: 'ops@mycwt.co.za', body: '' })).resolves.toEqual(reply);
    expect(query).toHaveBeenCalledWith({ sender: 'ops@mycwt.co.za', body: '' });
    expect(partySuggesterFromTrpc(undefined)).toBeNull();
  });
});

describe('PartyPicker with both kinds and suggestions', () => {
  const noFind = vi.fn(async (): Promise<PartyFindReply> => ({ outcome: 'no_match', results: [], truncated: false }));

  it('shows a chip per pick, and Clear names the kind it clears', () => {
    const onClear = vi.fn();
    render(
      <PartyPicker
        name="Woolworths"
        parties={{ company: WOOLWORTHS, agency: AGENCY }}
        find={noFind}
        onPick={vi.fn()}
        onClear={onClear}
      />,
    );
    expect(screen.getByText('✓ Woolworths (HMS)')).toBeTruthy();
    expect(screen.getByText('✓ Woolworths Agency (HMS)')).toBeTruthy();
    const clears = screen.getAllByRole('button', { name: 'Clear' });
    expect(clears).toHaveLength(2);
    fireEvent.click(clears[0]!);
    expect(onClear).toHaveBeenCalledWith('company');
  });

  it('offers an HMS-listed suggestion as a pick, and only after staff click it', () => {
    const onPick = vi.fn();
    render(
      <PartyPicker
        name="Woolworths"
        parties={{ company: WOOLWORTHS }}
        find={noFind}
        onPick={onPick}
        onClear={vi.fn()}
        suggestions={[CWT]}
      />,
    );
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use CWT JNB' }));
    expect(onPick).toHaveBeenCalledWith({ kind: 'agency', nativeId: '290', name: 'CWT JNB' });
  });

  it('an unverified suggestion can only be searched: it is never a pick, and no lookup runs by itself', () => {
    const onPick = vi.fn();
    const onSearchName = vi.fn();
    const find = vi.fn(async (): Promise<PartyFindReply> => ({ outcome: 'no_match', results: [], truncated: false }));
    render(
      <PartyPicker
        name=""
        parties={{}}
        find={find}
        onPick={onPick}
        onClear={vi.fn()}
        suggestions={[RENNIES]}
        onSearchName={onSearchName}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
    expect(screen.getByText('RENNIES TRAVEL (PTY) LTD (Agency), not confirmed in HMS')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS for this name' }));
    expect(onSearchName).toHaveBeenCalledWith('RENNIES TRAVEL (PTY) LTD', 'agency');
    expect(onPick).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it('hides a suggestion for a kind already picked, and says so when nothing can search it', () => {
    render(
      <PartyPicker
        name="Woolworths"
        parties={{ company: WOOLWORTHS }}
        find={noFind}
        onPick={vi.fn()}
        onClear={vi.fn()}
        suggestions={[{ ...RENNIES, kind: 'company', name: 'Another Company' }]}
      />,
    );
    expect(screen.queryByText(/Another Company/)).toBeNull();
    render(
      <PartyPicker name="Woolworths" parties={{}} find={noFind} onPick={vi.fn()} onClear={vi.fn()} suggestions={[RENNIES]} />,
    );
    expect((screen.getAllByRole('button', { name: 'Search HMS for this name' })[0] as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('PartyPicker scoped to one field of the header', () => {
  it('a field shows only its kind: its chip, its suggestions and its results', async () => {
    const find = vi.fn<(name: string) => Promise<PartyFindReply>>(async () => ({
      outcome: 'resolved',
      results: [
        { kind: 'company', nativeId: '49', name: 'Woolworths Holdings' },
        { kind: 'agency', nativeId: '290', name: 'CWT JNB' },
      ],
      truncated: false,
    }));
    const companySuggestion: PartySuggestion = { ...CWT, kind: 'company', name: 'Woolworths Company', nativeId: '77' };
    render(
      <PartyPicker
        kind="agency"
        name="CWT"
        parties={{ company: WOOLWORTHS }}
        find={find}
        onPick={vi.fn()}
        onClear={vi.fn()}
        suggestions={[CWT, companySuggestion]}
      />,
    );
    expect(screen.queryByText('✓ Woolworths (HMS)')).toBeNull();
    expect(screen.getByRole('button', { name: 'Use CWT JNB' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use Woolworths Company' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS now' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'CWT JNB' })).toBeTruthy());
    expect(find).toHaveBeenCalledWith('CWT');
    expect(screen.queryByRole('button', { name: 'Woolworths Holdings' })).toBeNull();
  });

  it('says when HMS matched only the other kind, and picks nothing', async () => {
    const onPick = vi.fn();
    const find = vi.fn<(name: string) => Promise<PartyFindReply>>(async () => ({
      outcome: 'resolved',
      results: [{ kind: 'company', nativeId: '49', name: 'Woolworths Holdings' }],
      truncated: false,
    }));
    render(<PartyPicker kind="agency" name="Woolworths" parties={{}} find={find} onPick={onPick} onClear={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS now' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No agency match in HMS for this name.'));
    expect(screen.queryByRole('button', { name: 'Woolworths Holdings' })).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('the quote workflow header: each field finds in HMS with its own text', () => {
  const groupFor = (field: 'Company' | 'Agency') => screen.getByRole('group', { name: `${field} lookup in HMS` });

  it('Find under Company searches the Company text, and a pick sets the company and its name', async () => {
    const { QuoteWorkflowPanel } = await import('../components/quote-workflow/quote-workflow-panel');
    const { initialQuoteSession } = await import('../lib/quote-workflow/session');
    const onPatchStaffHeader = vi.fn();
    const find = vi.fn<(name: string) => Promise<PartyFindReply>>(async () => ({
      outcome: 'resolved',
      results: [{ kind: 'company', nativeId: '49', name: 'Woolworths Holdings' }],
      truncated: false,
    }));
    const session = {
      ...initialQuoteSession(),
      phase: 'review' as const,
      staffHeader: { ...emptyStaffQuoteHeader(), company: 'Woolworths' },
    };
    render(
      <QuoteWorkflowPanel
        session={session}
        onPatchStaffHeader={onPatchStaffHeader}
        findParty={find}
        partySuggestions={[CWT]}
      />,
    );
    fireEvent.click(within(groupFor('Company')).getByRole('button', { name: 'Search HMS now' }));
    await waitFor(() =>
      expect(within(groupFor('Company')).getByRole('button', { name: 'Woolworths Holdings' })).toBeTruthy(),
    );
    expect(find).toHaveBeenCalledWith('Woolworths');
    fireEvent.click(within(groupFor('Company')).getByRole('button', { name: 'Woolworths Holdings' }));
    expect(onPatchStaffHeader).toHaveBeenCalledWith({
      parties: { company: { kind: 'company', nativeId: '49', name: 'Woolworths Holdings' } },
      company: 'Woolworths Holdings',
    });
  });

  it('Find under Agency searches the Agency text, not the Company text, and lists only agencies', async () => {
    const { QuoteWorkflowPanel } = await import('../components/quote-workflow/quote-workflow-panel');
    const { initialQuoteSession } = await import('../lib/quote-workflow/session');
    const onPatchStaffHeader = vi.fn();
    const find = vi.fn<(name: string) => Promise<PartyFindReply>>(async () => ({
      outcome: 'resolved',
      results: [
        { kind: 'company', nativeId: '49', name: 'Woolworths Holdings' },
        { kind: 'agency', nativeId: '571', name: 'Acme Travel HQ' },
      ],
      truncated: false,
    }));
    const session = {
      ...initialQuoteSession(),
      phase: 'review' as const,
      staffHeader: { ...emptyStaffQuoteHeader(), company: 'Woolworths', agency: 'Acme Travel' },
    };
    render(
      <QuoteWorkflowPanel
        session={session}
        onPatchStaffHeader={onPatchStaffHeader}
        findParty={find}
        partySuggestions={[]}
      />,
    );
    fireEvent.click(within(groupFor('Agency')).getByRole('button', { name: 'Search HMS now' }));
    await waitFor(() =>
      expect(within(groupFor('Agency')).getByRole('button', { name: 'Acme Travel HQ' })).toBeTruthy(),
    );
    expect(find).toHaveBeenLastCalledWith('Acme Travel');
    expect(within(groupFor('Agency')).queryByRole('button', { name: 'Woolworths Holdings' })).toBeNull();
    fireEvent.click(within(groupFor('Company')).getByRole('button', { name: 'Search HMS now' }));
    await waitFor(() =>
      expect(within(groupFor('Company')).getByRole('button', { name: 'Woolworths Holdings' })).toBeTruthy(),
    );
    expect(find.mock.calls.map(([name]) => name)).toEqual(['Acme Travel', 'Woolworths']);
    expect(within(groupFor('Company')).queryByRole('button', { name: 'Acme Travel HQ' })).toBeNull();
    fireEvent.click(within(groupFor('Agency')).getByRole('button', { name: 'Acme Travel HQ' }));
    expect(onPatchStaffHeader).toHaveBeenCalledWith({
      parties: { agency: { kind: 'agency', nativeId: '571', name: 'Acme Travel HQ' } },
      agency: 'Acme Travel HQ',
    });
  });

  it('keeps the header plain text when no finder is bound', async () => {
    const { QuoteWorkflowPanel } = await import('../components/quote-workflow/quote-workflow-panel');
    const { initialQuoteSession } = await import('../lib/quote-workflow/session');
    render(
      <QuoteWorkflowPanel
        session={{ ...initialQuoteSession(), phase: 'review' as const, staffHeader: { ...emptyStaffQuoteHeader(), company: 'Woolworths' } }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Search HMS now' })).toBeNull();
  });
});
