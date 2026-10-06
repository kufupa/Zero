import {describe,it,expect,vi} from 'vitest';
import {AzureLunaModelAdapter} from '../src/ai/bedrock/azure-luna.js';
import {createAzureLunaModel} from '../src/ai/bedrock/luna.js';
import {createBudgetedReplayAdapter} from '../src/ai/reservationist-replay.js';
import {createReservationistDependencies} from '../src/ai/reservationist-execution.js';

const route={routeId:'approved-azure-extraction',modelId:'gpt-6-luna' as const,purpose:'extraction' as const,protocol:'azure-foundry-responses' as const};
const cost={version:'synthetic-azure-2026-10-04',effectiveAt:'2026-10-01T00:00:00Z',inputUsdPerMillion:1,outputUsdPerMillion:2};
const request={modelId:'gpt-6-luna',systemPrompt:'Extract source facts',userPrompt:'Synthetic request',maxOutputTokens:100,maxInputBytes:4096};
function fixture(){
 const response:any={id:'resp-synthetic',object:'response',created_at:1,status:'completed',model:'gpt-6-luna',output:[{id:'msg-synthetic',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"facts":[]}',annotations:[]}]}],usage:{input_tokens:100,output_tokens:50,output_tokens_details:{reasoning_tokens:40}}};
 const fetchImpl=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}}));
 const options={baseURL:'https://synthetic.invalid/openai/v1',apiKey:'synthetic-key',route:{...route},cost:{...cost},fetch:fetchImpl as typeof fetch};
 return{response,fetchImpl,options,adapter:()=>new AzureLunaModelAdapter(options)};
}
const budgetEvidence=()=>({route:{...route,releaseId:'synthetic-release',provider:'azure-foundry' as const,deployment:'gpt-6-luna'},tokenLimits:{version:'v',maxInputTokens:40000,maxOutputTokens:100,maxModelCalls:2,reservedUsd:1},cost});
describe('explicit Azure Luna adapter with the actual SDK',()=>{
 it('rejects an externally constructed same-model SDK route instead of stamping configured provenance',()=>{
  const f=fixture(),model=createAzureLunaModel({baseURL:'https://foreign.invalid/openai/v1',apiKey:'synthetic-key',fetch:f.fetchImpl as typeof fetch});
  expect(()=>new AzureLunaModelAdapter({...f.options,model} as any)).toThrow(/model.*inject|option/);expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(()=>new AzureLunaModelAdapter({...f.options,model:undefined} as any)).toThrow(/model.*inject|option/);
 });
 it('reports reasoning-inclusive SDK usage and physically uses the configured endpoint and key',async()=>{
  const f=fixture(),r=await f.adapter().invoke(request),[url,init]=f.fetchImpl.mock.calls[0]!;
  expect(String(url)).toBe('https://synthetic.invalid/openai/v1/responses');expect(new Headers(init?.headers).get('api-key')).toBe('synthetic-key');
  expect(r.provenance).toEqual({...route,usageSource:'reported'});expect(r.output).toEqual({facts:[]});
  expect(r.usage).toMatchObject({inputTokens:100,outputTokens:50,totalTokens:150,estimatedCostUsd:0.0002,rateTableVersion:cost.version});
 });
 it('uses actual Responses PDF wire, store false, max reasoning and output ceilings',async()=>{
  const f=fixture(),pdf=new Uint8Array(Buffer.from('%PDF-1.7 actual synthetic bytes'));
  await f.adapter().invoke({...request,files:[{filename:'Synthetic.pdf',mediaType:'application/pdf',data:pdf}]});
  const wire=JSON.parse(String(f.fetchImpl.mock.calls[0]![1]?.body));expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(wire.store).toBe(false);expect(wire.reasoning.effort).toBe('max');expect(wire.max_output_tokens).toBe(100);
  expect(JSON.stringify(wire)).toContain('input_file');expect(JSON.stringify(wire)).toContain(Buffer.from(pdf).toString('base64'));
 });
 it('sends original raster bytes as an actual Responses input_image, never a PDF file part',async()=>{
  const f=fixture(),png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
  await f.adapter().invoke({...request,images:[{filename:'source.png',mediaType:'image/png',data:png}]} as any);
  const wire=JSON.parse(String(f.fetchImpl.mock.calls[0]![1]?.body)),parts=wire.input[1].content;
  expect(parts.find((p:any)=>p.type==='input_image').image_url).toBe('data:image/png;base64,'+Buffer.from(png).toString('base64'));
  expect(parts.some((p:any)=>p.type==='input_file')).toBe(false);expect(wire.store).toBe(false);expect(wire.reasoning.effort).toBe('max');
 });
 it('accepts completed Responses reasoning alongside the completed JSON message',async()=>{
  const f=fixture();f.response.output.unshift({id:'reason-synthetic',type:'reasoning',summary:[],encrypted_content:'synthetic-encrypted-reasoning'});
  await expect(f.adapter().invoke(request)).resolves.toMatchObject({output:{facts:[]},usage:{outputTokens:50}});expect(f.fetchImpl).toHaveBeenCalledTimes(1);
 });
 it.each(['route','purpose','protocol','missing-endpoint','http-endpoint','negative-rate','missing-version','missing-date','future-date','nonfinite-rate'])('denies invalid %s constructor evidence',key=>{
  const f=fixture(),o:any=f.options;if(key==='route')o.route.routeId='';if(key==='purpose')o.route.purpose='shadow';if(key==='protocol')o.route.protocol='bedrock';if(key==='missing-endpoint')o.baseURL='';if(key==='http-endpoint')o.baseURL='http://synthetic.invalid';if(key==='negative-rate')o.cost.inputUsdPerMillion=-1;if(key==='missing-version')o.cost.version='';if(key==='missing-date')o.cost.effectiveAt='';if(key==='future-date')o.cost.effectiveAt='2030-01-01T00:00:00Z';if(key==='nonfinite-rate')o.cost.outputUsdPerMillion=Infinity;
  expect(()=>new AzureLunaModelAdapter(o)).toThrow();expect(f.fetchImpl).not.toHaveBeenCalled();
 });
 it.each(['model','pdf','input-bytes','output-limit','deadline','abort'])('denies invalid %s before SDK fetch',async key=>{
  const f=fixture(),input:any={...request};if(key==='model')input.modelId='global.openai.gpt-6-luna';if(key==='pdf')input.files=[{filename:'bad.pdf',mediaType:'application/pdf',data:new Uint8Array([1,2,3])}];if(key==='input-bytes')input.maxInputBytes=1;if(key==='output-limit')input.maxOutputTokens=0;if(key==='deadline')input.deadlineAt=Date.now()-1;if(key==='abort'){const c=new AbortController();c.abort();input.signal=c.signal;}
  await expect(f.adapter().invoke(input)).rejects.toThrow();expect(f.fetchImpl).not.toHaveBeenCalled();
 });
 it.each(['max_output_tokens','content_filter','incomplete-no-details','incomplete-message','failed','refusal','invalid-json'])('rejects unsuccessful %s after SDK fetch even with otherwise valid facts',async key=>{
  const f=fixture();if(['max_output_tokens','content_filter'].includes(key)){f.response.status='incomplete';f.response.incomplete_details={reason:key};f.response.output[0].status='incomplete';}
  if(key==='incomplete-no-details')f.response.status='incomplete';if(key==='failed')f.response.status='failed';
  if(key==='incomplete-message')f.response.output[0].status='incomplete';
  if(key==='refusal')f.response.output[0].content.push({type:'refusal',refusal:'Cannot comply'});
  if(key==='invalid-json')f.response.output[0].content[0].text='not valid JSON';
  await expect(f.adapter().invoke(request)).rejects.toThrow();expect(f.fetchImpl).toHaveBeenCalledTimes(1);
 });
 it.each(['missing-input','missing-output','negative','fraction','reasoning-over-total','cached-over-input','wrong-total','wrong-native-model','missing-native-model'])('rejects malformed raw SDK %s evidence after fetch',async key=>{
  const f=fixture();if(key==='missing-input')delete f.response.usage.input_tokens;if(key==='missing-output')delete f.response.usage.output_tokens;if(key==='negative')f.response.usage.input_tokens=-1;if(key==='fraction')f.response.usage.output_tokens=1.1;if(key==='reasoning-over-total')f.response.usage.output_tokens_details.reasoning_tokens=51;if(key==='cached-over-input')f.response.usage.input_tokens_details={cached_tokens:101};if(key==='wrong-native-model')f.response.model='gpt-5';if(key==='missing-native-model')delete f.response.model;
  if(key==='wrong-total')f.response.usage.total_tokens=149;
  await expect(f.adapter().invoke(request)).rejects.toThrow();expect(f.fetchImpl).toHaveBeenCalledTimes(1);
 });
 it('propagates caller cancellation when synthetic fetch ignores it',async()=>{
  const f=fixture();let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});f.fetchImpl.mockImplementation(()=>{started();return new Promise(()=>{});});
  const c=new AbortController(),pending=f.adapter().invoke({...request,signal:c.signal});await entered;c.abort();await expect(pending).rejects.toThrow();expect(f.fetchImpl).toHaveBeenCalledTimes(1);
 });
 it('seals caller route and cost and stops budgeted calls after unknown SDK usage',async()=>{
  const f=fixture(),adapter=f.adapter();f.options.cost.inputUsdPerMillion=99;f.options.route.routeId='mutated';const bounded=createBudgetedReplayAdapter(adapter,budgetEvidence());
  await expect(bounded.invoke(request)).resolves.toMatchObject({modelId:'gpt-6-luna',provenance:{routeId:route.routeId},usage:{estimatedCostUsd:0.0002}});
  delete f.response.usage.output_tokens;await expect(bounded.invoke(request)).rejects.toThrow();await expect(bounded.invoke(request)).rejects.toThrow(/unknown/);expect(f.fetchImpl).toHaveBeenCalledTimes(2);
 });
 it.each(['unknown-usage','incomplete'])('retains unknown spend and stops the shared collector after %s',async kind=>{
  const f=fixture();if(kind==='unknown-usage')delete f.response.usage.output_tokens;else{f.response.status='incomplete';f.response.incomplete_details={reason:'max_output_tokens'};}
  const adapter=createBudgetedReplayAdapter(f.adapter(),budgetEvidence()),factory=createReservationistDependencies({adapter,admissions:[],header:{} as any,converter:{url:'unused'},services:{}}),input:any={version:1,requestId:'request',propertyCode:'HRCEN',authorizationScope:{ownerRef:'owner',threadId:'thread'},trigger:{id:'request',at:'2026-10-04T10:00:00Z'},messages:[{id:'request',at:'2026-10-04T10:00:00Z',direction:'inbound',text:'Please quote.'}],authorizedArtifacts:[],clock:{causalAt:'2026-10-04T10:00:00Z',sourceAt:'2026-10-04T10:00:00Z',deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false,emailSend:false}};
  await expect(factory.dependencies.plan(input,new AbortController().signal)).rejects.toThrow();await expect(factory.dependencies.plan(input,new AbortController().signal)).rejects.toThrow(/unknown/);expect(f.fetchImpl).toHaveBeenCalledTimes(1);expect(factory.collectUsage()).toMatchObject({known:false,inputTokens:null,outputTokens:null,estimatedCostUsd:null});
 });
});
