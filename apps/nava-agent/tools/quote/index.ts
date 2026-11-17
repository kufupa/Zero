import { quoteInput, quoteSchema, type QuoteInput } from './schema.js';
import { quoteDisplayRows, zeroNativeQuotePrice, type DisplayRow } from './display.js';

export type ToolContext = {sessionId:string; mode:'live'|'labtest'|'historical'; signal?:AbortSignal; credentialLease?:unknown};
export type ToolResult = {ok:boolean; data:unknown; error:{code:string;message:string;retryable:boolean;outcome:'known'|'uncertain'}|null};
type Identity = {group_id:string;room_id:string;native_id:string};
type Batch = {arrival_date:string;departure_date:string;identities:Identity[];rooms:QuoteInput['groups'][number]['rooms']};
type GroupResult = {group_id:string;arrival_date:string;departure_date:string;status:string;search_index:number|null;rooms:{room_id:string;native_group_index:number|null;native_result:unknown}[]};
type SearchResult = {property_code:string;arrival_date:string;departure_date:string;identities:Identity[];native_result:unknown};
const fail = (code:string,message:string,data:unknown=null,retryable=false):ToolResult => ({ok:false,data,error:{code,message,retryable,outcome:'known'}});
const record = (value:unknown):Record<string,unknown> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const array = (value:unknown):unknown[] => Array.isArray(value) ? value : [];
const validDate = (value:string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;

export async function quote(input:unknown, context:ToolContext):Promise<ToolResult> {
  if(context.mode==='historical') return fail('HISTORICAL_HMS_UNAVAILABLE','Historical sessions cannot access live HMS.');
  if(context.signal?.aborted) return fail('ABORTED','Quote was cancelled.');
  const configuredCap=process.env.HMS_CREDENTIAL_SESSION_CAP;
  if(configuredCap!==undefined && (!/^[1-8]$/.test(configuredCap))) return fail('HMS_SESSION_CAP_INVALID','Native shared read cap must be an integer from 1 to 8.');
  const parsed=quoteInput.safeParse(input);
  if(!parsed.success) return fail('INVALID_INPUT','Invalid quote request.');
  const request=parsed.data, seen=new Set<string>();
  for(const group of request.groups) {
    if(seen.has(group.group_id)) return fail('DUPLICATE_GROUP_ID','Group IDs must be unique within a quote.');
    seen.add(group.group_id);
    if(!validDate(group.arrival_date)||!validDate(group.departure_date)||group.departure_date<=group.arrival_date) return fail('INVALID_DATES','Each group needs valid arrival and later departure dates.');
    if(new Set(group.rooms.map(room=>room.id)).size!==group.rooms.length) return fail('DUPLICATE_ROOM_ID','Room IDs must be unique within each group.');
  }
  const groups:Record<string,GroupResult>=Object.create(null);
  const batches:Batch[]=[];
  for(const group of request.groups) {
    groups[group.group_id]={group_id:group.group_id,arrival_date:group.arrival_date,departure_date:group.departure_date,status:'pending',search_index:null,rooms:group.rooms.map(room=>({room_id:room.id,native_group_index:null,native_result:null}))};
    let batch=batches.find(item=>item.arrival_date===group.arrival_date && item.departure_date===group.departure_date);
    if(!batch) {batch={arrival_date:group.arrival_date,departure_date:group.departure_date,identities:[],rooms:[]};batches.push(batch);}
    for(const room of group.rooms) {
      batch.identities.push({group_id:group.group_id,room_id:room.id,native_id:`room-${batch.identities.length+1}`});
      batch.rooms.push(room);
    }
  }
  const searches:SearchResult[]=[], display_rows:DisplayRow[]=[];
  const data={quote_order:[request.quote_id],quotes:{[request.quote_id]:{quote_id:request.quote_id,property_code:request.property_code,group_order:request.groups.map(group=>group.group_id),groups,joint_allocation:batches.length===1?'native_search':'unverified_across_searches'}},searches,display_rows};
  let failure:ToolResult['error']=null;
  for(const batch of batches) {
    if(context.signal?.aborted) {failure={code:'ABORTED',message:'Quote was cancelled; retained captures are incomplete.',retryable:false,outcome:'known'};break;}
    if(batch.rooms.length>8) {
      for(const identity of batch.identities) groups[identity.group_id].status='unsupported_group_limit';
      failure ??= {code:'NATIVE_GROUP_LIMIT',message:'More than eight room occupancies share one search; joint allocation cannot be verified.',retryable:false,outcome:'known'};
      continue;
    }
    const searchIndex=searches.length;
    try {
      const {fetchQuote}=await import('./native/tooling/hms-cloud/fetch-quote.mjs');
      const native=await fetchQuote({propertyCode:request.property_code,signal:context.signal,credentialLease:context.credentialLease,request:{schemaVersion:2,propertyCode:request.property_code,arrivalDate:batch.arrival_date,departureDate:batch.departure_date,
        rooms:batch.rooms.map((room,index)=>({id:batch.identities[index].native_id,quantity:room.quantity,adults:room.adults,children:room.children,childAges:room.child_ages,...(room.required?{required:room.required}:{}),...(room.preferred?{preferred:room.preferred}:{})})),
        search:{includeRestricted:request.search?.include_restricted ?? false,includeAlternatives:request.search?.include_alternatives ?? true,...(request.search?.sales_strategy?{salesStrategy:request.search.sales_strategy}:{})},
        ...(request.details?{details:request.details}:{}),...(request.max_options_per_group?{maxOptionsPerGroup:request.max_options_per_group}:{})}});
      searches.push({property_code:request.property_code,arrival_date:batch.arrival_date,departure_date:batch.departure_date,identities:batch.identities,native_result:native});
      const nativeGroups=array(native.groups);
      const displayIdentities=nativeGroups.map(value=>batch.identities.find(identity=>identity.native_id===record(value).id));
      const complete=['quote','no_match','unavailable'].includes(native.outcome) && native.audit?.status==='complete';
      for(const identity of batch.identities) {
        const group=groups[identity.group_id], room=group.rooms.find(item=>item.room_id===identity.room_id);
        const nativeIndex=nativeGroups.findIndex(item=>record(item).id===identity.native_id);
        group.search_index=searchIndex;
        if(room && nativeIndex>=0) {room.native_group_index=nativeIndex;room.native_result=nativeGroups[nativeIndex];}
        group.status=complete && nativeIndex>=0 ? 'complete' : 'incomplete';
      }
      // A missing occupancy makes the whole group incomplete even if later rooms were found.
      for(const identity of batch.identities) {
        const group=groups[identity.group_id];
        if(group.rooms.some(room=>room.native_result===null)) group.status='incomplete';
      }
      display_rows.push(...quoteDisplayRows(native,searchIndex,request.quote_id,displayIdentities));
      if(context.signal?.aborted) {failure={code:'ABORTED',message:'Quote was cancelled; retained captures are incomplete.',retryable:false,outcome:'known'};break;}
      if(!complete || displayIdentities.some(identity=>!identity) || batch.identities.some(identity=>groups[identity.group_id].status!=='complete')) failure ??= {code:'NATIVE_INCOMPLETE',message:'Native quote incomplete; inspect retained captures and group status.',retryable:native.outcome==='execution_failure',outcome:'known'};
    } catch {
      for(const identity of batch.identities) groups[identity.group_id].status=context.signal?.aborted?'aborted':'search_failed';
      failure ??= {code:context.signal?.aborted?'ABORTED':'NATIVE_FAILURE',message:context.signal?.aborted?'Quote was cancelled; retained captures are incomplete.':'Native quote failed before a complete capture.',retryable:!context.signal?.aborted,outcome:'known'};
      if(context.signal?.aborted) break;
    }
  }
  return failure ? {ok:false,data,error:failure} : {ok:true,data,error:null};
}

/** Return only quote facts the model needs; persist the original result independently before using this view. */
export function quoteModelView(result:ToolResult):ToolResult {
  const bounded=(value:unknown)=>typeof value==='string'?value.slice(0,160):null;
  const data=record(result.data);
  const quotes=Object.entries(record(data.quotes)).map(([quoteId,value])=>{
    const quote=record(value);
    return {quote_id:quoteId,property_code:quote.property_code,groups:Object.values(record(quote.groups)).map(value=>{
      const group=record(value);
      return {group_id:group.group_id,arrival_date:group.arrival_date,departure_date:group.departure_date,status:group.status,
        rooms:array(group.rooms).map(value=>{
          const room=record(value), native=record(room.native_result), options=array(native.options);
          return {room_id:room.room_id,outcome:native.outcome,option_count:options.length,options:options.slice(0,4).map(value=>{
            const option=record(value), room=record(option.room), rate=record(option.rate), meal=record(option.mealPlan);
            return {room:{code:bounded(room.code),meaning:bounded(room.label)},rate:{code:bounded(rate.code),meaning:bounded(rate.label)},
              meal:bounded(meal.label??meal.code??option.mealPlan),availability:option.availability,eligibility:option.eligibility,
              match:option.matchStatus,nightly:array(option.nightly).slice(0,30).map(value=>{
                const night=record(value), price=record(night.price);
                const amount=typeof price.amount==='string'?price.amount:null;
                const zero=zeroNativeQuotePrice(amount);
                return [night.date,zero?null:amount,price.currency,night.inventory,night.restricted,zero?'staff_review_zero':amount===null?'unavailable':'observed'];
              })};
          })};
        })};
    })};
  });
  return {...result,data:{quotes,nightly_fields:['date','amount','currency','inventory','restricted','price_status']}};
}

export const tools = [{name:'hms_quote',description:'Read native availability and nightly prices for one quote and its ordered date groups; does not book.',input_schema:quoteSchema,run:quote}];
