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

/** Binds panePartyLookup.findParty off a tRPC client. Null when the route is missing. */
export function partyFinderFromTrpc(trpc: unknown): PartyFinder | null {
  if (!trpc || typeof trpc !== 'object') return null;
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
  if (outcome === 'refused_flag_off')
    return 'HMS rate lookup is turned off, so this quote uses public rates.';
  return "Luna couldn't check HMS for this name. Try again, or quote at public rates.";
}
