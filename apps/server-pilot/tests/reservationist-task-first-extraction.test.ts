import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {extractReservationistPlan} from '../src/ai/reservationist-extraction.js';

const text='Please accept the offer.\nIs parking available?\nNightly ZAR 100.00';
const hash=createHash('sha256').update(text).digest('hex');
const span=(quote:string)=>({attachmentId:'message:m',sourceHash:hash,page:1,quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length});
const tasks=[{id:'accept',kind:'acceptance',factIds:[],source:span('Please accept the offer.')},{id:'parking',kind:'question',factIds:[],source:span('Is parking available?')}];
const fact={id:'rate',kind:'rate_claim',disclosure:'guest',source:span('Nightly ZAR 100.00'),value:{amount:'100.00',currency:'ZAR',basis:'nightly'}};
function setup(outputs:unknown[]){const reserveCalls=vi.fn(async()=>{}),invoke=vi.fn(async(_request?:unknown)=>{const output=outputs.shift();if(output instanceof Error)throw output;return{output};});return{reserveCalls,invoke,input:{adapter:{reserveCalls,invoke} as never,mode:'task_first' as const,messages:[{id:'m',at:'2026-10-01T00:00:00Z',direction:'inbound' as const,text}],causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal}};}
const selection=()=>({facts:[],tasks:tasks.map(task=>{const{start,end,...source}=task.source;return{...task,source};}),unresolvedAsks:[]});
const enrichment=()=>({facts:[structuredClone(fact)],assignments:[{taskId:'accept',factIds:['rate']},{taskId:'parking',factIds:[]}],unresolvedAsks:[]});
describe('bounded task-first extraction',()=>{
 it('instructs task selection to preserve each independently requested stay before immutable fact assignment',async()=>{
  const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);
  const calls=s.invoke.mock.calls as unknown as [[any],[any]];
  expect(calls[0][0].systemPrompt).toContain('Each independently requested accommodation stay or date set needs its own quote task');
  expect(calls[0][0].systemPrompt).toContain('Do not collapse nonoverlapping requested stays into one enclosing quote task');
  expect(calls[1][0].systemPrompt).toContain('Assign each independently supported stay date fact to its matching quote task');
 });

 it('keeps a printed shared year in both named endpoint values without using runtime context',async()=>{const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);const prompt=(s.invoke.mock.calls as unknown as [[any],[any]])[1][0].systemPrompt;expect(prompt).toContain('yearContext applies only to numeric day/month values');expect(prompt).toContain('For named-month date values, include the independently printed shared year in each endpoint value');});

 it('states full shared-month endpoint values and byte-exact short source spans through both fact and task wires',async()=>{const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);const calls=s.invoke.mock.calls as unknown as [[any],[any]];expect(calls[1][0].systemPrompt).toContain('When one final printed month applies to both labeled endpoints in that exact original span, repeat that printed month in both date values');expect(calls[1][0].systemPrompt).toContain('Do not return a day alone or add connecting words such as of to a date value');for(const call of calls)expect(call[0].systemPrompt).toContain('Copy a short unique contiguous original source span byte for byte');expect(calls[1][0].systemPrompt).toContain('Never reconstruct column alignment, indentation or newlines');});

 it('keeps phase uncertainties separate while leaving factual gaps to enrichment',async()=>{const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);const calls=s.invoke.mock.calls as unknown as [[any],[any]];expect(calls[0][0].systemPrompt).toContain('Task-selection unresolvedAsks describe only unmapped or ambiguous requested outputs');expect(calls[1][0].systemPrompt).toContain('A request for a quotation does not require the customer to state the price');expect(calls[1][0].systemPrompt).toContain('A supported scalar board applies to a sole source-verified room allocation');});

 it('delivers one-business-ask source alternatives without merging distinct requested outputs',async()=>{
  const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);
  const first=(s.invoke.mock.calls as unknown as [[any],[any]])[0][0];
  expect(first.systemPrompt).toContain('Return one task per distinct business ask.');
  expect(first.systemPrompt).toContain('alternative source spans for one task, not two tasks');
  expect(first.systemPrompt).toContain('Preserve separate asks with different topics, requested outputs or explicit targets');
  expect(first.systemPrompt).toContain('Herewith proof of payment and please confirm payment is two separate question tasks');
  expect(first.systemPrompt).toContain('A request for pro-forma invoice and payment link is one existing_document plus one question');
 });
 it('maps operational timing and conditional fee inquiries as questions before fact enrichment',async()=>{
  const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);
  const calls=s.invoke.mock.calls as unknown as [[any],[any]];
  expect(calls[0][0].systemPrompt).toContain('Early check-in, late check-out and a question about an additional timing fee are question tasks');
  expect(calls[0][0].systemPrompt).toContain('a conditional request to explain a fee does not request a quotation');
  expect(calls[1][0].systemPrompt).toContain('Timing-permission and timing-fee questions have empty factIds');
  expect(calls[1][0].systemPrompt).toContain('payment status and amount must be explicit on the same original semantic row');
  expect(calls[1][0].systemPrompt).toContain('A single ordinary ASCII space may group thousands; nonbreaking/thin grouping spaces and suffix currency tokens are unsupported.');
 });

 it('keeps room-option information as a question and omits redundant explicit-year context in phase prompts',async()=>{const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);const calls=s.invoke.mock.calls as unknown as [[any],[any]];expect(calls[0][0].systemPrompt).toContain('room options are shown or available is a question');expect(calls[1][0].systemPrompt).toContain('Omit yearContext when both date values already contain their explicit year');});
 it('binds every task and fact source ID to the original inventory in provider schemas',async()=>{
  const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);
  const calls=s.invoke.mock.calls as unknown as [[any],[any]];let count=0;
  const visit=(node:any)=>{if(!node||typeof node!=='object')return;if(node.properties?.attachmentId&&node.properties?.sourceHash){expect(node.properties.attachmentId.enum).toEqual(['message:m']);expect(node.properties.attachmentId.minLength).toBe(1);count++;}for(const child of Object.values(node))visit(child);};
  for(const call of calls)visit(call[0].responseSchema);expect(count).toBeGreaterThan(9);
 });
 it('keeps operational preferences fact-free and unresolved prose bounded without normalizing source quotes',async()=>{
  const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);
  const second=(s.invoke.mock.calls as unknown as [[any],[any]])[1][0];
  expect(second.systemPrompt).toContain('Operational arrival/check-in/check-out time or preference questions');
  expect(second.systemPrompt).toContain('each unresolvedAsks item at most 160 characters');
  expect(second.systemPrompt).toContain('Never infer guest names from filenames or quoted Subject headers');
  expect(second.systemPrompt).toContain('literal backslash-n or backslash-t');
 });

 it('defines original semantic rows consistently with the unchanged monetary binder rather than a physical PDF line',async()=>{
  const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);
  const second=(s.invoke.mock.calls as unknown as [[any],[any]])[1][0];
  expect(second.systemPrompt).toContain('semantic row, not a physical PDF line');
  expect(second.systemPrompt).toContain('newline, semicolon');
  expect(second.systemPrompt).toContain('decimal punctuation does not split a row');
  expect(second.systemPrompt).toContain('separately printed sentences may each support');
  expect(second.systemPrompt).toContain('never split inside a qualifier');
 });

 it('keeps embedded-text ambiguity safeguards separate from independently labeled visual customer claims',async()=>{
  const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);
  const second=(s.invoke.mock.calls as unknown as [[any],[any]])[1][0];
  expect(second.systemPrompt).toContain('For embedded text, multiple different amounts');
  expect(second.systemPrompt).toContain('separately labeled visual amounts');
  expect(second.systemPrompt).toContain('separate original regions');
  expect(second.systemPrompt).toContain('never text_verified or hotel price truth');
 });

 it('tells the facts phase to retain explicit same-row group IDs without treating party names or table positions as room IDs',async()=>{
  const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);
  const second=(s.invoke.mock.calls as unknown as [[any],[any]])[1][0];
  expect(second.systemPrompt).toContain('explicit room OR group ID token');
  expect(second.systemPrompt).toContain('A from Group A');
  expect(second.systemPrompt).toContain('never use a room type, table position or party name as an ID');
  expect(second.systemPrompt).toContain('same original row');
 });

 it('uses a facts-only enrichment contract while retaining complete original sources and immutable selected tasks',async()=>{
  const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);
  const calls=s.invoke.mock.calls as unknown as [[any],[any]],first=calls[0][0],second=calls[1][0];
  expect(first.systemPrompt).toContain('Select every current hotel request');
  expect(second.systemPrompt).not.toContain('Extract every hotel task');
  expect(second.systemPrompt).not.toContain('Return typed facts and tasks only');
  expect(second.systemPrompt).toContain('immutable selectedTasks');
  expect(second.systemPrompt).toContain('independently explicit facts');
  expect(second.systemPrompt).toContain('never solve allocation');
  expect(JSON.parse(second.userPrompt).sources).toEqual(JSON.parse(first.userPrompt).sources);
  expect(second.files).toEqual(first.files);expect(second.images).toEqual(first.images);
  expect(JSON.parse(second.userPrompt).selectedTasks).toEqual(tasks);
  expect(second.responseSchema.properties).not.toHaveProperty('tasks');
  expect(second.responseSchema.properties.assignments.items.properties.taskId.enum).toEqual(['accept','parking']);
 });

 it('binds only a reviewed causal invoice continuation and retains both original sources',async()=>{const s=setup([]),prior={id:'prior',at:'2026-09-25T10:00:00Z',direction:'inbound' as const,text:'Please book and send final invoice for payment.'},current={id:'current',at:'2026-09-27T10:00:00Z',direction:'inbound' as const,text:'Please see the quotation. You can book the allocated rooms.\nFrom: Prior customer\n'+prior.text};s.input.messages=[prior,current];s.input.causalAt=current.at;(s.input as any).triggerMessageId=current.id;s.invoke.mockImplementationOnce(async(request:any)=>{const c=JSON.parse(request.userPrompt).documentContinuations[0];expect(c.closure).toBe('unverified');return{output:{facts:[],tasks:[{id:'invoice',kind:'existing_document',factIds:[],sourceContinuationId:c.id}],unresolvedAsks:[]}};});s.invoke.mockImplementationOnce(async()=>({output:{facts:[],assignments:[{taskId:'invoice',factIds:[]}],unresolvedAsks:[]}}));const p=await extractReservationistPlan(s.input);expect(p.tasks[0].source.attachmentId).toBe('message:prior');expect(p.sourceContinuations).toHaveLength(1);expect(p.sourceContinuations?.[0]).toMatchObject({taskId:'invoice',closure:'unverified',currentActivationSource:{attachmentId:'message:current'}});});
 it('rejects a direct historical invoice source without a bound continuation',async()=>{const s=setup([]),prior={id:'prior',at:'2026-09-25T10:00:00Z',direction:'inbound' as const,text:'Please book and send final invoice for payment.'},current={id:'current',at:'2026-09-27T10:00:00Z',direction:'inbound' as const,text:'Please quote.'};s.input.messages=[prior,current];s.input.causalAt=current.at;(s.input as any).triggerMessageId=current.id;s.invoke.mockImplementationOnce(async()=>({output:{facts:[],tasks:[{id:'invoice',kind:'existing_document',factIds:[],source:{attachmentId:'message:prior',sourceHash:createHash('sha256').update(prior.text).digest('hex'),page:1,quote:'send final invoice for payment.'}}],unresolvedAsks:[]}}));s.invoke.mockImplementationOnce(async()=>({output:{facts:[],assignments:[{taskId:'invoice',factIds:[]}],unresolvedAsks:[]}}));await expect(extractReservationistPlan(s.input)).rejects.toThrow('historical_document_request_requires_continuation');expect(s.invoke).toHaveBeenCalledTimes(1);});
 it('rejects facts assigned to an unverified invoice continuation',async()=>{const s=setup([]),prior={id:'prior',at:'2026-09-25T10:00:00Z',direction:'inbound' as const,text:'Please book and send final invoice for payment. Reservation ABC123.'},current={id:'current',at:'2026-09-27T10:00:00Z',direction:'inbound' as const,text:'Please see the quotation. You can book the allocated rooms.\nFrom: Prior customer\n'+prior.text};s.input.messages=[prior,current];s.input.causalAt=current.at;(s.input as any).triggerMessageId=current.id;s.invoke.mockImplementationOnce(async(request:any)=>({output:{facts:[],tasks:[{id:'invoice',kind:'existing_document',factIds:[],sourceContinuationId:JSON.parse(request.userPrompt).documentContinuations[0].id}],unresolvedAsks:[]}}));s.invoke.mockImplementationOnce(async()=>({output:{facts:[{id:'ref',kind:'reservation_reference',disclosure:'guest',value:'ABC123',source:{attachmentId:'message:prior',sourceHash:createHash('sha256').update(prior.text).digest('hex'),page:1,quote:'ABC123'}}],assignments:[{taskId:'invoice',factIds:['ref']}],unresolvedAsks:[]}}));await expect(extractReservationistPlan(s.input)).rejects.toThrow('document_continuation_facts_forbidden');});
 it('offers separate exact current payment candidates despite identical quoted history',async()=>{const s=setup([]),current='Herewith proof of payment.\nPlease also confirm payment.\nOn Sat, customer wrote:\n> Herewith proof of payment.\n> Please also confirm payment.';s.input.messages=[{...s.input.messages[0]!,text:current}];s.invoke.mockImplementationOnce(async(request:any)=>{const prompt=JSON.parse(request.userPrompt),proof=prompt.requestSpans.find((c:any)=>c.source.quote==='Herewith proof of payment.'),confirm=prompt.requestSpans.find((c:any)=>c.source.quote==='Please also confirm payment.');expect(proof).toBeDefined();expect(confirm).toBeDefined();return{output:{facts:[],tasks:[{id:'proof',kind:'question',factIds:[],sourceCandidateId:proof.id},{id:'confirm',kind:'question',factIds:[],sourceCandidateId:confirm.id}],unresolvedAsks:[]}};});s.invoke.mockImplementationOnce(async()=>({output:{facts:[],assignments:[{taskId:'proof',factIds:[]},{taskId:'confirm',factIds:[]}],unresolvedAsks:[]}}));const p=await extractReservationistPlan(s.input);expect(p.tasks.map(t=>t.source.start)).toEqual([0,current.indexOf('Please also confirm payment.')]);expect(p.tasks).toHaveLength(2);});
 it('explicitly distinguishes quoted-allocation acceptance from a new booking in model instructions',async()=>{const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);const request=(s.invoke.mock.calls as unknown as [[any]])[0][0];expect(request.systemPrompt).toContain('A current instruction to book rooms allocated in a referenced prior quotation is acceptance');expect(request.systemPrompt).toContain('When the exact requested quote matches a supplied current request candidate, use sourceCandidateId');});
 it('keeps newline-separated payment evidence and confirmation candidates distinct',async()=>{const s=setup([]),current='Good morning\nHerewith proof of payment for Alex Example\n11- 16 October 2026\nPlease also confirm payment,\nThanks in advance.\nOn Sat, customer wrote:\n> Please also confirm payment,';s.input.messages=[{...s.input.messages[0]!,text:current}];s.invoke.mockImplementationOnce(async(request:any)=>{const candidates=JSON.parse(request.userPrompt).requestSpans;expect(candidates.some((c:any)=>c.source.quote==='Herewith proof of payment for Alex Example')).toBe(true);expect(candidates.some((c:any)=>c.source.quote==='Please also confirm payment,')).toBe(true);throw new Error('inspected');});await expect(extractReservationistPlan(s.input)).rejects.toThrow('inspected');});
 it.each(['If approved, please confirm payment.','Please do not confirm payment.','If approved, herewith proof of payment.','Do not please confirm payment?','If approved, please confirm payment?'])('does not advertise a fresh payment candidate from a conditional or negated parent: %s',async current=>{const s=setup([]);s.input.messages=[{...s.input.messages[0]!,text:current}];s.invoke.mockImplementationOnce(async(request:any)=>{expect(JSON.parse(request.userPrompt).requestSpans).toEqual([]);throw new Error('inspected');});await expect(extractReservationistPlan(s.input)).rejects.toThrow('inspected');});
 it('advertises only question/channel kinds for original request candidate shortcuts',async()=>{const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);const request=(s.invoke.mock.calls as unknown as [[any]])[0][0],branches=request.responseSchema.properties.tasks.items.anyOf;expect(branches).toBeDefined();expect(branches[1].properties.kind.enum).toEqual(['question','channel_booking_sync']);expect(request.systemPrompt).toContain('Commercial action tasks must use direct canonical original sources');});
 it('preserves required visual fact pages and binds page choices to actual admitted source pages',async()=>{const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);const calls=s.invoke.mock.calls as unknown as [[any],[any]];for(const f of calls[1][0].responseSchema.properties.facts.items.anyOf)for(const source of f.properties.source.anyOf){expect(source.properties.page.enum).toEqual([1]);expect(source.required).toContain('page');}});
 it('projects task selection to exact text or original visual source without model offsets',async()=>{const s=setup([selection(),enrichment()]);await extractReservationistPlan(s.input);const request=(s.invoke.mock.calls as unknown as [[any]])[0][0],task=request.responseSchema.properties.tasks.items;const canonical=(task.anyOf??[task])[0];expect(canonical.properties.source.anyOf).toHaveLength(2);for(const source of canonical.properties.source.anyOf){expect(source.properties).not.toHaveProperty('start');expect(source.properties).not.toHaveProperty('end');}expect(canonical.properties.source.anyOf[0].required).toContain('quote');expect(canonical.properties.source.anyOf[1].required).toContain('region');});
 it('rejects explicit model offsets in task selection even when they happen to be correct',async()=>{const first={facts:[],tasks:structuredClone(tasks),unresolvedAsks:[]};const s=setup([first,enrichment()]);await expect(extractReservationistPlan(s.input)).rejects.toThrow('Invalid task selection source projection');expect(s.invoke).toHaveBeenCalledTimes(1);});
 it('reserves both calls before source-bound task selection and enriches without changing requests',async()=>{
  const s=setup([selection(),enrichment()]);const p=await extractReservationistPlan(s.input);
  expect(s.reserveCalls).toHaveBeenCalledExactlyOnceWith(2,s.input.signal);expect(s.reserveCalls.mock.invocationCallOrder[0]).toBeLessThan(s.invoke.mock.invocationCallOrder[0]!);
  expect(p.tasks).toEqual([{...tasks[0],factIds:['rate']},tasks[1]]);expect(p.facts[0]).toMatchObject({amountCents:10000,authority:'customer_claim',verification:'text_verified'});expect(p.draftReady).toBe(false);
  const calls=s.invoke.mock.calls as unknown as [[any],[any]];expect(calls[0][0].responseSchema.properties.facts.maxItems).toBe(0);const taskSchema=calls[0][0].responseSchema.properties.tasks.items;for(const t of taskSchema.anyOf??[taskSchema])expect(t.properties.factIds.maxItems).toBe(0);
  expect(calls[1][0].responseSchema.properties).not.toHaveProperty('tasks');expect(calls[1][0].responseSchema.properties.assignments.items.properties.taskId.enum).toEqual(['accept','parking']);expect(JSON.parse(calls[1][0].userPrompt).selectedTasks).toEqual(tasks);
  for(const call of calls)expect(JSON.parse(call[0].userPrompt).sources[0].pages).toEqual([text]);
 });
 it('dispatches nothing when the pair reservation is unavailable',async()=>{const s=setup([]);s.reserveCalls.mockRejectedValueOnce(new Error('paid_cumulative_cap_exceeded'));await expect(extractReservationistPlan(s.input)).rejects.toThrow('paid_cumulative_cap_exceeded');expect(s.invoke).not.toHaveBeenCalled();});
 it('requires the reservation seam before any task-first dispatch',async()=>{const s=setup([]);delete(s.input.adapter as any).reserveCalls;await expect(extractReservationistPlan(s.input)).rejects.toThrow('task_first_reservation_unavailable');expect(s.invoke).not.toHaveBeenCalled();});
 it.each(['extra','omitted','duplicate','reclassified','badfact','wronghash'])('rejects unsafe enrichment %s without rewriting the selected requests',async kind=>{
  const e:any=enrichment();if(kind==='extra')e.assignments.push({taskId:'foreign',factIds:[]});if(kind==='omitted')e.assignments.pop();if(kind==='duplicate')e.assignments[1]={...e.assignments[0]};if(kind==='reclassified')e.tasks=[{...tasks[0],kind:'new_booking'}];if(kind==='badfact')e.assignments[0].factIds=['missing'];if(kind==='wronghash')e.facts[0].source.sourceHash='a'.repeat(64);
  const s=setup([selection(),e]);await expect(extractReservationistPlan(s.input)).rejects.toThrow();expect(s.invoke).toHaveBeenCalledTimes(2);
 });
 it('preserves selected tasks and marks ordinary enrichment failure without inventing successful facts',async()=>{const s=setup([selection(),new Error('azure_luna_completion_incomplete')]);const p=await extractReservationistPlan(s.input);expect(p.tasks).toEqual(tasks);expect(p.facts).toEqual([]);expect(p.manualRequired).toContain('fact_enrichment_unavailable');expect(p.unresolvedAsks).toContain('Source fact extraction unavailable; selected requests require independent source review');expect(s.invoke).toHaveBeenCalledTimes(2);});
 it.each(['provider_provenance_or_usage_bound_invalid','paid_bound_violation_terminal','Original extraction source inventory changed','attachment_scope_invalid'])('keeps enrichment guard violation fatal: %s',async error=>{const s=setup([selection(),new Error(error)]);await expect(extractReservationistPlan(s.input)).rejects.toThrow(error);});
 it('never dispatches enrichment after failed task selection',async()=>{const s=setup([new Error('azure_luna_completion_incomplete'),enrichment()]);await expect(extractReservationistPlan(s.input)).rejects.toThrow('azure_luna_completion_incomplete');expect(s.invoke).toHaveBeenCalledTimes(1);});
 it('rejects facts or references smuggled into task-only selection before enrichment',async()=>{const first:any=selection();first.facts=[fact];first.tasks[0].factIds=['rate'];const s=setup([first,enrichment()]);await expect(extractReservationistPlan(s.input)).rejects.toThrow('task_first_selection_contains_facts');expect(s.invoke).toHaveBeenCalledTimes(1);});
 it('rejects source mutation during either phase',async()=>{const s=setup([selection(),enrichment()]);s.invoke.mockImplementationOnce(async()=>{s.input.messages[0]!.text+=' changed';return{output:selection()};});await expect(extractReservationistPlan(s.input)).rejects.toThrow('Original extraction source inventory changed');expect(s.invoke).toHaveBeenCalledTimes(1);});
});

 it('constrains cancellation-status enrichment to the actual requested fields and preserves unlabeled slash-name ambiguity',async()=>{
  const text='Please confirm that this booking is cancelled.\nFrom: Earlier customer\nPlease acknowledge receipt of booking for SAMPLE/TAYLOR. Check in: 14 September 2026. Check out: 16 September 2026.',hash=createHash('sha256').update(text).digest('hex'),invoke=vi.fn(async(_request:any)=>({output:{facts:[],tasks:[{id:'status',kind:'question',factIds:[],source:{attachmentId:'message:status',sourceHash:hash,page:1,quote:'Please confirm that this booking is cancelled.'}}],unresolvedAsks:[]}}));
  let calls=0;invoke.mockImplementation(async(request:any)=>{if(++calls===1)return{output:{facts:[],tasks:[{id:'status',kind:'question',factIds:[],source:{attachmentId:'message:status',sourceHash:hash,page:1,quote:'Please confirm that this booking is cancelled.'}}],unresolvedAsks:[]}};expect(request.systemPrompt).toContain('A reservation-status or cancellation-status question uses only an explicit reservation_reference');expect(request.systemPrompt).toContain('Do not infer firstName/lastName order from an unlabeled slash-separated name');return{output:{facts:[],assignments:[{taskId:'status',factIds:[]}],unresolvedAsks:['No native confirmation reference is supplied.']}} as any;});
  const result=await extractReservationistPlan({adapter:{invoke,reserveCalls:async()=>{}} as any,mode:'task_first',messages:[{id:'status',at:'2026-10-01T00:00:00Z',direction:'inbound',text}],triggerMessageId:'status',causalAt:'2026-10-01T00:00:00Z',admissions:[],signal:new AbortController().signal});expect(result.tasks).toHaveLength(1);expect(result.tasks[0]!.kind).toBe('question');expect(result.facts).toEqual([]);expect(result.unresolvedAsks).toContain('No native confirmation reference is supplied.');
 });

describe('literal original text during fact enrichment',()=>{
 const request='Please send the amended invoice.',reference='Booking Reference: DEMO572864',stay='Check-In: 20 Oct 2026\n\nCheck-Out: 21 Oct 2026';
 const original=reference+'\n\n'+stay,at='2026-10-01T10:00:00Z';
 async function extract(referenceQuote=reference,stayQuote=stay){
  const taskSource={attachmentId:'message:current',sourceHash:createHash('sha256').update(request).digest('hex'),page:1,quote:request};
  const factSource=(quote:string)=>({attachmentId:'message:prior',sourceHash:createHash('sha256').update(original).digest('hex'),page:1,quote});
  const outputs=[{facts:[],tasks:[{id:'invoice',kind:'existing_document',factIds:[],source:taskSource}],unresolvedAsks:[]},{facts:[{id:'reference',kind:'reservation_reference',value:'DEMO572864',disclosure:'guest',source:factSource(referenceQuote)},{id:'stay',kind:'dates',value:{arrival:'2026-10-20',departure:'2026-10-21'},disclosure:'guest',source:factSource(stayQuote)}],assignments:[{taskId:'invoice',factIds:['reference','stay']}],unresolvedAsks:[]}];
  return extractReservationistPlan({adapter:{reserveCalls:async()=>{},invoke:async()=>({output:outputs.shift()})} as never,mode:'task_first',factEnrichmentMode:'source_batches',triggerMessageId:'current',messages:[{id:'prior',at:'2026-09-30T10:00:00Z',direction:'outbound',text:original},{id:'current',at,direction:'inbound',text:request}],causalAt:at,admissions:[],signal:new AbortController().signal});
 }
 it('retains the literal reference and blank lines while binding unique original offsets',async()=>{
  const result=await extract();
  expect(result.facts.map(f=>f.source.quote)).toEqual([reference,stay]);
  for(const fact of result.facts)expect(original.slice(fact.source.start!,fact.source.end!)).toBe(fact.source.quote);
  expect(result.tasks[0]!.factIds).toEqual(result.facts.map(f=>f.id));
 });
 it.each(['*','**','`'])('rejects inserted %s formatting instead of repairing the original reference',async marker=>{
  await expect(extract(marker+reference+marker)).rejects.toThrow('Unverified original text span');
 });
 it.each([stay.replaceAll('\n\n','\n'),stay.replaceAll('\n','\\n')])('rejects rewritten original newline characters: %s',async formatted=>{
  await expect(extract(reference,formatted)).rejects.toThrow('Unverified original text span');
 });
});


describe('existing worker obligations in model planning',()=>{
 it('provides exact causal obligations only to task selection, retaining immutable source pages',async()=>{
  const s=setup([selection(),enrichment()]),asks=[{sourceId:'message:m',start:text.indexOf('parking'),end:text.indexOf('parking')+7,text:'parking'}],input={...s.input,triggerMessageId:'m',requiredTaskKinds:['acceptance','question'],requiredAskSpans:asks};
  await extractReservationistPlan(input);const calls=s.invoke.mock.calls as unknown as [[any],[any]],first=JSON.parse(calls[0][0].userPrompt),second=JSON.parse(calls[1][0].userPrompt);
  expect(first.requiredTaskKinds).toEqual(input.requiredTaskKinds);expect(first.requiredAskSpans).toEqual(asks);expect(second).not.toHaveProperty('requiredTaskKinds');expect(second).not.toHaveProperty('requiredAskSpans');expect(first.sources[0].pages).toEqual([text]);expect(calls[0][0].systemPrompt).toContain('Required obligations do not establish business facts or successful tool results');
 });
 it.each(['foreign','offset','future_history','kind'])('rejects %s obligations before reserving or dispatching',async kind=>{
  const s=setup([selection(),enrichment()]),sourceText=text+'\nFrom: Earlier guest\nIs the deposit paid?',ask={sourceId:'message:m',start:text.indexOf('parking'),end:text.indexOf('parking')+7,text:'parking'},input:any={...s.input,triggerMessageId:'m',messages:[{...s.input.messages[0],text:sourceText}],requiredTaskKinds:['question'],requiredAskSpans:[ask]};
  if(kind==='foreign')ask.sourceId='message:foreign';if(kind==='offset')ask.start++;if(kind==='future_history'){ask.start=sourceText.indexOf('deposit');ask.end=ask.start+7;ask.text='deposit';}if(kind==='kind')input.requiredTaskKinds=['invented_success'];
  await expect(extractReservationistPlan(input)).rejects.toThrow('extraction_obligation_binding_invalid');expect(s.reserveCalls).not.toHaveBeenCalled();expect(s.invoke).not.toHaveBeenCalled();
 });
 it('detects obligation mutation during model dispatch instead of accepting changed coverage',async()=>{
  const s=setup([selection(),enrichment()]),input={...s.input,triggerMessageId:'m',requiredTaskKinds:['acceptance'],requiredAskSpans:[]};s.invoke.mockImplementation(async()=>{input.requiredTaskKinds.push('quote');return{output:selection()};});await expect(extractReservationistPlan(input)).rejects.toThrow('Original extraction source inventory changed');
 });
});
