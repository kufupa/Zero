/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartyPicker, resetPartyAutoLookupForTests } from '../components/quote-workflow/party-picker';
import { useState } from 'react';
import {
  partySuggesterFromTrpc,
  type PartyFindReply,
  type PartySuggestion,
} from '../lib/quote-workflow/party-lookup';
import { bindExecuteStaffQuote, pickedParties } from '../lib/quote-workflow/staff-quote-bind';
import { emptyStaffQuoteHeader, type StaffQuoteParty } from '../lib/quote-workflow/types';

afterEach(() => {
  resetPartyAutoLookupForTests();
  cleanup();
});

const WOOLWORTHS: StaffQuoteParty = { kind: 'company', nativeId: '49', name: 'Woolworths' };
const AGENCY: StaffQuoteParty = { kind: 'agency', nativeId: '569', name: 'Woolworths Agency' };
const CWT: PartySuggestion = {
  source: 'sender',
  kind: 'agency',
  name: 'CWT JNB',
  nativeId: null,
  idStatus: 'unverified',
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
    expect(screen.getByText('✓ Woolworths')).toBeTruthy();
    expect(screen.getByText('✓ Woolworths Agency')).toBeTruthy();
    const clears = screen.getAllByRole('button', { name: 'Change' });
    expect(clears).toHaveLength(2);
    fireEvent.click(clears[0]!);
    expect(onClear).toHaveBeenCalledWith('company');
  });

  it('fills the top suggestion name when the field is empty, and does not pick without HMS', () => {
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
    expect(onSearchName).toHaveBeenCalledWith('RENNIES TRAVEL (PTY) LTD', 'agency');
    expect(screen.queryByText(/not confirmed in HMS/)).toBeNull();
    expect(screen.queryByText(/learned/i)).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it('hides a suggestion for a kind already picked', () => {
    const onSearchName = vi.fn();
    render(
      <PartyPicker
        name="Woolworths"
        parties={{ company: WOOLWORTHS }}
        find={noFind}
        onPick={vi.fn()}
        onClear={vi.fn()}
        suggestions={[{ ...RENNIES, kind: 'company', name: 'Another Company' }]}
        onSearchName={onSearchName}
      />,
    );
    expect(onSearchName).not.toHaveBeenCalled();
    expect(screen.queryByText(/Another Company/)).toBeNull();
    expect(screen.queryByText(/not confirmed in HMS/)).toBeNull();
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
    const companySuggestion: PartySuggestion = { ...CWT, kind: 'company', name: 'Woolworths Company' };
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
    expect(screen.queryByText('✓ Woolworths')).toBeNull();
    expect(screen.queryByText(/not confirmed in HMS/)).toBeNull();
    expect(screen.queryByText(/Woolworths Company/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'CWT JNB' })).toBeTruthy());
    expect(find).toHaveBeenCalledWith('CWT', 'agency');
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
    fireEvent.click(screen.getByRole('button', { name: 'Find in HMS' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No agency match in HMS for this name.'));
    expect(screen.queryByRole('button', { name: 'Woolworths Holdings' })).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('PartyPicker preselects the top suggestion', () => {
  it('never binds a domain suggestion when HMS returns a matching best row', async () => {
    const picked: StaffQuoteParty[] = [];
    const agency = { kind: 'agency' as const, nativeId: '290', name: 'CWT JNB' };
    const find = vi.fn(async (): Promise<PartyFindReply> => ({
      outcome: 'resolved',
      results: [agency],
      truncated: false,
      best: agency,
      searchedFor: 'CWT JNB',
    }));
    function PreselectHarness() {
      const [parties, setParties] = useState<{ agency?: StaffQuoteParty }>({});
      return (
        <PartyPicker
          autoLookup
          kind="agency"
          name="CWT JNB"
          parties={parties}
          find={find}
          suggestions={[CWT]}
          onPick={(party) => {
            picked.push(party);
            setParties({ agency: party });
          }}
          onClear={vi.fn()}
        />
      );
    }
    render(<PreselectHarness />);
    expect(await screen.findByRole('button', { name: 'Confirm CWT JNB' })).toBeTruthy();
    expect(picked).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Confirm Agency' })).toBeNull();
    expect(pickedParties({})).toEqual({});
  });

  it('does not pick an HMS best whose name is not the suggestion', async () => {
    const onPick = vi.fn();
    const best = { kind: 'agency' as const, nativeId: '1', name: 'Other Agency' };
    const find = vi.fn(async (): Promise<PartyFindReply> => ({
      outcome: 'resolved',
      results: [best],
      truncated: false,
      best,
      searchedFor: 'CWT JNB',
    }));
    render(
      <PartyPicker
        autoLookup
        kind="agency"
        name="CWT JNB"
        parties={{}}
        find={find}
        suggestions={[CWT]}
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Confirm Other Agency' })).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByText(/✓ /)).toBeNull();
  });
});

describe('the quote workflow header: each field finds in HMS with its own text', () => {
  it('Nava searches the Company text in HMS by itself and waits for staff to confirm the best company', async () => {
    const { QuoteWorkflowPanel } = await import('../components/quote-workflow/quote-workflow-panel');
    const { initialQuoteSession } = await import('../lib/quote-workflow/session');
    const { resetPartyAutoLookupForTests } = await import('../components/quote-workflow/party-picker');
    resetPartyAutoLookupForTests();
    const onPatchStaffHeader = vi.fn();
    const woolworths = { kind: 'company' as const, nativeId: '49', name: 'Woolworths Holdings' };
    const find = vi.fn(async (): Promise<PartyFindReply> => ({
      outcome: 'resolved',
      results: [woolworths],
      truncated: false,
      best: woolworths,
      searchedFor: 'Woolworths',
    }));
    const session = {
      ...initialQuoteSession(),
      phase: 'review' as const,
      staffHeader: { ...emptyStaffQuoteHeader(), company: 'Woolworths' },
    };
    render(<QuoteWorkflowPanel session={session} onPatchStaffHeader={onPatchStaffHeader} findParty={find} />);
    const confirm = await screen.findByRole('button', { name: 'Confirm Woolworths Holdings' });
    expect(onPatchStaffHeader).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(
      () =>
        expect(onPatchStaffHeader).toHaveBeenCalledWith(
          {
            parties: { company: woolworths },
            company: 'Woolworths Holdings',
          },
          { staffEdit: true },
        ),
      { timeout: 3000 },
    );
    expect(find).toHaveBeenCalledWith('Woolworths', 'company');
    expect(find).not.toHaveBeenCalledWith('Woolworths', 'agency');
  }, 20_000);

  it('Nava searches the Agency text as an agency, never the Company text', async () => {
    const { QuoteWorkflowPanel } = await import('../components/quote-workflow/quote-workflow-panel');
    const { initialQuoteSession } = await import('../lib/quote-workflow/session');
    const { resetPartyAutoLookupForTests } = await import('../components/quote-workflow/party-picker');
    resetPartyAutoLookupForTests();
    const find = vi.fn(async (): Promise<PartyFindReply> => ({
      outcome: 'no_match',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    }));
    const session = {
      ...initialQuoteSession(),
      phase: 'review' as const,
      staffHeader: { ...emptyStaffQuoteHeader(), company: 'Woolworths', agency: 'Acme Travel' },
    };
    render(<QuoteWorkflowPanel session={session} onPatchStaffHeader={vi.fn()} findParty={find} />);
    await waitFor(() => expect(find).toHaveBeenCalledWith('Acme Travel', 'agency'), { timeout: 3000 });
    expect(find).not.toHaveBeenCalledWith('Woolworths', 'agency');
    expect(find).not.toHaveBeenCalledWith('Acme Travel', 'company');
  }, 20_000);

  it('keeps the header plain text when no finder is bound', async () => {
    const { QuoteWorkflowPanel } = await import('../components/quote-workflow/quote-workflow-panel');
    const { initialQuoteSession } = await import('../lib/quote-workflow/session');
    render(
      <QuoteWorkflowPanel
        session={{ ...initialQuoteSession(), phase: 'review' as const, staffHeader: { ...emptyStaffQuoteHeader(), company: 'Woolworths' } }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Find in HMS' })).toBeNull();
  });
});
