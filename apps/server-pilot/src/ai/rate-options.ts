import {exactMinor,occupiedDates,type Board,type NativeOption,type QuoteSourceRecord,type RoomRequest} from '../quote-proposal/quote-revision.js';
import {getProfileBoards,profileFor} from '../../tooling/playwright-quote/property-profile.mjs';

export const boards:Record<string,Board>={'ro':'room_only','room_only':'room_only','room only':'room_only','room only r':'room_only','bb':'breakfast','b&b':'breakfast','breakfast':'breakfast','bed & breakfast':'breakfast','bed and breakfast':'breakfast','bed & breakfast r':'breakfast','dbb':'dinner_bed_breakfast','dinner_bed_breakfast':'dinner_bed_breakfast','breakfast and dinner':'dinner_bed_breakfast','breakfast & dinner':'dinner_bed_breakfast','dinner and breakfast':'dinner_bed_breakfast','dinner & breakfast':'dinner_bed_breakfast','dinner, bed & breakfast':'dinner_bed_breakfast','dinner, bed and breakfast':'dinner_bed_breakfast','dinner bed & breakfast':'dinner_bed_breakfast','dinner bed and breakfast':'dinner_bed_breakfast','dinner bed & breakfast r':'dinner_bed_breakfast','dinner, bed & breakfast r':'dinner_bed_breakfast','dinner, bed, breakfast & beverage r':'dinner_bed_breakfast'};
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
