import {createHash}from'node:crypto';import{expect,it}from'vitest';import{extractReservationistPlan}from'../src/ai/reservationist-extraction.js';
const at='2026-10-01T18:13:11.000Z',hash=(v:string)=>createHash('sha256').update(v).digest('hex');
async function run(text:string,quote:string,arrival='12 November',departure='1 night',kind='quote',mode:'combined'|'task_first'='combined'){
 const source={attachmentId:'message:m',sourceHash:hash(text),page:1,quote},fact={id:'d',kind:'dates',value:{arrival,departure},disclosure:'guest',source},task={id:'q',kind,factIds:['d'],source};let call=0;return extractReservationistPlan({mode,adapter:{reserveCalls:async()=>{},invoke:async()=>({output:mode==='combined'?{facts:[fact],tasks:[task],unresolvedAsks:[]}:++call===1?{facts:[],tasks:[{...task,factIds:[]}],unresolvedAsks:[]}:{facts:[fact],assignments:[{taskId:'q',factIds:['d']}],unresolvedAsks:[]}})}as never,...(mode==='task_first'?{factEnrichmentMode:'source_batches' as const,messageBatching:'per_source' as const}:{}),messages:[{id:'m',at,direction:'inbound',text}],triggerMessageId:'m',causalAt:at,admissions:[],signal:new AbortController().signal});
}
it.each(['combined','task_first']as const)('derives checkout from one original dated accommodation and explicit night token: %s',async mode=>{const quote='12 Single room for 1 night (12NOV )',text='Please quote.\n'+quote;const p=await run(text,quote,'12 November','1 night','quote',mode);expect(p.facts[0]).toMatchObject({source:{quote},value:{arrival:'2026-11-12',departure:'2026-11-13'},convention:{rule:'centurion_explicit_nights_v1',sourceAt:at,timeZone:'Africa/Johannesburg',originalValue:{arrival:'12 November',departure:'1 night'}}});});
it('derives a bounded explicit multiday stay through year rollover',async()=>{const quote='A single room for 3 nights from 30 December';const p=await run('Please quote.\n'+quote,quote,'30 December','3 nights');expect(p.facts[0].value).toEqual({arrival:'2026-12-30',departure:'2027-01-02'});});
it.each(['Single room on 12 November','Single room for 1 night on 12 November and 13 November','Not a single room for 1 night on 12 November','Single room for 1 night on 12 November with a child','Conference for 1 night on 12 November','Single room for 1 night on 12 November, checkout 14 November','Single room for 1 night or 2 nights on 12 November'])('rejects missing/contradictory/child/event-only duration evidence: %s',quote=>expect(run('Please quote.\n'+quote,quote)).rejects.toThrow());
it('rejects quoted duration context and non-quote tasks',async()=>{const quote='Single room for 1 night on 12 November';await expect(run('Please quote.\nFrom: Earlier\n'+quote,quote)).rejects.toThrow();await expect(run(quote,quote,'12 November','1 night','question')).rejects.toThrow('quote task');});
it('does not accept an unprinted checkout endpoint in place of the explicit night token',()=>{const quote='Single room for 1 night on 12 November';return expect(run('Please quote.\n'+quote,quote,'12 November','13 November')).rejects.toThrow();});
it('sends quote-specification, original-duration and attachment occupancy limits in actual phase prompts',async()=>{const text='Please advise quotes.\n12 single rooms for 1 night on 12 November',source={attachmentId:'message:m',sourceHash:hash(text),page:1,quote:'12 single rooms for 1 night on 12 November'},calls:any[]=[];await extractReservationistPlan({mode:'task_first',adapter:{reserveCalls:async()=>{},invoke:async(request:any)=>{calls.push(request);return{output:calls.length===1?{facts:[],tasks:[{id:'q',kind:'quote',factIds:[],source}],unresolvedAsks:[]}:{facts:[],assignments:[{taskId:'q',factIds:[]}],unresolvedAsks:[]}}}}as never,messages:[{id:'m',at,direction:'inbound',text}],triggerMessageId:'m',causalAt:at,admissions:[],signal:new AbortController().signal});expect(calls[0].systemPrompt).toContain('Independent accommodation specifications within an authored quotation enquiry remain quote tasks');expect(calls[1].systemPrompt).toContain('return arrival as the printed day-month token and departure as the exact printed night-duration token');expect(calls[1].systemPrompt).toContain('A title or salutation in a PDF or DOCX never supplies room quantity, adult occupancy or absence of children');expect(calls[1].systemPrompt).toContain('Occupied-night date lists are not arrival/check-out pairs');});

it('keeps a child qualifier just outside a narrowed dated-night span unresolved',()=>{const quote='Single room for 1 night on 12 November',text='Please quote.\n'+quote+'. One child is included.';return expect(run(text,quote)).rejects.toThrow();});
it('requires the accommodation noun in the selected original duration span',()=>{const quote='1 night on 12 November';return expect(run('Please quote a single room for '+quote,quote)).rejects.toThrow();});

it('keeps unrelated event questions and attendee counts outside the dated accommodation paragraph',async()=>{const quote='12 Single room for 1 night (12NOV )',text='Please quote.\nI have a group from Example Embassy.\nCan you advise if an event for 30 people is possible?\n\n'+quote+'\n\nOn 13 November: day conference.';const p=await run(text,quote);expect(p.facts[0].value).toEqual({arrival:'2026-11-12',departure:'2026-11-13'});});
it('keeps negation immediately preceding the original accommodation paragraph binding',()=>{const quote='Single room for 1 night on 12 November';return expect(run('Please quote.\nDo not use:\n'+quote,quote)).rejects.toThrow();});

it('uses the explicit single-room count without borrowing surrounding event attendance or a named group',async()=>{const quote='12 Single room for 1 night (12NOV )',text='Please quote.\nA group wants an event for 30 people. Can you advise if possible?\n\n'+quote+'\n\nDay conference on 13 November',source={attachmentId:'message:m',sourceHash:hash(text),page:1,quote};const p=await extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'r',kind:'room',value:{roomRef:'1',quantity:12,adults:1,childAges:[]},disclosure:'guest',source}],tasks:[{id:'q',kind:'quote',factIds:['r'],source}],unresolvedAsks:[]}})}as never,messages:[{id:'m',at,direction:'inbound',text}],triggerMessageId:'m',causalAt:at,admissions:[],signal:new AbortController().signal});expect(p.facts[0].value).toMatchObject({quantity:12,adults:1});});

it('does not override explicit next-year context with the causal next-occurrence default',()=>{const quote='Single room for 1 night on 12 November';return expect(run('Please quote for next year.\n'+quote,quote)).rejects.toThrow();});
it('keeps zero, oversized and different printed durations unresolved',async()=>{for(const token of ['0 nights','367 nights','2 nights']){const quote='Single room for 1 night on 12 November';await expect(run('Please quote.\n'+quote,quote,'12 November',token)).rejects.toThrow();}});
it.each(['Checkout is 14 November.','The stay is in 2027.','Do not use the above accommodation dates.','The accommodation ends on 14 November.','Correction: the above dates are in 2027.'])('keeps same-stay corrections outside a narrowed paragraph binding: %s',correction=>{const quote='Single room for 1 night on 12 November';return expect(run(quote+'\n\n'+correction,quote)).rejects.toThrow();});
it('keeps independently labeled event dates and years outside the stay correction scope',async()=>{const quote='Single room for 1 night on 12 November',text=quote+'\n\nThe conference ends on 14 November. The event is in 2027.';const p=await run(text,quote);expect(p.facts[0].value).toEqual({arrival:'2026-11-12',departure:'2026-11-13'});});
it('does not use a later quoted historical correction as a current stay correction',async()=>{const quote='Single room for 1 night on 12 November',text=quote+'\n\nFrom: Earlier\nCheckout is 14 November. The stay is in 2027.';const p=await run(text,quote);expect(p.facts[0].value).toEqual({arrival:'2026-11-12',departure:'2026-11-13'});});
it.each(['One child will accompany the group.','The named family includes a minor.'])('keeps child/family scope elsewhere in the current authored request binding: %s',async qualifier=>{const quote='12 Single room for 1 night (12NOV )',text='Please quote.\n'+qualifier+'\n\n'+quote;await expect(run(text,quote)).rejects.toThrow();const source={attachmentId:'message:m',sourceHash:hash(text),page:1,quote};await expect(extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'r',kind:'room',value:{roomRef:'1',quantity:12,adults:1,childAges:[]},disclosure:'guest',source}],tasks:[{id:'q',kind:'quote',factIds:['r'],source}],unresolvedAsks:[]}})}as never,messages:[{id:'m',at,direction:'inbound',text}],triggerMessageId:'m',causalAt:at,admissions:[],signal:new AbortController().signal})).rejects.toThrow();});

const occupiedList='Please quote accommodation for next year.\n26th and 27th October - 30 rooms.\n17th and 18th November - 30 rooms.\nCurrently we require 2 nights per date set.';
it.each(['combined','task_first'] as const)('derives checkout only from consecutive original occupied nights and exact future-year duration (%s)',async mode=>{
 for(const [arrival,expected] of [['26 October','2027-10-26'],['17 November','2027-11-17']]){
  const p=await run(occupiedList,occupiedList,arrival,'2 nights','quote',mode);
  expect(p.facts[0]).toMatchObject({value:{arrival:expected,departure:new Date(Date.parse(expected+'T00:00:00Z')+2*86400000).toISOString().slice(0,10)},convention:{rule:'centurion_explicit_nights_v1',sourceAt:at}});
 }
});
it.each([
 occupiedList.replace('27th','28th'),
 occupiedList.replace('2 nights','1 night'),
 occupiedList.replace('next year','last year'),
 occupiedList+'\nCheckout is 29 October.',
 occupiedList+'\nThe accommodation is cancelled.',
 occupiedList+'\nCorrection: the accommodation is three nights instead.',
 occupiedList+'\nOne child accompanies this room.',
 'From: Earlier\n'+occupiedList,
 occupiedList.replace('require 2 nights','may require 2 nights'),
])('rejects ambiguous, contradicted or historical occupied-night dates: %s',text=>expect(run(text,text,'26 October','2 nights')).rejects.toThrow());

it('requires the future-year instruction inside the original occupied-night fact span',()=>{
 const text=occupiedList,quote=text.slice(text.indexOf('26th'));
 return expect(run(text,quote,'26 October','2 nights')).rejects.toThrow();
});

it('requires an explicit single year or next-year intent for occupied nights and retains conflicting years as unavailable',async()=>{
 const explicit=occupiedList.replace('next year','2027');const plan=await run(explicit,explicit,'26 October','2 nights');expect(plan.facts[0].value).toEqual({arrival:'2027-10-26',departure:'2027-10-28'});
 for(const text of [occupiedList.replace('next year','this year'),occupiedList+'\nThe room dates are 2028.'])await expect(run(text,text,'26 October','2 nights')).rejects.toThrow();
});

it('keeps a contradictory same-stay year outside the narrowed occupied-night citation binding',()=>expect(run(occupiedList+'\nThe above room dates are in 2028.',occupiedList,'26 October','2 nights')).rejects.toThrow());

it('does not import occupied-night arrival or duration from a different source citation',async()=>{
 const text=occupiedList,quote='Please quote accommodation for next year.\n26th and 27th October - 30 rooms.\nCurrently we require 2 nights per date set.';
 await expect(run(text,quote,'17 November','2 nights')).rejects.toThrow();
});
