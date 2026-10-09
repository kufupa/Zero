import type { StaffQuoteParty } from './types';

/** One HMS company or agency that the Find in HMS search found. The nativeId is HMS's own id. */
export type PartyCandidate = StaffQuoteParty;

/** panePartyLookup.findParty's reply. Refusals and failures carry no results. */
export type PartyFindReply = {
  outcome:
    | 'resolved'
    | 'ambiguous'
    | 'no_match'
    | 'input_gap'
    | 'execution_failure'
    | 'external_system_unavailable'
    | 'refused_flag_off'
    | 'refused_input_invalid'
    | 'refused_lock_unavailable'
    | 'refused_lock_busy';
  results: PartyCandidate[];
  /** True when an HMS grid held its 50-row load or the list was capped. More matches may exist. */
  truncated: boolean;
};

/** One search for a name over HMS companies and agencies. */
export type PartyFinder = (name: string) => Promise<PartyFindReply>;

type TrpcPanePartyRoutes = {
  panePartyLookup?: {
    findParty?: {
      mutate: (input: { name: string }) => Promise<PartyFindReply>;
    };
  };
};

/**
 * Binds panePartyLookup.findParty off a tRPC client. Null when the route is missing. The real client is a
 * function-backed proxy (typeof 'function'), so a function is accepted too, as in the other *FromTrpc helpers.
 */
export function partyFinderFromTrpc(trpc: unknown): PartyFinder | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const find = (trpc as TrpcPanePartyRoutes).panePartyLookup?.findParty;
  if (!find) return null;
  return (name) => find.mutate({ name });
}

/** The chip that replaces the Find in HMS button once staff pick a candidate. */
export function partyChipText(party: StaffQuoteParty): string {
  return `✓ ${party.name} (HMS)`;
}

/** The word shown beside each candidate, so a company and an agency with one name are told apart. */
export function partyKindLabel(kind: StaffQuoteParty['kind']): string {
  return kind === 'agency' ? 'Agency' : 'Company';
}

/** Shown when a search reached HMS's 50-row load: the name is too broad to list every match. */
export const PARTY_TRUNCATED_NOTE = '50+ matches — type more of the name';

/** What the picker says when a search gives no candidate to pick. The quote still runs. */
export function partyNoCandidateNote(outcome: PartyFindReply['outcome']): string {
  if (outcome === 'no_match')
    return 'No match in HMS. Quote will use BAR unless you pick a company or agency.';
  if (outcome === 'execution_failure') return "HMS search didn't apply — try again";
  if (outcome === 'refused_lock_busy')
    return 'HMS is busy with another run. Try again in a minute.';
  // The switch is off, so no company or agency rate is checked. The copy does not say which rates the quote uses.
  if (outcome === 'refused_flag_off')
    return 'HMS rate lookup is turned off here, so company and agency rates are not checked.';
  return "Nava couldn't check HMS for this name. Try again, or quote at public rates.";
}

/** Shown when HMS matched the name, but none of the kind the field holds. */
export function partyNoKindNote(kind: StaffQuoteParty['kind']): string {
  return `No ${partyKindLabel(kind).toLowerCase()} match in HMS for this name.`;
}

/**
 * A suggestion for the picker, from the sender's domain or a name the body states. Only a listed HMS id makes it a
 * party; an unverified suggestion is a name to search in HMS and never a pick.
 */
export type PartySuggestion = {
  source: 'sender' | 'body';
  kind: StaffQuoteParty['kind'];
  name: string;
  nativeId: string | null;
  idStatus: 'listed' | 'unverified';
};

export type PartySuggestReply = { suggestions: PartySuggestion[] };

export type PartySuggester = (input: { sender: string; body: string }) => Promise<PartySuggestReply>;

type TrpcPanePartySuggestRoutes = {
  panePartyLookup?: {
    suggest?: { query: (input: { sender: string; body: string }) => Promise<PartySuggestReply> };
  };
};

/** Binds panePartyLookup.suggest off a tRPC client. Null when the route is missing. Functions are accepted, as in the other *FromTrpc helpers. */
export function partySuggesterFromTrpc(trpc: unknown): PartySuggester | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const suggest = (trpc as TrpcPanePartySuggestRoutes).panePartyLookup?.suggest;
  if (!suggest) return null;
  return (input) => suggest.query(input);
}

/** The party a suggestion stands for, only when HMS listed its id. Null for an unverified suggestion. */
export function partyFromSuggestion(suggestion: PartySuggestion): StaffQuoteParty | null {
  if (suggestion.idStatus !== 'listed' || !suggestion.nativeId) return null;
  return { kind: suggestion.kind, nativeId: suggestion.nativeId, name: suggestion.name };
}

/**
 * The HMS list the sweep wrote, searched locally (panePartyLookup.typeahead). It never reaches HMS. Empty when there is
 * no list. A pick from it is only a candidate: the quote re-checks the id live in HMS before it binds.
 */
export type PartyIndexReply = {
  source: 'index';
  available: boolean;
  updatedAt: string | null;
  ageMs: number | null;
  results: PartyCandidate[];
};

export type PartyIndexSearcher = (query: string) => Promise<PartyIndexReply>;

type TrpcPartyIndexRoutes = {
  panePartyLookup?: {
    typeahead?: { query: (input: { query: string }) => Promise<PartyIndexReply> };
  };
};

/** Binds panePartyLookup.typeahead off a tRPC client. Null when the route is missing. Functions are accepted, as in the other *FromTrpc helpers. */
export function partyIndexFromTrpc(trpc: unknown): PartyIndexSearcher | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const typeahead = (trpc as TrpcPartyIndexRoutes).panePartyLookup?.typeahead;
  if (!typeahead) return null;
  return (query) => typeahead.query({ query });
}

/** Past this age the list may be out of date, and its heading says so. */
export const PARTY_INDEX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** How old the list is, in words: "just now", "12 min ago", "3 h ago", "1 day ago", "9 days ago". */
export function partyIndexAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** The heading over the list's matches: "From HMS list (updated 3 h ago)", with a warning once the list is stale. */
export function partyIndexHeading(ageMs: number): string {
  const stale = ageMs > PARTY_INDEX_STALE_MS;
  return `From HMS list (updated ${partyIndexAge(ageMs)}${stale ? ', may be out of date' : ''})`;
}
