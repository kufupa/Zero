import { createHash } from 'node:crypto';
import type { RateContext } from './hms-availability.js';
import type { HmsCloudAvailabilityResult } from './hms-cloud-availability-reader.js';
import type { PaneRateHistory } from './pane-rate-recommendation.js';
import {exactMinor,occupiedDates,type Board,type NativeOption,type QuoteSourceRecord,type RoomRequest} from '../quote-proposal/quote-revision.js';
import {getProfileBoards,profileFor} from '../../tooling/playwright-quote/property-profile.mjs';

export const boards:Record<string,Board>={'ro':'room_only','room_only':'room_only','room only':'room_only','room only r':'room_only','bb':'breakfast','b&b':'breakfast','breakfast':'breakfast','bed & breakfast':'breakfast','bed and breakfast':'breakfast','bed & breakfast r':'breakfast','dbb':'dinner_bed_breakfast','dinner_bed_breakfast':'dinner_bed_breakfast','breakfast and dinner':'dinner_bed_breakfast','breakfast & dinner':'dinner_bed_breakfast','dinner and breakfast':'dinner_bed_breakfast','dinner & breakfast':'dinner_bed_breakfast','dinner, bed & breakfast':'dinner_bed_breakfast','dinner, bed and breakfast':'dinner_bed_breakfast','dinner bed & breakfast':'dinner_bed_breakfast','dinner bed & breakfast r':'dinner_bed_breakfast','dinner, bed & breakfast r':'dinner_bed_breakfast','dinner, bed, breakfast & beverage r':'dinner_bed_breakfast'};
export const norm=(s:string)=>s.toLowerCase().replace(/\s+/g,' ').trim();

const BOARD_CACHE=new Map<string,Record<string,Board>>();

/** Static board aliases plus this property's profile map. Unknown property keeps the static map (fail closed). */
export function boardsFor(propertyCode?:string):Record<string,Board>{
 const key=typeof propertyCode==='string'?propertyCode:'';
 const hit=BOARD_CACHE.get(key);
 if(hit)return hit;
 const merged={...boards};
 if(key&&profileFor(key)){
  try{
   for(const [label,base] of Object.entries(getProfileBoards(key))) merged[norm(label)]=base;
  }catch{/* keep static aliases */}
 }
 BOARD_CACHE.set(key,merged);
 return merged;
}

/**
 * One priced option a staff quote shows per room group. `contract` is HMS's negotiated flag (rateScope 'contextual'), never the
 * rate name. `matchesRequest` is the requested board, room and any pinned rate code. `priced` is 'full' only for the quoted option.
 */
export type RateOption = {
  id: string;
  groupId: string;
  board: 'room_only' | 'bb' | 'dinner_bb';
  boardLabel: string;
  rateCode: string;
  rateLabel: string;
  roomCode: string;
  roomLabel: string;
  contract: boolean;
  onlyContract: boolean;
  matchesRequest: boolean;
  perNightMinor: number;
  /** Minimum per-night HMS inventory, for display only. */
  roomsLeft?: number;
  totalMinor: number;
  currency: string;
  priced: 'full' | 'summary';
  selected: boolean;
  /** A label for staff only. Ranking, matching and pricing never read it. */
  hint?: 'event_rate';
};

/** HMS event rates. GNC3B and GNC4B are shown with a hint; they are never matched, ranked or priced differently. */
const EVENT_RATE_CODES = new Set(['GNC3B', 'GNC4B']);
const staffBoard:Record<Board,RateOption['board']>={room_only:'room_only',breakfast:'bb',dinner_bed_breakfast:'dinner_bb'};
const boardName:Record<RateOption['board'],string>={room_only:'room only',bb:'bed and breakfast',dinner_bb:'dinner, bed and breakfast'};

/** The row was read under the requested party: each requested kind resolves to the same HMS id, or the same code and name. */
export function partyRowMatches(rateContext:Record<string,unknown>|undefined,option:NativeOption):boolean{
 return Object.entries(rateContext??{}).every(([kind,wanted])=>{const got=(option.appliedContext as Record<string,{id?:string;code?:string;name?:string}>|undefined)?.[kind],ref=wanted as {nativeId?:string;code?:string;name?:string};return!!got&&(ref.nativeId?String(got.id)===String(ref.nativeId):(!ref.code||got.code===ref.code)&&(!ref.name||got.name===ref.name));});
}
/** The requested room, pinned rate code and board. */
export function requestMatches(request:RoomRequest,option:NativeOption,propertyCode?:string):boolean{
 const mapped=boardsFor(propertyCode)[norm(option.board??'')];
 return(!request.required?.roomCodes||request.required.roomCodes.includes(option.room.code))&&(!request.required?.rateCodes||request.required.rateCodes.includes(option.rate.code))&&(!request.required?.boardBases||request.required.boardBases.includes(mapped));
}
/** A row the quote can price: verified, available, held-free, every requested night covered and priced in the requested currency. */
export function sellable(source:QuoteSourceRecord,quantity:number,option:NativeOption):boolean{
 const dates=occupiedDates(source.request.arrivalDate,source.request.departureDate);
 const detailStatus=(option as NativeOption&{details?:{status?:string}}).details?.status;
 const boardMap=boardsFor(source.request.propertyCode);
 return detailStatus!=='not_read'&&detailStatus!=='partial'&&option.eligibility==='verified'&&option.availability==='available'&&option.held===false&&!!boardMap[norm(option.board??'')]&&partyRowMatches(source.request.rateContext,option)&&option.nightly.length===dates.length&&new Set(option.nightly.map(n=>n.date)).size===dates.length&&option.nightly.every(n=>dates.includes(n.date)&&Number.isSafeInteger(n.inventory)&&n.inventory>=quantity&&exactMinor(n.price.amount)>0&&n.price.currency===source.request.requestedCurrency);
}

/**
 * Every distinct sellable rate code per room group, from the same summary read the quote priced. Order: the requested
 * board and room first, contract before public, then cheapest. The cheapest is kept per (code, board, contract, matches),
 * so a cheaper room that was not requested can never push out the option that was quoted. `selected` is the option the
 * narrowed full read priced.
 */
export function buildRateOptions(source:QuoteSourceRecord,selected:readonly {groupId:string;optionId:string}[]):RateOption[]{
 const nights=occupiedDates(source.request.arrivalDate,source.request.departureDate).length;
 return source.request.rooms.flatMap(request=>{
  const cheapest=new Map<string,{option:NativeOption;matches:boolean;contract:boolean;board:RateOption['board'];perRoomMinor:number;totalMinor:number}>();
  const selectedId=selected.find(s=>s.groupId===request.id)?.optionId;
  for(const option of source.result.groups.find(g=>g.id===request.id)?.options??[]){
   const matches=requestMatches(request,option,source.request.propertyCode);
   // A matching row must be quote-ready ('match'); a non-matching row is only ever shown, never quoted, so 'alternative' is fine.
   if(option.matchStatus!=='match'&&!(option.matchStatus==='alternative'&&!matches))continue;
   if(!sellable(source,request.quantity,option))continue;
   const perRoomMinor=option.nightly.reduce((sum,n)=>sum+exactMinor(n.price.amount),0),totalMinor=perRoomMinor*request.quantity;
   if(!(totalMinor>0))continue;
   const mapped=boardsFor(source.request.propertyCode)[norm(option.board??'')];
   const contract=option.rateScope==='contextual',board=staffBoard[mapped],key=`${option.rate.code.toUpperCase()}|${board}|${contract}|${matches}`,held=cheapest.get(key);
   const optionSelected=option.id===selectedId,heldSelected=held?.option.id===selectedId;
   if(!held||optionSelected||(!heldSelected&&(totalMinor<held.totalMinor||(totalMinor===held.totalMinor&&option.id<held.option.id))))cheapest.set(key,{option,matches,contract,board,perRoomMinor,totalMinor});
  }
  const ranked=[...cheapest.values()].sort((a,b)=>Number(b.matches)-Number(a.matches)||Number(b.contract)-Number(a.contract)||a.totalMinor-b.totalMinor||a.option.id.localeCompare(b.option.id));
  // onlyContract is counted across every distinct rate code staff can see.
  const contracts=ranked.filter(r=>r.contract).length;
  return ranked.map(r=>{
   const isSelected=selected.some(s=>s.groupId===request.id&&s.optionId===r.option.id);
   const inventory=r.option.nightly.map(n=>n.inventory),roomsLeft=inventory.length>0&&inventory.every(n=>Number.isFinite(n)&&n>=0)?Math.min(...inventory):undefined;
   return{
    id:`${request.id}:${r.option.id}`,groupId:request.id,board:r.board,boardLabel:r.option.board??'',rateCode:r.option.rate.code,rateLabel:r.option.rate.label,
    roomCode:r.option.room.code,roomLabel:r.option.room.label,contract:r.contract,onlyContract:r.contract&&contracts===1,matchesRequest:r.matches,
    perNightMinor:Math.round(r.perRoomMinor/nights),...(roomsLeft===undefined?{}:{roomsLeft}),totalMinor:r.totalMinor,currency:source.request.requestedCurrency,priced:isSelected?'full':'summary',selected:isSelected,...(EVENT_RATE_CODES.has(r.option.rate.code)?{hint:'event_rate' as const}:{})};
  });
 });
}

/**
 * The note for each group quoted at public rates for the requested board, because the party's contract rate is on another
 * board only. The copy names that contract, so staff can pin it and re-run.
 */
export function otherBoardContractNotes(names:readonly string[],options:readonly RateOption[]):string[]{
 // ponytail: the note names the first other-board contract per group; the cards list every other contract.
 const party=names.join(' and ');
 return [...new Set(options.filter(o=>o.selected&&!o.contract).flatMap(quoted=>{const contract=options.find(o=>o.groupId===quoted.groupId&&o.contract&&!o.matchesRequest);return contract?[`${party}'s contract rate is ${contract.boardLabel} only (${contract.rateCode}). Quoted ${boardName[quoted.board]} at the public rate as asked. Pick the contract option to switch.`]:[];}))];
}

/** Canonical pricing digest; object insertion order and display names cannot change pricing identity. */
export function rateContextKey(context: RateContext): string {
  const ordered: Record<string, unknown> = Object.fromEntries(Object.keys(context).sort().map(key => [key, context[key as keyof RateContext]]));
  if (context.savedTarget) ordered.savedTarget = Object.fromEntries(Object.keys(context.savedTarget).sort().map(key =>
    [key, context.savedTarget![key as keyof NonNullable<RateContext['savedTarget']>]]));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/** Observation candidates are additive; the existing sellable-only RateOption remains unchanged. */
export type RateCandidate = {
  id: string; groupId: string;
  rateCode: string; rateLabel: string | null;
  roomCode: string; roomLabel: string | null;
  board: 'room_only' | 'bb' | 'dbb' | null; boardLabel: string | null;
  state: 'available' | 'unavailable' | 'restricted' | 'unchecked' | 'failed';
  reasons: string[]; contract: boolean | null; matchesRequest: boolean;
  minRoomsAvailable: number | null;
  coverage: { nightsExpected: number; nightsObserved: number; eligibilityVerified: boolean; nativePartyIdsMatched: boolean };
  price: {
    currency: string; averagePerNightMinor: number | null; totalMinor: number | null;
    totalBasis: 'native' | 'nightly_sum'; taxMinor: number | null; feesMinor: number | null;
    nightly: Array<{ date: string; amountMinor: number }>; priced: 'full' | 'summary';
  } | null;
  observedAt: string | null; hint: 'event_rate' | null;
};

export type RateRecommendation = {
  rateCode: string | null;
  basis: 'explicit_request' | 'unchanged_hms' | 'bound_party_history' | 'email_frequency' | 'full_frequency' | 'none';
  explanation: string; evidenceCount: number; historyDigest: string | null; historyAsOf: string | null;
  validation: 'verified_for_context' | 'needs_native_check' | 'none';
};

// Distinct confirmation reads in the 2026-10-29 HRCEN snapshot, E-Mail cohort (492 reads).
// These are ranking hints, not native labels, availability, or contract entitlement.
const EMAIL_RATE_COUNTS: Readonly<Record<string, number>> = {
  NGOVDB: 204, NCOR1B: 95, NGOVB: 63, NCOR2B: 52, BAR: 45,
};
export function orderRateCandidates(context: RateContext, options: readonly RateCandidate[], history?: PaneRateHistory): RateCandidate[] {
  const counts = history && Object.keys(history.email).length ? history.email : history && Object.keys(history.full).length
    ? history.full : context.propertyCode === 'HRCEN' ? EMAIL_RATE_COUNTS : {};
  return [...options].sort((a, b) => {
    const frequency = (counts[b.rateCode] ?? 0) - (counts[a.rateCode] ?? 0);
    return frequency || a.rateCode.localeCompare(b.rateCode) || a.id.localeCompare(b.id);
  });
}

/** Recommendations are advisory: callers never replace a staff choice with this value. */
export function recommendRateCandidate(context: RateContext, options: readonly RateCandidate[], unchangedRate: string | null = null, history?: PaneRateHistory): RateRecommendation | null {
  const code = context.typedRatePlan ?? (context.workflow === 'amend' ? unchangedRate : null);
  const basis = context.typedRatePlan ? 'explicit_request' : code ? 'unchanged_hms' : null;
  if (code && basis) {
    const verified = options.some(option => option.rateCode === code && option.state === 'available' && option.coverage.eligibilityVerified);
    return { rateCode: code, basis, explanation: basis === 'unchanged_hms' ? 'Keep the current HMS rate.' : 'Requested rate.',
      evidenceCount: 0, historyDigest: null, historyAsOf: null,
      validation: verified ? 'verified_for_context' : 'needs_native_check' };
  }
  if (context.workflow === 'amend' || context.propertyCode !== 'HRCEN') return null;
  const usable = options.filter(option => option.matchesRequest && !['unavailable', 'restricted', 'failed'].includes(option.state));
  const bound = usable.filter(option => history?.boundParty[option.rateCode]).sort((a, b) =>
    (history!.boundParty[b.rateCode] ?? 0) - (history!.boundParty[a.rateCode] ?? 0) || a.rateCode.localeCompare(b.rateCode))[0];
  if (bound) return { rateCode: bound.rateCode, basis: 'bound_party_history',
    explanation: 'Used in prepared quotes with the same verified company and agency; check this stay in HMS.',
    evidenceCount: history!.boundParty[bound.rateCode]!, historyDigest: null, historyAsOf: null,
    validation: bound.state === 'available' && bound.coverage.eligibilityVerified ? 'verified_for_context' : 'needs_native_check' };
  const email = history?.digest ? history.email : EMAIL_RATE_COUNTS;
  let counts: Readonly<Record<string, number>> = email;
  let frequencyBasis: 'email_frequency' | 'full_frequency' = 'email_frequency';
  let candidate = orderRateCandidates(context, usable, history).find(option => email[option.rateCode] &&
    option.matchesRequest && !['unavailable', 'restricted', 'failed'].includes(option.state));
  if (!candidate && history) {
    counts = history.full; frequencyBasis = 'full_frequency';
    candidate = [...usable].sort((a, b) => (counts[b.rateCode] ?? 0) - (counts[a.rateCode] ?? 0))
      .find(option => counts[option.rateCode]);
  }
  if (!candidate) return null;
  return { rateCode: candidate.rateCode, basis: frequencyBasis, explanation: frequencyBasis === 'email_frequency'
    ? 'Often used for email bookings; check this stay in HMS.' : 'Often used across booking sources; check this stay in HMS.',
    evidenceCount: counts[candidate.rateCode]!, historyDigest: history?.digest ?? null, historyAsOf: history?.asOf ?? '2026-10-29',
    validation: candidate.state === 'available' && candidate.coverage.eligibilityVerified ? 'verified_for_context' : 'needs_native_check' };
}

type CloudGroup = Extract<HmsCloudAvailabilityResult, { outcome: 'read' }>['groups'][number];

/** Exact cents only: unsupported precision/currency never becomes a rounded claimed price. */
function candidateMinor(amount: string | null): number | null {
  if (amount === null || !/^\d{1,15}(?:\.\d{1,2})?$/.test(amount)) return null;
  const [units, fraction = ''] = amount.split('.');
  try { return exactMinor(`${units}.${fraction.padEnd(2, '0')}`); } catch { return null; }
}

/** Cloud Hotel Availability proves observations, not stay eligibility, entitlement or an official total. */
export function buildCloudRateCandidates(context: RateContext, groups: readonly CloudGroup[]): RateCandidate[] {
  const dates = occupiedDates(context.arrival, context.departure);
  return groups.flatMap(group => {
    const candidates: RateCandidate[] = group.options.flatMap(option => {
      const rateCode = option.ratePlan.code, roomCode = option.room.code;
      if (!rateCode || roomCode !== context.roomCode || (context.typedRatePlan && rateCode !== context.typedRatePlan)) return [];
      const nightly = option.nightly.filter(night => dates.includes(night.date));
      const complete = nightly.length === dates.length && new Set(nightly.map(night => night.date)).size === dates.length;
      const reasons = [...new Set([...option.reasons, ...nightly.flatMap(night => night.reasons)])];
      const counts = nightly.map(night => night.availableCount);
      const minRoomsAvailable = complete && counts.every((count): count is number => count !== null) ? Math.min(...counts) : null;
      const restricted = nightly.some(night => !night.reasons.includes('unknown') &&
        (night.stockStatus === 'restricted' || night.reasons.includes('closed_or_restricted')));
      const shortfall = nightly.some(night => !night.reasons.includes('unknown') &&
        (night.reasons.includes('negative_stock') || (!night.reasons.includes('conditions_present') &&
          night.availableCount !== null && night.availableCount < context.quantity)));
      const state: RateCandidate['state'] = restricted ? 'restricted' : shortfall ? 'unavailable' : 'unchecked';
      if (!complete) reasons.push('NIGHT_COVERAGE_INCOMPLETE');
      if (state === 'unchecked') reasons.push('NATIVE_STAY_ELIGIBILITY_UNVERIFIED');
      const pricedNights = nightly.flatMap(night => {
        const amountMinor = !night.reasons.includes('unknown') && night.price.status === 'known' &&
          night.price.currency === context.currency ? candidateMinor(night.price.amount) : null;
        return amountMinor === null ? [] : [{ date: night.date, amountMinor }];
      });
      const sum = pricedNights.reduce((total, night) => total + BigInt(night.amountMinor), 0n);
      const boardLabel = option.boardLabel;
      const nativeBoard = boardLabel ? boardsFor(context.propertyCode)[norm(boardLabel)] : undefined;
      const board: RateCandidate['board'] = nativeBoard === 'breakfast' ? 'bb' : nativeBoard === 'dinner_bed_breakfast' ? 'dbb' : nativeBoard === 'room_only' ? 'room_only' : null;
      const candidate: RateCandidate = {
        id: JSON.stringify([group.id, roomCode, rateCode, option.promotionCode]), groupId: group.id,
        rateCode, rateLabel: option.ratePlan.label, roomCode, roomLabel: option.room.label,
        board, boardLabel, state, reasons, contract: null,
        matchesRequest: (!context.typedRatePlan || context.typedRatePlan === rateCode) && (!context.board || context.board === board),
        minRoomsAvailable,
        coverage: { nightsExpected: dates.length, nightsObserved: new Set(nightly.map(night => night.date)).size,
          eligibilityVerified: false, nativePartyIdsMatched: group.outcome === 'observed' },
        price: pricedNights.length ? {
          currency: context.currency,
          averagePerNightMinor: complete && pricedNights.length === dates.length && sum <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Math.round(Number(sum) / dates.length) : null,
          // Cloud values have unknown quantity/price basis. Do not multiply them into a claimed stay total.
          totalMinor: null, totalBasis: 'nightly_sum', taxMinor: null, feesMinor: null, nightly: pricedNights, priced: 'summary',
        } : null,
        observedAt: group.observedAt, hint: EVENT_RATE_CODES.has(rateCode) ? 'event_rate' : null,
      };
      return [candidate];
    });
    // A missing typed code is unchecked even after a complete catalogue read, never unavailable.
    if (context.typedRatePlan && !candidates.some(candidate => candidate.rateCode === context.typedRatePlan)) {
      candidates.push({
        id: JSON.stringify([group.id, context.roomCode, context.typedRatePlan, null]), groupId: group.id,
        rateCode: context.typedRatePlan, rateLabel: null, roomCode: context.roomCode, roomLabel: null,
        board: null, boardLabel: null, state: 'unchecked', reasons: ['NATIVE_RATE_ROW_NOT_OBSERVED'], contract: null,
        matchesRequest: true, minRoomsAvailable: null,
        coverage: { nightsExpected: dates.length, nightsObserved: 0, eligibilityVerified: false,
          nativePartyIdsMatched: group.outcome === 'observed' },
        price: null, observedAt: group.observedAt, hint: EVENT_RATE_CODES.has(context.typedRatePlan) ? 'event_rate' : null,
      });
    }
    return candidates;
  });
}
