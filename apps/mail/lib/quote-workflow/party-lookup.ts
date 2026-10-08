import type { StaffQuoteParty } from './types';

/** One HMS company or agency that the Find in HMS lookup found. The nativeId is HMS's own id. */
export type PartyCandidate = {
  nativeId: string;
  displayName: string;
  kind: StaffQuoteParty['kind'];
};

/** panePartyLookup.findParty's reply. Refusals and failures carry no candidates. */
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
  candidates: PartyCandidate[];
};

export type PartyFinder = (kind: StaffQuoteParty['kind'], name: string) => Promise<PartyFindReply>;

type TrpcPanePartyRoutes = {
  panePartyLookup?: {
    findParty?: {
      mutate: (input: { kind: StaffQuoteParty['kind']; name: string }) => Promise<PartyFindReply>;
    };
  };
};

/** Binds panePartyLookup.findParty off a tRPC client. Null when the route is missing. */
export function partyFinderFromTrpc(trpc: unknown): PartyFinder | null {
  if (!trpc || typeof trpc !== 'object') return null;
  const find = (trpc as TrpcPanePartyRoutes).panePartyLookup?.findParty;
  if (!find) return null;
  return (kind, name) => find.mutate({ kind, name });
}

/** The chip that replaces the Find in HMS button once staff pick a candidate. */
export function partyChipText(party: StaffQuoteParty): string {
  return `✓ ${party.name} (HMS)`;
}

/** What the picker says when a lookup gives no candidate to pick. The quote still runs, at public rates. */
export function partyNoCandidateNote(outcome: PartyFindReply['outcome']): string {
  if (outcome === 'no_match')
    return 'HMS has no company or agency by that name. Check the spelling.';
  if (outcome === 'refused_lock_busy')
    return 'HMS is busy with another run. Try again in a minute.';
  if (outcome === 'refused_flag_off')
    return 'HMS rate lookup is turned off, so this quote uses public rates.';
  return "Luna couldn't check HMS for this name. Try again, or quote at public rates.";
}
