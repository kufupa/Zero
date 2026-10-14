import { occupiedDates, quoteDigest, type QuoteRevision } from './quote-revision.js';
export type QuoteDisplayLine = { nights:number;rateMinor:number;totalMinor:number;arrivalDate:string;departureDate:string;sourceRef:string;sourceHash:string;groupId:string;description:string;quantity:number };
const meals = {room_only:'Room Only', breakfast:'Bed & Breakfast', dinner_bed_breakfast:'Dinner Bed & Breakfast'};
/**
 * A row staff priced instead of HMS's nightly rate (KTD6). Saved and override rows keep the name, code and note as they were
 * approved, so a later edit or archive never changes an old quote. The price applies to every night of its row.
 */
export type RowPrice =
 | { groupId:string; source:'saved'; customRateId:string; name:string; amountMinor:number }
 | { groupId:string; source:'one_off'; amountMinor:number }
 | { groupId:string; source:'override'; rateCode:string; amountMinor:number; note:string };
/** Accept only a resolved immutable selected revision; never derive prices from agent integers. Row prices replace only their own row's nights. */
export function deriveQuoteLines(revision: QuoteRevision, rowPrices: readonly RowPrice[] = []): QuoteDisplayLine[] {
 const raw = revision as QuoteRevision & Record<string,unknown>;
 if ('extras' in raw || 'overrides' in raw || 'imported' in raw) throw new Error('unsupported_revision_facts');
 const {id,...data}=revision;
 if(id!==`quote:${quoteDigest(data)}`)throw new Error('revision_identity');
 const priceByGroup=new Map<string,RowPrice>();
 for(const price of rowPrices){
  if(!revision.groups.some(group=>group.id===price.groupId)||priceByGroup.has(price.groupId))throw new Error('row_price_scope');
  priceByGroup.set(price.groupId,price);
 }
 const lines:QuoteDisplayLine[]=[];
 // The HMS total with each priced row moved to its price. Equal to revision.totalMinor when no row is priced.
 let expectedTotal=revision.totalMinor;
 for(const group of revision.groups){
  const dates=occupiedDates(group.arrivalDate,group.departureDate);
  if(dates.length!==group.nightly.length||dates.some((date,i)=>date!==group.nightly[i].date))throw new Error('night_coverage');
  if(!group.sourceRef||!/^[a-f0-9]{64}$/.test(group.sourceHash)||!group.inclusions.policyRef||!meals[group.board])throw new Error('missing_provenance');
  const label=group.roomCode==='SKNG'?'Standard King':group.roomCode==='EXKNG'?'Executive':group.roomLabel;
  if(!label.trim())throw new Error('missing_room_label');
  const occupancy=`${group.adults} adult${group.adults===1?'':'s'}${group.children?` + ${group.children} child${group.children===1?'':'ren'} (ages ${group.childAges.join(', ')})`:''} per room`;
  const price=priceByGroup.get(group.id);
  const nightly=price?group.nightly.map(night=>({...night,amountMinor:price.amountMinor})):group.nightly;
  let sum=0;
  for(let i=0;i<nightly.length;){
   const start=i,rateMinor=nightly[i].amountMinor;
   if(!Number.isSafeInteger(rateMinor)||rateMinor<=0)throw new Error('invalid_money');
   do{i++;}while(i<nightly.length&&nightly[i].amountMinor===rateMinor);
   const nights=i-start,totalMinor=rateMinor*nights*group.quantity;
   if(!Number.isSafeInteger(totalMinor)||totalMinor<=0)throw new Error('money_overflow');
   sum+=totalMinor;
   lines.push({nights,rateMinor,totalMinor,quantity:group.quantity,arrivalDate:dates[start],departureDate:i===dates.length?group.departureDate:dates[i],sourceRef:group.sourceRef,sourceHash:group.sourceHash,groupId:group.id,description:`${label} · ${occupancy} · ${meals[group.board]}`});
  }
  const groupTotal=price?price.amountMinor*dates.length*group.quantity:group.totalMinor;
  const perRoomMinor=price?price.amountMinor*dates.length:group.perRoomMinor;
  if(sum!==groupTotal||sum/group.quantity!==perRoomMinor)throw new Error('group_total_mismatch');
  expectedTotal+=groupTotal-group.totalMinor;
 }
 const total=lines.reduce((n,l)=>n+l.totalMinor,0);
 if(!Number.isSafeInteger(total)||total!==expectedTotal)throw new Error('proposal_total_mismatch');
 return lines;
}
/** Room lines at their final prices, before authorised extras. Equal to revision.totalMinor when no row is priced. */
export function pricedRoomTotal(revision: QuoteRevision, rowPrices: readonly RowPrice[] = []): number {
 return deriveQuoteLines(revision, rowPrices).reduce((n,l)=>n+l.totalMinor,0);
}
/** What the pane shows per row: HMS's nightly rates, the nightly rates charged, and for an override its internal copy line. */
export type RowRate = {
 groupId:string;source:'hms'|RowPrice['source'];hmsNightlyMinor:number[];nightlyMinor:number[];
 customRateName?:string;rateCode?:string;note?:string;hmsComment?:string;
};
export function rowRatesFor(revision: QuoteRevision, rowPrices: readonly RowPrice[] = []): RowRate[] {
 return revision.groups.map((group):RowRate=>{
  const hmsNightlyMinor=group.nightly.map(night=>night.amountMinor);
  const price=rowPrices.find(row=>row.groupId===group.id);
  if(!price)return {groupId:group.id,source:'hms',hmsNightlyMinor,nightlyMinor:hmsNightlyMinor};
  const base={groupId:group.id,source:price.source,hmsNightlyMinor,nightlyMinor:group.nightly.map(()=>price.amountMinor)};
  if(price.source==='saved')return {...base,customRateName:price.name};
  if(price.source==='override')return {...base,rateCode:price.rateCode,note:price.note,hmsComment:`Rate override ${price.rateCode} R${(price.amountMinor/100).toFixed(2)} per night: ${price.note}`};
  return base;
 });
}
export type AuthorizedProposalFacts = {
 revisionId:string;authorizationId:string;sourceRef:string;sourceHash:string;
 extras:Array<{id:string;label:string;quantity:number;units:number;unitKind:'person_service'|'item'|'trip';unitMinor:number;service:string;persons:Array<{id:string;age:number}>;dates:string[];chargeUnit?:'per_person_night'|'per_person'|'per_room_per_night'|'per_trip'|'item';daysExplicit?:boolean;groupIds?:string[]}>;
 includedEntitlements:Array<{sourceRef:string;sourceHash:string;service:string;personIds:string[];dates:string[]}>;
};
/** quantity x nights x rateMinor = totalMinor. Person services: quantity is guests and nights is nights or days. Trips and items: nights is the trip or item count. */
export type ExtraDisplayLine = {id:string;service:string;description:string;quantity:number;nights:number;units:number;unitKind:string;chargeUnit?:'per_person_night'|'per_person'|'per_room_per_night'|'per_trip'|'item';rateMinor:number;totalMinor:number;sourceRef:string;sourceHash:string;dates:string[]};
const DINNER_ADD_ON_UNIT_LABELS:Partial<Record<NonNullable<AuthorizedProposalFacts['extras'][number]['chargeUnit']>,string>>={
 per_person_night:'per person per night',
 per_person:'per person',
 per_room_per_night:'per room per night',
};
/** Include the charging basis in customer-facing document descriptions; the generic columns alone are ambiguous. */
export function extraDisplayDescription(line:ExtraDisplayLine):string{
 const unit=line.service==='dinner_add_on'&&line.chargeUnit?DINNER_ADD_ON_UNIT_LABELS[line.chargeUnit]:undefined;
 return unit?`${line.description} (${unit})`:line.description;
}
/** Facts must be resolved from authorized document/policy storage; callers cannot supply model text as authority. */
export function deriveAuthorizedExtraLines(revision:QuoteRevision,facts:AuthorizedProposalFacts):ExtraDisplayLine[]{
 deriveQuoteLines(revision);
 if(facts.revisionId!==revision.id||facts.authorizationId!==revision.authorizationId)throw new Error('extra_scope');
 const validSource=(ref:string,hash:string)=>Boolean(ref)&&/^[a-f0-9]{64}$/.test(hash);
 if(!validSource(facts.sourceRef,facts.sourceHash))throw new Error('extra_provenance');
 const seen=new Set<string>(),lines:ExtraDisplayLine[]=[];
 for(const entitlement of facts.includedEntitlements){if(!validSource(entitlement.sourceRef,entitlement.sourceHash))throw new Error('entitlement_provenance');}
 for(const extra of facts.extras){
  if(!extra.id||seen.has(extra.id)||!extra.label.trim()||!extra.service)throw new Error('extra_identity');seen.add(extra.id);
  if(extra.groupIds!==undefined&&(
   extra.service!=='dinner_add_on'||!extra.groupIds.length||new Set(extra.groupIds).size!==extra.groupIds.length||extra.groupIds.some(id=>!revision.groups.some(group=>group.id===id))
  ))throw new Error('extra_scope');
  if(!Number.isSafeInteger(extra.quantity)||extra.quantity<1||!Number.isSafeInteger(extra.units)||extra.units<1||!Number.isSafeInteger(extra.unitMinor)||extra.unitMinor<0)throw new Error('extra_money');
  if(!['person_service','item','trip'].includes(extra.unitKind))throw new Error('extra_units');
  for(const date of extra.dates)occupiedDates(date,new Date(Date.parse(`${date}T00:00:00Z`)+86400000).toISOString().slice(0,10));
  if(new Set(extra.dates).size!==extra.dates.length||new Set(extra.persons.map(p=>p.id)).size!==extra.persons.length||extra.persons.some(p=>!p.id||!Number.isInteger(p.age)||p.age<0))throw new Error('extra_person_date');
  let blocks:Array<{quantity:number;nights:number;dates:string[]}>;
  if(extra.unitKind==='person_service'){
   if(!extra.persons.length||!extra.dates.length||extra.units!==extra.persons.length*extra.dates.length||extra.quantity!==1)throw new Error('ambiguous_meal_units');
   // Guests charged for the same dates form one block, so every printed row reads as guests x nights.
   const byDates=new Map<string,{quantity:number;dates:string[]}>();
   for(const person of extra.persons){
    const dates=extra.dates.filter(date=>!facts.includedEntitlements.some(e=>e.service===extra.service&&e.personIds.includes(person.id)&&e.dates.includes(date)));
    if(!dates.length)continue;
    const key=dates.join('|'),row=byDates.get(key)??{quantity:0,dates};
    row.quantity++;byDates.set(key,row);
   }
   blocks=[...byDates.values()].map(row=>({quantity:row.quantity,nights:row.dates.length,dates:row.dates}));
  }else blocks=[{quantity:extra.quantity,nights:extra.units,dates:extra.dates}];
  blocks.forEach((block,index)=>{
   const totalMinor=block.quantity*block.nights*extra.unitMinor;if(!Number.isSafeInteger(totalMinor))throw new Error('money_overflow');
   lines.push({id:index?`${extra.id}-${index+1}`:extra.id,service:extra.service,description:extra.label,quantity:block.quantity,nights:block.nights,units:block.quantity*block.nights,unitKind:extra.unitKind,...(extra.chargeUnit?{chargeUnit:extra.chargeUnit}:{}),rateMinor:extra.unitMinor,totalMinor,sourceRef:facts.sourceRef,sourceHash:facts.sourceHash,dates:block.dates});
  });
 }
 return lines;
}
