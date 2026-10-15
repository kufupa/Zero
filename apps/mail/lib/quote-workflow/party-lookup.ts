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
    | 'refused_origin_mismatch'
    | 'refused_lock_unavailable'
    | 'refused_lock_busy';
  /** Best first, at most five for a kind search. */
  results: PartyCandidate[];
  /** True when an HMS grid held its 50-row load or the list was capped. More matches may exist. */
  truncated: boolean;
  /** The top row when it answers the typed name well. Null otherwise. Absent in a reply that predates it. */
  best?: PartyCandidate | null;
  /** The HMS search text that found the rows, or the last one tried. Null on a refusal or failure. */
  searchedFor?: string | null;
};

/** Mail the search belongs to. Pane callers send threadId; omit only for non-thread callers. */
export type PartyFindMail = {
  threadId?: string | null;
  messageId?: string | null;
};

/** One search for a name over HMS companies and agencies, or over one kind when given. */
export type PartyFinder = (
  name: string,
  kind?: StaffQuoteParty['kind'],
  mail?: PartyFindMail,
) => Promise<PartyFindReply>;

type TrpcPanePartyRoutes = {
  panePartyLookup?: {
    findParty?: {
      mutate: (input: {
        name: string;
        kind?: StaffQuoteParty['kind'];
        threadId?: string;
        messageId?: string;
      }) => Promise<PartyFindReply>;
    };
  };
};

/**
 * Binds panePartyLookup.findParty off a tRPC client. Null when the route is missing. The real client is a
 * function-backed proxy (typeof 'function'), so a function is accepted too, as in the other *FromTrpc helpers.
 * Pane searches must pass the active thread so the route can refuse Da Vinci origin before HMS.
 */
export function partyFinderFromTrpc(trpc: unknown): PartyFinder | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const find = (trpc as TrpcPanePartyRoutes).panePartyLookup?.findParty;
  if (!find) return null;
  return (name, kind, mail) => {
    const threadId = mail?.threadId?.trim();
    const messageId = mail?.messageId?.trim();
    return find.mutate({
      name,
      ...(kind ? { kind } : {}),
      ...(threadId ? { threadId } : {}),
      ...(messageId ? { messageId } : {}),
    });
  };
}

/** The chip text for a picked party. */
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
export function partyNoCandidateNote(
  outcome: PartyFindReply['outcome'],
  kind?: StaffQuoteParty['kind'],
  name = '',
): string {
  if (outcome === 'no_match') {
    const type = kind ? partyKindLabel(kind).toLowerCase() : 'company or agency';
    return `No ${type} in HMS matches “${name}”. Check the spelling or search a shorter name.`;
  }
  if (outcome === 'refused_lock_busy') return 'HMS is busy with another lookup. Nava will retry.';
  if (outcome === 'refused_flag_off') return 'Company and agency rates are switched off.';
  if (outcome === 'refused_input_invalid') return 'Type a company or agency name.';
  if (outcome === 'refused_origin_mismatch') {
    return 'This email is Da Vinci mail. Centurion HMS will not look it up.';
  }
  if (outcome === 'external_system_unavailable') {
    return "Nava couldn't check HMS for this name. Try again, or quote at public rates.";
  }
  return "Couldn't reach HMS. Try again in a minute.";
}

/** Shown when HMS matched the name, but none of the kind the field holds. */
export function partyNoKindNote(kind: StaffQuoteParty['kind']): string {
  return `No ${partyKindLabel(kind).toLowerCase()} match in HMS for this name.`;
}

/**
 * A suggestion for the picker, from the sender's domain or a name the body states. It carries no HMS id: it is a name to
 * search in HMS and never a pick.
 */
export type PartySuggestion = {
  source: 'sender' | 'body';
  kind: StaffQuoteParty['kind'];
  name: string;
  nativeId: null;
  idStatus: 'unverified';
};

export type PartySuggestReply = { suggestions: PartySuggestion[] };

export type PartySuggester = (input: {
  sender: string;
  body: string;
}) => Promise<PartySuggestReply>;

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
