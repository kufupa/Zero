import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {extractReservationistPlan} from '../src/ai/reservationist-extraction.js';

const at='2026-10-05T08:00:00Z';
async function extract(text:string,facts:any[],when=at,mode:'combined'|'task_first'='combined',kind='quote',batched=false){
 const source=(quote:string)=>({attachmentId:'message:m',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote});
 const wireFacts=facts.map(({quote,...f})=>({...f,disclosure:'guest',source:source(quote??text)}));let calls=0;
 return extractReservationistPlan({mode,...(batched?{factEnrichmentMode:'source_batches',messageBatching:'per_source'} as const:{}),adapter:{reserveCalls:async()=>{},invoke:async()=>({output:mode==='task_first'?++calls===1?{facts:[],tasks:[{id:'q',kind,source:source('Please quote.'),factIds:[]}],unresolvedAsks:[]}:{facts:wireFacts,assignments:[{taskId:'q',factIds:facts.map(f=>f.id)}],unresolvedAsks:[]}:{facts:wireFacts,tasks:[{id:'q',kind,source:source('Please quote.'),factIds:facts.map(f=>f.id)}],unresolvedAsks:[]}})} as never,messages:[{id:'m',text,at:when,direction:'inbound'}],triggerMessageId:'m',causalAt:when,admissions:[],signal:new AbortController().signal});
}
const room=(quantity=1,adults=1)=>({id:'room',kind:'room',value:{roomRef:'1',quantity,adults,childAges:[]}});
const guest=(firstName:string,lastName:string)=>({id:firstName,kind:'guest',value:{firstName,lastName}});
it.each(['one bedroom for Mr. Alex Example','a room','Mr. Alex Example'])('uses the existing one adult/one room staff convention for %s',async allocation=>{
 const text=`Please quote.\nAccommodation for ${allocation}.`;
 const p=await extract(text,[room(),...(allocation.includes('Alex')?[guest('Alex','Example')]:[])]);
 expect(p.facts.find(f=>f.kind==='room')).toMatchObject({value:{quantity:1,adults:1,childAges:[]},convention:{rule:'centurion_staff_occupancy_v1',sourceAt:at}});
});
it.each(['two people','Mr. Alex Example and Mrs. Jamie Example'])('uses the existing two adults/one room staff convention for %s',async allocation=>{
 const text=`Please quote.\nAccommodation for ${allocation}.`;
 const p=await extract(text,[room(1,2),...(allocation.includes('Alex')?[guest('Alex','Example'),guest('Jamie','Example')]:[])]);
 expect(p.facts.find(f=>f.kind==='room')!.value).toMatchObject({quantity:1,adults:2,childAges:[]});
});
it('uses N named guests in explicitly N rooms without inventing per-room ordering',async()=>{
 const p=await extract('Please quote.\n2 rooms for Mr. Alex Example and Ms. Jamie Sample.',[room(2),guest('Alex','Example'),guest('Jamie','Sample')]);
 expect(p.facts.find(f=>f.kind==='room')!.value).toMatchObject({quantity:2,adults:1});
 expect(p.facts.filter(f=>f.kind==='guest').every(f=>f.value.roomIndex===undefined)).toBe(true);
});
it('uses explicit single occupancy in a counted multiroom quote',async()=>{
 const p=await extract('Please quote.\n2 single rooms (B&B).',[room(2)]);
 expect(p.facts[0].value).toMatchObject({quantity:2,adults:1});
});
it.each(['40 pax – quote single','12 people, single occupancy','8 persons - single rooms'])('uses the explicit per-person single allocation convention: %s',async quote=>{
 const quantity=Number(quote.match(/^\d+/)![0]);
 const text=`Please quote.\nGroups and Events desk\nVenue: 90 pax\nACCOMMODATION:\n${quote}\n\nAV AND DÉCOR:\nOther event details\nIf you no longer wish to receive these emails, unsubscribe.`;
 const p=await extract(text,[{...room(quantity),quote}]);
 expect(p.facts[0].value).toMatchObject({quantity,adults:1,childAges:[]});
});
it.each(['40 pax - single or double','40 students - single','40 pax - single with children','not 40 pax - single','40 pax - single and 42 pax - single'])('rejects ambiguous per-person single allocation: %s',async quote=>{
 await expect(extract(`Please quote.\nACCOMMODATION:\n${quote}`,[{...room(40),quote}])).rejects.toThrow('entailed');
});
it.each(['VENUE:','CONFERENCE:'])('does not turn event attendance into overnight rooms: %s',async heading=>{
 await expect(extract(`Please quote.\n${heading}\n90 pax - single`,[{...room(90),quote:'90 pax - single'}])).rejects.toThrow('entailed');
});
it('keeps both independently named adults in an explicitly single double room',async()=>{
 const p=await extract('Please quote.\n1 double room for Mr. Alex Example and Mrs. Jamie Example.',[room(1,2),guest('Alex','Example'),guest('Jamie','Example')]);
 expect(p.facts[0].value).toMatchObject({quantity:1,adults:2});
});
it('retains explicit adult honorific pair occupancy without inventing either given name',async()=>{
 const p=await extract('Please quote.\n1 double room for Mr and Mrs Sample.',[room(1,2)]);
 expect(p.facts[0].value).toMatchObject({quantity:1,adults:2});
 expect(p.facts.filter(f=>f.kind==='guest')).toEqual([]);
});
it('keeps unrelated signed footer restrictions outside the accommodation evidence scope',async()=>{
 const quote='1 Double room, including breakfast\nMr and Mrs Sample',dates='Check in: 16 October\nCheck out: 17 October';
 const text=`Please quote.\n${quote}\n${dates}\n\nThank you and kind regards\nAdvisor\nAll travellers entering or leaving must register from 1 July 2026.\nThe Example Group says: if you are not the recipient, do not disclose.`;
 const p=await extract(text,[{...room(1,2),quote},{id:'dates',kind:'dates',quote:dates,value:{arrival:'16 October',departure:'17 October'}}]);
 expect(p.facts[0].value).toMatchObject({quantity:1,adults:2});expect(p.facts[1].value).toMatchObject({arrival:'2026-10-16',departure:'2026-10-17'});
});
it.each([false,true])('retains original date convention provenance after task-first batching=%s',async batched=>{
 const text='Please quote.\n2 single rooms.\nArrival 16 September\nDeparture 17 September';
 const p=await extract(text,[{...room(2),quote:'2 single rooms.'},{id:'dates',kind:'dates',quote:'Arrival 16 September\nDeparture 17 September',value:{arrival:'16 September',departure:'17 September'}}],'2026-09-10T08:00:00Z','task_first','quote',batched);
 expect(p.facts.find(f=>f.kind==='dates')).toMatchObject({value:{arrival:'2026-09-16',departure:'2026-09-17'},convention:{sourceAt:'2026-09-10T08:00:00Z'}});
});
it('does not borrow names or room counts outside the selected room source span',async()=>{
 await expect(extract('Please quote.\nA room for Mr. Alex Example.',[{...room(),quote:'Please quote.'},guest('Alex','Example')])).rejects.toThrow('entailed');
});
it('does not apply quote conventions to another task',async()=>{
 await expect(extract('Please quote.\na bedroom',[room()],at,'combined','question')).rejects.toThrow('entailed');
 await expect(extract('Please quote.\n4–11 January',[{id:'dates',kind:'dates',quote:'4–11 January',value:{arrival:'4 January',departure:'11 January'}}],at,'combined','question')).rejects.toThrow('quote task');
});
it.each(['a room for a child','one bedroom for Mr. Alex Example and a child','rooms for students','two people or three people','2 rooms for Mr. Alex Example','not a room','From: Earlier\na room'])('keeps ambiguous/child/history occupancy unresolved: %s',async allocation=>{
 await expect(extract(`Please quote.\n${allocation}`,[room()])).rejects.toThrow('entailed');
});
it.each([
 ['Check in: 4 January\nCheck out: 11 January','4 January','11 January','2027-01-04','2027-01-11'],
 ['4–11 January','4 January','11 January','2027-01-04','2027-01-11'],
 ['Check in: 30 December\nCheck out: 2 January','30 December','2 January','2026-12-30','2027-01-02'],
] as const)('resolves the next source-time occurrence without forging printed year: %s',async(quote,arrival,departure,a,d)=>{
 const text=`Please quote.\n${quote}`,p=await extract(text,[{id:'dates',kind:'dates',quote,value:{arrival,departure}}]);
 expect(p.facts[0]).toMatchObject({source:{quote},value:{arrival:a,departure:d},convention:{rule:'centurion_next_occurrence_v1',sourceAt:at,timeZone:'Africa/Johannesburg',originalValue:{arrival,departure}}});
 expect(p.facts[0].value.yearContext).toBeUndefined();
});
it('shares a printed month across explicit arrival/departure labels without reading a later shuttle address as year',async()=>{
 const quote='Quote 4 standard rooms checking in the 5th and checkout the 8th\nof October please include dinner, bed and breakfast.';
 const text=`Please quote.\n${quote}\n\nPlease add shuttle services from the 6th until the 7th.\nAddress: Example, 0169`;
 const p=await extract(text,[{id:'dates',kind:'dates',quote,value:{arrival:'5th October',departure:'8th October'}}],'2026-09-30T08:39:06Z');
 expect(p.facts[0].value).toMatchObject({arrival:'2026-10-05',departure:'2026-10-08'});
});
it.each(['Not checking in the 5th and checkout the 8th of October.','Checking in the 5th and checkout the 8th of October or 10–12 November.','Checking in the 5th and checkout the 8th of October 2028.'])('keeps conflicting/excluded labeled shared months unresolved: %s',async quote=>{
 await expect(extract(`Please quote.\n${quote}`,[{id:'dates',kind:'dates',quote,value:{arrival:'5th October',departure:'8th October'}}])).rejects.toThrow();
});
it.each(['Not 4–11 January','4–11 January or 5–12 February','From: Earlier\n4–11 January','4–11 January 2028'])('does not apply next occurrence to excluded/conflicting/history dates: %s',async quote=>{
 await expect(extract(`Please quote.\n${quote}`,[{id:'dates',kind:'dates',quote:quote.split('\n').at(-1),value:{arrival:'4 January',departure:'11 January'}}])).rejects.toThrow();
});

it('rejects incomplete shared-month model values while retaining the exact original source quote',async()=>{const quote='checking in the 5th and checkout the 8th\nof October';await expect(extract('Please quote.\n'+quote,[{id:'dates',kind:'dates',quote,value:{arrival:'5th',departure:'8th of October'}}],'2026-09-30T08:39:06Z')).rejects.toThrow('calendar parts');});

it('retains exact printed compact date token for an explicit one-night stay',async()=>{
 const quote='12 Single room for 1 night (12NOV )',text='Please quote.\n'+quote;
 const p=await extract(text,[{id:'dates',kind:'dates',quote,value:{arrival:'12NOV',departure:'1 night'}}],'2026-09-30T08:00:00Z');expect(p.facts[0].value).toMatchObject({arrival:'2026-11-12',departure:'2026-11-13'});
});

it.each(['combined','task_first'] as const)('recognizes the original Depart label as the checkout endpoint: %s',async mode=>{
 const quote='Arrival: 16 Sept\nDepart: 17 Sept';
 const p=await extract('Please quote.\n2 single rooms (B&B)\n'+quote,[{id:'dates',kind:'dates',quote,value:{arrival:'16 Sept',departure:'17 Sept'}}],'2026-09-10T11:01:06Z',mode,'quote',mode==='task_first');
 expect(p.facts[0]).toMatchObject({source:{quote},value:{arrival:'2026-09-16',departure:'2026-09-17'},convention:{rule:'centurion_next_occurrence_v1',sourceAt:'2026-09-10T11:01:06Z',originalValue:{arrival:'16 Sept',departure:'17 Sept'}}});
});

it.each(['Arrival: 16 Sept\nDepart: 17 Sept or 18 Sept','Not Arrival: 16 Sept\nDepart: 17 Sept','Arrival: 16 Sept\nDepartment: 17 Sept'])('keeps excluded, ambiguous or non-date Depart prefixes unresolved: %s',async quote=>{
 await expect(extract('Please quote.\n'+quote,[{id:'dates',kind:'dates',quote,value:{arrival:'16 Sept',departure:'17 Sept'}}],'2026-09-10T11:01:06Z')).rejects.toThrow();
});

it.each(['Please advise if rooms are available. 2-4 October.','I want to find out if you have availability for this weekend. 2-4 October.'])('does not confuse a availability inquiry with conditional stay dates: %s',async quote=>{
 const p=await extract('Please quote.\n'+quote,[{id:'dates',kind:'dates',quote,value:{arrival:'2 October',departure:'4 October'}}],'2026-10-01T08:00:00Z');expect(p.facts[0]).toMatchObject({value:{arrival:'2026-10-02',departure:'2026-10-04'},source:{quote},convention:{rule:'centurion_next_occurrence_v1',sourceAt:'2026-10-01T08:00:00Z'}});
});
it.each(['Please quote if approved for 2-4 October.','Please quote 2-4 October if the event proceeds.','2-4 October or 9-11 October.'])('retains conditional or alternate dates as unavailable: %s',async quote=>{
 await expect(extract('Please quote.\n'+quote,[{id:'dates',kind:'dates',quote,value:{arrival:'2 October',departure:'4 October'}}],'2026-10-01T08:00:00Z')).rejects.toThrow(/Ambiguous/);
});
