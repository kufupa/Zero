import {createHash} from 'node:crypto';
import type {LocalModelTransportResult} from '../src/ai/bedrock/local.js';
import {describe,it,expect,vi} from 'vitest';
import * as providerModule from '../src/ai/reservationist-provider.js';
import {runReservationistRuntime} from '../src/ai/reservationist-runtime.js';

function fixture(){
 const now=new Date(),at=now.toISOString(),deadline=now.getTime()+60000,text='Is parking available?';
 const route={routeId:'local-test',purpose:'draft' as const,protocol:'in_process' as const,access:'current_app' as const,egress:'none' as const,retention:'bounded' as const,usage:'reported' as const,modelId:'gpt-6-luna'};
 const release={releaseId:'reviewed',releaseVersion:'1',sourceRevision:'source-revision',fingerprint:'release-fingerprint',purpose:'draft' as const,capabilityFamilyVersions:{reservationist:'reservationist-runtime-v1'},issuedAt:new Date(now.getTime()-1000).toISOString(),expiresAt:new Date(deadline).toISOString(),withdrawn:false};
 const taskSource={attachmentId:'message:inbound',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text,start:0,end:text.length};
 const transport=vi.fn(async():Promise<LocalModelTransportResult>=>({output:{facts:[],tasks:[{id:'parking',kind:'question',factIds:[],source:taskSource}],unresolvedAsks:[]},usage:{inputTokens:10,outputTokens:20,latencyMs:1}}));
 const context:any={db:{},transportId:'mailbox',threadId:'thread',requestedByUserId:'staff',generationId:'generation',admissions:[],input:{version:1,requestId:'inbound',propertyCode:'HRCEN',authorizationScope:{ownerRef:'mailbox',threadId:'thread'},trigger:{id:'inbound',at},messages:[{id:'inbound',at,direction:'inbound',text}],authorizedArtifacts:[],clock:{causalAt:at,sourceAt:at,sourceMode:'current_read',deadlineAt:deadline},capabilities:{pmsWrite:false,emailSend:false}},signal:new AbortController().signal,fence:{runId:'run',claimOwner:'worker',claimToken:'token',deadlineAt:new Date(deadline)}};
 const answer={kind:'parking',value:true,disclosure:'guest',evidenceRefs:['property:parking'],preparedFacts:[{key:'parking',label:'Parking',value:true,source:'property',authority:'authorized',status:'known',evidenceRef:'property:parking',scopeVerified:true,disclosure:'guest'}]};
 const resolveTaskAnswer=vi.fn(async()=>answer),authorizeAnswerSource=vi.fn(async()=>true);
 const artifactStorage={stage:vi.fn(),read:vi.fn()};
 const services:any={resolveTaskAnswer,authorizeAnswerSource};
 const resolveServices=vi.fn(async()=>({services,header:{attention:'',company:'',clientEmail:'',clientTelephone:'',agency:'',signerName:'',signerEmail:''},converter:{url:'http://trusted-converter.test',fetchImpl:vi.fn()},artifactStorage}));
 let current:any={route,release};
 const resolveCurrentAuthority=vi.fn(async()=>current),authorizeContext=vi.fn(async()=>true);
 const options={routeConfig:{route,release,transport},resolveCurrentAuthority,authorizeContext,resolveServices};
 return{options,context,route,release,transport,resolveServices,resolveCurrentAuthority,authorizeContext,resolveTaskAnswer,authorizeAnswerSource,artifactStorage,services,setCurrent:(value:any)=>{current=value;}};
}
const create=(options:any)=>(providerModule as any).createReservationistProvider(options);
describe('trusted reservationist provider constructor',()=>{
 it('uses the existing local adapter/factory and retains supplied storage plus reported usage',async()=>{
  const f=fixture();const supplied=await create(f.options)(f.context);expect(f.transport).not.toHaveBeenCalled();expect(supplied.artifactStorage).toBe(f.artifactStorage);
  const result=await runReservationistRuntime(f.context.input,supplied.dependencies);expect(result.readiness).toBe('ready_for_staff_review');expect(result.textBody).toContain('Parking is available.');expect(f.transport).toHaveBeenCalledTimes(1);expect(supplied.collectUsage()).toMatchObject({known:true,modelCalls:1,inputTokens:10,outputTokens:20,rateTableVersions:['local:local-test']});expect(supplied.collectGeneratedArtifacts()).toEqual([]);expect(f.artifactStorage.stage).not.toHaveBeenCalled();expect(f.artifactStorage.read).not.toHaveBeenCalled();expect(f.authorizeContext.mock.calls.length).toBeGreaterThan(2);
 });
 it.each(['missing_release','expired','future','withdrawn','purpose','capability','model','missing_context_guard'])('rejects %s before source or model calls',async kind=>{
  const f=fixture(),o:any=f.options;if(kind==='missing_release')delete o.routeConfig.release;if(kind==='expired')f.release.expiresAt=new Date(Date.now()-1).toISOString();if(kind==='future')f.release.issuedAt=new Date(Date.now()+60000).toISOString();if(kind==='withdrawn')f.release.withdrawn=true;if(kind==='purpose')f.route.purpose='extraction' as any;if(kind==='capability')f.release.capabilityFamilyVersions.reservationist='unqualified';if(kind==='model')f.route.modelId='unapproved-model';if(kind==='missing_context_guard')delete o.authorizeContext;
  await expect(async()=>{await create(o)(f.context);}).rejects.toThrow();expect(f.resolveServices).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
 });
 it.each(['scope','requester','generation','fence','deadline','denied','aborted'])('fails closed for invalid %s context',async kind=>{
  const f=fixture();if(kind==='scope')f.context.input.authorizationScope.threadId='foreign';if(kind==='requester')f.context.requestedByUserId='';if(kind==='generation')f.context.generationId='';if(kind==='fence')f.context.fence.claimToken='';if(kind==='deadline')f.context.fence.deadlineAt=new Date(Date.now()-1);if(kind==='denied')f.authorizeContext.mockResolvedValue(false);if(kind==='aborted'){const controller=new AbortController();controller.abort();f.context.signal=controller.signal;}
  await expect(create(f.options)(f.context)).rejects.toThrow();expect(f.resolveServices).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
 });
 it('revalidates exact authority after server service resolution',async()=>{
  const f=fixture();f.resolveServices.mockImplementation(async()=>{f.setCurrent({route:f.route,release:{...f.release,fingerprint:'changed'}});return{services:f.services,header:{},converter:{url:'unused',fetchImpl:vi.fn()}} as any;});
  await expect(create(f.options)(f.context)).rejects.toThrow('authority');expect(f.transport).not.toHaveBeenCalled();
 });
 it('revalidates release immediately before every model and service operation',async()=>{
  const f=fixture(),supplied=await create(f.options)(f.context);f.setCurrent({route:f.route,release:{...f.release,withdrawn:true}});
  await expect(supplied.dependencies.plan(f.context.input,f.context.signal)).rejects.toThrow('authority');expect(f.transport).not.toHaveBeenCalled();
  f.setCurrent({route:f.route,release:f.release});const plan=await supplied.dependencies.plan(f.context.input,f.context.signal);f.authorizeContext.mockResolvedValue(false);
  await expect(supplied.dependencies.execute(plan,f.context.input,f.context.signal)).rejects.toThrow('context');expect(f.resolveTaskAnswer).not.toHaveBeenCalled();
 });
 it('checks revocation between a service resolver and its nested source callback',async()=>{
  const f=fixture(),nested=vi.fn(async()=>({ref:'never-read'}));f.services.resolveQuoteTask=vi.fn(async()=>({resolveSource:nested,resolvePolicy:async()=>null,admission:{authorizeSource:async()=>true}}));
  const text='Please quote.';f.context.input.messages[0].text=text;const source={attachmentId:'message:inbound',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text,start:0,end:text.length};f.transport.mockResolvedValue({output:{facts:[],tasks:[{id:'quote',kind:'quote',factIds:[],source}],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,latencyMs:1}});
  const supplied=await create(f.options)(f.context);const plan=await supplied.dependencies.plan(f.context.input,f.context.signal);
  f.services.resolveQuoteTask.mockImplementation(async()=>{f.setCurrent({route:f.route,release:{...f.release,withdrawn:true}});return{resolveSource:nested,resolvePolicy:async()=>null,admission:{authorizeSource:async()=>true}};});
  const work=await supplied.dependencies.execute(plan,f.context.input,f.context.signal).catch(()=>null);expect(nested).not.toHaveBeenCalled();expect(work===null||work.tasks[0].status==='blocked').toBe(true);
 });
 it('requires supplied converter and header rather than installing defaults',async()=>{
  const f=fixture();f.resolveServices.mockResolvedValue({services:f.services,header:{},converter:{url:'http://trusted'}} as any);
  await expect(create(f.options)(f.context)).rejects.toThrow();expect(f.transport).not.toHaveBeenCalled();
 });
});

it('rejects a changed live route or mutated context before any next operation',async()=>{
 const f=fixture(),supplied=await create(f.options)(f.context);f.setCurrent({route:{...f.route,routeId:'foreign'},release:f.release});await expect(supplied.dependencies.plan(f.context.input,f.context.signal)).rejects.toThrow('authority');expect(f.transport).not.toHaveBeenCalled();
 f.setCurrent({route:f.route,release:f.release});f.context.requestedByUserId='another-staff';await expect(supplied.dependencies.plan(f.context.input,f.context.signal)).rejects.toThrow('context');
});
it('fails when release is withdrawn during model transport and preserves unreported usage honestly',async()=>{
 const f=fixture();f.transport.mockImplementation(async()=>{f.setCurrent({route:f.route,release:{...f.release,withdrawn:true}});return{output:{facts:[],tasks:[],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,latencyMs:1}};});const supplied=await create(f.options)(f.context);await expect(supplied.dependencies.plan(f.context.input,f.context.signal)).rejects.toThrow();expect(supplied.collectUsage()).toMatchObject({known:false,inputTokens:null});
});

it('detects live fence deadline mutation instead of losing Date content in a digest',async()=>{
 const f=fixture(),supplied=await create(f.options)(f.context);f.context.fence.deadlineAt=new Date(f.context.fence.deadlineAt.getTime()+1000);await expect(supplied.dependencies.plan(f.context.input,f.context.signal)).rejects.toThrow('context');expect(f.transport).not.toHaveBeenCalled();
});
it('retains actual generated PDF bytes and guards nested source policy functions',async()=>{
 const f=fixture(),{syntheticRevision}=await import('./helpers/synthetic-quote-revision.js');const r=await syntheticRevision(undefined,undefined,undefined,f.context.input.clock.sourceAt);const g=r.groups[0],room={id:g.id,quantity:g.quantity,adults:g.adults,children:g.children,childAges:g.childAges};
 const nativeSource={ref:'synthetic',sha256:g.sourceHash,toolVersion:'2',observedAt:g.observedAt,request:{propertyCode:r.propertyCode,requestedCurrency:r.currency,arrivalDate:g.arrivalDate,departureDate:g.departureDate,rooms:[room]},result:{outcome:'quote',propertyCode:r.propertyCode,groups:[{id:g.id,request:room,completeness:{search:'complete',requiredFacts:'complete'},options:[{id:'selected',room:{code:g.roomCode,label:g.roomLabel,buildingCode:'MAIN'},rate:{code:g.rateCode,label:g.rateLabel},board:'Room Only R',appliedContext:{},eligibility:'verified',availability:'available',matchStatus:'match',held:false,totals:{taxInclusive:true},nightly:g.nightly.map(n=>({date:n.date,inventory:n.inventory,price:{amount:(n.amountMinor/100).toFixed(2),currency:'ZAR'}}))}]}]}};
 const resolveSource=vi.fn(async()=>nativeSource),resolvePolicy=vi.fn(async()=>({ref:'policy',propertyCode:'HRCEN',sourceHashes:['a'.repeat(64)],authoredDates:['2026-09-26'],families:[{rateCode:'BAR',board:'room_only'}],vat:'included',levy:'included'})),authorizeSource=vi.fn(async()=>true);
 f.services.resolveQuoteTask=async()=>({propertyCode:'HRCEN',authoredDate:r.authoredDate,selections:[{sourceRef:'synthetic',groupId:'g1',optionId:'selected'}],resolveSource,resolvePolicy,admission:{authorizationId:r.authorizationId,sourceEvaluationAt:f.context.input.clock.sourceAt,maxSourceAgeMs:3600000,expectedRequests:{synthetic:nativeSource.request},authorizeSource}});
 f.services.authorizeGuestProposal=async()=>true;
 const text='Please quote.',source={attachmentId:'message:inbound',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text,start:0,end:text.length};f.context.input.messages[0].text=text;
 f.transport.mockResolvedValue({output:{facts:[],tasks:[{id:'quote',kind:'quote',factIds:[],source}],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,latencyMs:1}});
 const bytes=Buffer.from('%PDF-1.4 source-backed synthetic'),converter=vi.fn(async(_url:Parameters<typeof fetch>[0],_init?:RequestInit)=>new Response(bytes,{headers:{'content-type':'application/pdf'}}));f.resolveServices.mockImplementation(async()=>({services:f.services,header:{attention:'',company:'',clientEmail:'',clientTelephone:'',agency:'',signerName:'',signerEmail:''},converter:{url:'http://trusted-converter.test',fetchImpl:converter as any},artifactStorage:f.artifactStorage}));
 const supplied=await create(f.options)(f.context);const result=await runReservationistRuntime(f.context.input,supplied.dependencies);expect(result.artifacts).toHaveLength(1);expect(supplied.collectGeneratedArtifacts()[0].body).toEqual(bytes);expect(Buffer.isBuffer(supplied.collectGeneratedArtifacts()[0].body)).toBe(true);expect(resolveSource).toHaveBeenCalledTimes(1);expect(resolvePolicy).toHaveBeenCalledTimes(1);expect(authorizeSource).toHaveBeenCalledTimes(1);expect(converter.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);expect(f.artifactStorage.stage).not.toHaveBeenCalled();
});

it.each(['future_message','causal_clock','source_clock'])('rejects invalid %s before resolving server sources',async kind=>{
 const f=fixture();if(kind==='future_message')f.context.input.messages[0].at=new Date(Date.now()+60000).toISOString();if(kind==='causal_clock')f.context.input.clock.causalAt='invalid';if(kind==='source_clock')f.context.input.clock.sourceAt='invalid';
 await expect(create(f.options)(f.context)).rejects.toThrow('context');expect(f.resolveServices).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
});
it('preserves synchronous read context and runs guarded reservation reads through the trusted provider',async()=>{
 const f=fixture(),{syntheticReservationistRead}=await import('./helpers/synthetic-reservationist-read.js');
 const read=await syntheticReservationistRead({fields:['reservation_status']});
 const text='What is the status of reservation ABC123?',at=read.input.clock.sourceAt;
 const source={attachmentId:'message:trigger',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text,start:0,end:text.length};
 const {createReservationContextFacade}=await import('../src/hms/reservation-context-facade.js');
 read.context.reservationFacade=createReservationContextFacade({now:read.context.now,reservationRefFor:()=> 'ABC123',lookup:async()=>({status:'matched',row:{confirmationNumber:'ABC123',externalReference:null,guestName:'Synthetic',arrivalDate:'2026-10-12',departureDate:'2026-10-15',reservationStatus:'Tentative',roomType:'STQN',ratePlan:null},evidenceRef:'source',observedAt:at,expiresAt:'2026-10-04T10:05:00.000Z'}),readContext:read.readContext});
 await read.context.reservationFacade.findReservation({...read.context,candidateId:'candidate',referenceKind:'confirmation',value:'ABC123',observedAt:new Date(at),expiresAt:new Date('2026-10-04T10:05:00.000Z')});
 read.request.reservationRef='ABC123';read.input.reservationRef='ABC123';read.input.taskSource={sourceRef:source.attachmentId,sourceHash:source.sourceHash,quote:text,start:0,end:text.length};
 f.context.transportId=read.input.ownerRef;f.context.threadId=read.input.threadId;f.context.input={...f.context.input,requestId:'trigger',authorizationScope:{ownerRef:read.input.ownerRef,threadId:read.input.threadId},trigger:{id:'trigger',at},messages:[{id:'trigger',at,direction:'inbound',text}],clock:{...read.input.clock,sourceMode:'current_read'}};
 f.context.fence.deadlineAt=new Date(f.context.input.clock.deadlineAt);
 read.input.requestId='trigger';read.context.parentRef='trigger';
 // Rebind the opaque facade to the exact request parent used by the provider.
 await read.context.reservationFacade.findReservation({...read.context,candidateId:'candidate',referenceKind:'confirmation',value:'ABC123',observedAt:new Date(at),expiresAt:new Date('2026-10-04T10:05:00.000Z')});
 f.services.resolveReadTask=async()=>({input:read.input,dependencies:read.deps});
 f.transport.mockResolvedValue({output:{facts:[{id:'ref',kind:'reservation_reference',value:'ABC123',source,disclosure:'guest'}],tasks:[{id:read.input.taskId,kind:'question',factIds:['ref'],source}],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,latencyMs:1}});
 const supplied=await create(f.options)(f.context),result=await runReservationistRuntime(f.context.input,supplied.dependencies);
 expect(result.readRecoveries).toEqual([{taskId:read.input.taskId,codes:[]}]);expect(result.readiness).toBe('ready_for_staff_review');expect(result.textBody).toContain('Tentative');expect(read.readContext).toHaveBeenCalledOnce();expect(result.readReceipts).toHaveLength(1);expect(read.context.now()).toBeInstanceOf(Date);
});
it('preserves ordinary source context objects without misclassifying them as read execution context',async()=>{
 const f=fixture();f.services.resolveTaskAnswer=async()=>({kind:'parking',value:true,disclosure:'guest',evidenceRefs:['property:parking'],context:{organization:{name:'Synthetic'}},preparedFacts:[{key:'parking',label:'Parking',value:true,source:'property',authority:'authorized',status:'known',evidenceRef:'property:parking',scopeVerified:true,disclosure:'guest'}]});
 const supplied=await create(f.options)(f.context),result=await runReservationistRuntime(f.context.input,supplied.dependencies);expect(result.readiness).toBe('ready_for_staff_review');expect(result.textBody).toContain('Parking is available.');
});

describe('ordinary provider extraction configuration',()=>{
 function phasedFixture(perSource=false){
  const f=fixture(),options:any={...f.options,extractionMode:'task_first',factEnrichmentMode:'source_batches',...(perSource?{messageBatching:'per_source'}:{})};
  const reserveCalls=vi.fn(async(_count:number,_signal:AbortSignal)=>{});options.routeConfig={...options.routeConfig,reserveCalls};
  if(perSource)f.context.input.messages.unshift({id:'prior',at:f.context.input.trigger.at,direction:'inbound',text:'Earlier original context.'});
  let calls=0;f.transport.mockImplementation(async()=>({output:calls++===0?{facts:[],tasks:[{id:'parking',kind:'question',factIds:[],source:{attachmentId:'message:inbound',sourceHash:createHash('sha256').update(f.context.input.messages.at(-1).text).digest('hex'),page:1,quote:f.context.input.messages.at(-1).text}}],unresolvedAsks:[]}:{facts:[],assignments:[{taskId:'parking',factIds:[]}],unresolvedAsks:[]},usage:{inputTokens:10,outputTokens:20,latencyMs:1}}));
  return{...f,options,reserveCalls};
 }
 it.each([false,true])('reserves the exact shared-factory plan once, per_source=%s',async perSource=>{
  const f=phasedFixture(perSource),supplied=await create(f.options)(f.context),result=await runReservationistRuntime(f.context.input,supplied.dependencies);
  expect(f.reserveCalls).toHaveBeenCalledExactlyOnceWith(perSource?3:2,expect.any(AbortSignal));expect(f.reserveCalls.mock.calls[0]?.[1].aborted).toBe(false);expect(f.transport).toHaveBeenCalledTimes(perSource?3:2);expect(result.textBody).toContain('Parking is available.');
  const requests=f.transport.mock.calls.map(c=>(c as any)[0]),factPrompts=requests.slice(1).map(r=>JSON.parse(r.userPrompt));
  expect(factPrompts.every(p=>p.selectedTasks.length===1&&p.selectedTasks[0].id==='parking')).toBe(true);
  if(perSource)expect(factPrompts.map(p=>p.sources[0].attachmentId)).toEqual(['message:prior','message:inbound']);
  expect(supplied.collectUsage()).toMatchObject({known:true,modelCalls:perSource?3:2});expect(supplied.collectGeneratedArtifacts()).toEqual([]);
 });
 it('refuses task-first without a real reservation seam before service or model calls',async()=>{
  const f=fixture();await expect(async()=>create({...f.options,extractionMode:'task_first'})(f.context)).rejects.toThrow(/reservation/i);expect(f.resolveServices).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
 });
 it.each(['withdrawn','mutated','budget-denied'])('stops before transport when reservation is %s',async kind=>{
  const f=phasedFixture(true);f.reserveCalls.mockImplementationOnce(async()=>{if(kind==='withdrawn')f.setCurrent({route:f.route,release:{...f.release,withdrawn:true}});if(kind==='mutated')delete f.options.messageBatching;if(kind==='budget-denied')throw new Error('actual_budget_denied');});
  const supplied=await create(f.options)(f.context);await expect(supplied.dependencies.plan(f.context.input,f.context.signal)).rejects.toThrow();expect(f.reserveCalls).toHaveBeenCalledTimes(1);expect(f.transport).not.toHaveBeenCalled();
 });
 it('evaluates a genuinely delayed read using a runtime-owned clock without changing the causal input',async()=>{
  const f=fixture(),original=JSON.stringify(f.context.input),initial=Date.parse(f.context.input.clock.sourceAt);let observed=0,evaluated=0,viewTime=0;
  f.services.resolveTaskAnswer=async(ctx:any)=>{await new Promise(resolve=>setTimeout(resolve,15));observed=Date.now();evaluated=Date.parse(ctx.evaluateSourceAt());viewTime=Date.parse(ctx.input.clock.sourceAt);return{kind:'parking',value:true,disclosure:'guest',evidenceRefs:['delayed:parking'],preparedFacts:[{key:'parking',label:'Parking',value:true,source:'property',authority:'authorized',status:'known',evidenceRef:'delayed:parking',observedAt:new Date(observed).toISOString(),expiresAt:new Date(evaluated+1000).toISOString(),scopeVerified:true,disclosure:'guest'}]};};
  const supplied=await create({...f.options,currentReadEvaluation:true})(f.context),result=await runReservationistRuntime(f.context.input,supplied.dependencies);
  expect(evaluated).toBeGreaterThanOrEqual(observed);expect(viewTime).toBe(evaluated);expect(evaluated).toBeGreaterThan(initial);expect(f.authorizeAnswerSource).toHaveBeenCalled();expect(result.errors).toEqual([]);expect(result.tasks[0]).toMatchObject({status:'complete'});expect(result.textBody).toContain('Parking is available.');expect(Date.parse((result as any).sourceEvaluatedAt)).toBeGreaterThanOrEqual(evaluated);expect(JSON.stringify(f.context.input)).toBe(original);
 });
 it('still rejects an arbitrary caller source-clock edit in live mode',async()=>{
  const f=fixture(),supplied=await create({...f.options,currentReadEvaluation:true})(f.context);const plan=await supplied.dependencies.plan(f.context.input,f.context.signal),changed={...f.context.input,clock:{...f.context.input.clock,sourceAt:new Date(Date.parse(f.context.input.clock.sourceAt)+1).toISOString()}};
  await expect(supplied.dependencies.execute(plan,changed,f.context.signal)).rejects.toThrow('input changed');
 });
 it('passes the same causal input through ordinary worker and rejects shortening its bound deadline',async()=>{
  const f=fixture(),{runPreparedWorkerCandidateReply}=await import('../src/ai/worker.js');let originalSeen=false;
  f.services.resolveTaskAnswer=async(ctx:any)=>{await new Promise(r=>setTimeout(r,5));ctx.evaluateSourceAt();return{kind:'parking',value:true,disclosure:'guest',evidenceRefs:['property:parking'],preparedFacts:[{key:'parking',label:'Parking',value:true,source:'property',authority:'authorized',status:'known',evidenceRef:'property:parking',scopeVerified:true,disclosure:'guest'}]};};
  const supplied=await create({...f.options,currentReadEvaluation:true})(f.context),plan=supplied.dependencies.plan;
  const deps={...supplied.dependencies,plan:async(input:any,signal:AbortSignal)=>{originalSeen=input===f.context.input;return plan(input,signal);}};
  const result=await runPreparedWorkerCandidateReply({requestId:f.context.input.requestId,requestText:f.context.input.messages[0].text,route:f.options.routeConfig,qualifiedReservationist:{input:f.context.input,dependencies:deps},signal:f.context.signal});
  expect(originalSeen).toBe(true);expect(result.textBody).toContain('Parking is available.');
  await expect(runPreparedWorkerCandidateReply({requestId:f.context.input.requestId,requestText:'same',route:f.options.routeConfig,qualifiedReservationist:{input:f.context.input,dependencies:deps},deadlineAt:f.context.input.clock.deadlineAt-1})).rejects.toThrow('deadline_binding');
 });
});

describe('explicit installed Azure draft adapter',()=>{
 function azureFixture(){const f=fixture(),route={...f.route,protocol:'azure-foundry-responses',egress:'azure-foundry'},reserveCalls=vi.fn(async()=>{}),invoke=vi.fn(async()=>({modelId:'gpt-6-luna',output:{facts:[],tasks:[{id:'parking',kind:'question',factIds:[],source:{attachmentId:'message:inbound',sourceHash:createHash('sha256').update(f.context.input.messages[0].text).digest('hex'),page:1,quote:f.context.input.messages[0].text}}],unresolvedAsks:[]},usage:{inputTokens:10,outputTokens:20,totalTokens:30,latencyMs:2,estimatedCostUsd:0.123,rateTableVersion:'actual-configured-cost'},provenance:{routeId:route.routeId,protocol:route.protocol,modelId:route.modelId,purpose:'draft',usageSource:'reported'}}));f.setCurrent({route,release:f.release});return{...f,options:{...f.options,routeConfig:{...f.options.routeConfig,route},modelAdapter:{reserveCalls,invoke}} as any,invoke,reserveCalls};}
 it('preserves hosted model provenance and actual cost without using the local transport',async()=>{const f=azureFixture(),supplied=await create(f.options)(f.context),result=await runReservationistRuntime(f.context.input,supplied.dependencies);expect(result.textBody).toContain('Parking is available.');expect(f.invoke).toHaveBeenCalledTimes(1);expect(f.transport).not.toHaveBeenCalled();expect(supplied.collectUsage()).toMatchObject({known:true,estimatedCostUsd:0.123,rateTableVersions:['actual-configured-cost']});});
 it.each(['missing-adapter','wrong-protocol','false-egress'])('rejects invalid %s configuration before dispatch',async kind=>{const f=azureFixture();if(kind==='missing-adapter')delete f.options.modelAdapter;if(kind==='wrong-protocol')f.options.routeConfig.route.protocol='hosted-anything';if(kind==='false-egress')f.options.routeConfig.route.egress='none';await expect(async()=>create(f.options)(f.context)).rejects.toThrow();expect(f.invoke).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();});
 it.each(['purpose','route','protocol','model','unreported'])('denies mismatched %s response provenance',async kind=>{const f=azureFixture();const result=await f.invoke();f.invoke.mockClear();if(kind==='purpose')result.provenance.purpose='extraction';if(kind==='route')result.provenance.routeId='foreign';if(kind==='protocol')result.provenance.protocol='in_process';if(kind==='model')result.modelId='foreign';if(kind==='unreported')result.provenance.usageSource='unknown';f.invoke.mockResolvedValue(result);const supplied=await create(f.options)(f.context);await expect(supplied.dependencies.plan(f.context.input,f.context.signal)).rejects.toThrow(/provenance/);expect(supplied.collectUsage()).toMatchObject({known:false,estimatedCostUsd:null});});
});
it('passes a trusted recorded source clock without exposing it to model extraction inputs',async()=>{const f=fixture(),at='2026-09-30T10:00:00Z',recorded=Date.parse('2026-10-05T13:44:07.793Z');f.context.input.trigger.at=at;f.context.input.messages[0].at=at;f.context.input.clock.causalAt=at;const original=JSON.stringify(f.context.input);let viewTime='';f.services.resolveTaskAnswer=async(ctx:any)=>{viewTime=ctx.evaluateSourceAt();return{kind:'parking',value:true,disclosure:'guest',evidenceRefs:['property:parking'],preparedFacts:[{key:'parking',label:'Parking',value:true,source:'property',authority:'authorized',status:'known',evidenceRef:'property:parking',scopeVerified:true,disclosure:'guest'}]};};const supplied=await create({...f.options,currentReadEvaluation:true,currentReadEvaluationClock:()=>recorded})(f.context),result=await runReservationistRuntime(f.context.input,supplied.dependencies);expect(viewTime).toBe(new Date(recorded).toISOString());expect(result.sourceEvaluatedAt).toBe(viewTime);expect(f.transport).toHaveBeenCalledOnce();expect(JSON.stringify(f.context.input)).toBe(original);});
it('rejects replacement of the installed source-evaluation clock before model dispatch',async()=>{const f=fixture(),options:any={...f.options,currentReadEvaluation:true,currentReadEvaluationClock:()=>Date.now()},supplied=await create(options)(f.context);options.currentReadEvaluationClock=()=>Date.now()-1000;await expect(supplied.dependencies.plan(f.context.input,f.context.signal)).rejects.toThrow(/configuration changed/);expect(f.transport).not.toHaveBeenCalled();});
