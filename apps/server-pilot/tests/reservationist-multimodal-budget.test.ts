import {describe,it,expect} from 'vitest';
import {createBudgetedReplayAdapter,admitSourceQualification} from '../src/ai/reservationist-replay.js';
import {AzureLunaModelAdapter} from '../src/ai/bedrock/azure-luna.js';

const pdf=new Uint8Array(Buffer.from('%PDF-1.7 actual synthetic document'));
const request={modelId:'gpt-6-luna',systemPrompt:'Extract',userPrompt:'Synthetic',files:[{filename:'Synthetic.pdf',mediaType:'application/pdf',data:pdf}]};
const quota={version:'synthetic-context-2026-10-04',provider:'azure-foundry',modelId:'gpt-6-luna',ceilingMethod:'provider_input_limit',maxProcessedInputTokens:922000,sourceUrl:'https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning',sourceHash:'a'.repeat(64),observedAt:'2026-10-04T00:00:00Z',maxRequestBytes:20*1024*1024};
function fixture(){
 const admission:any={route:{routeId:'approved-azure-extraction',releaseId:'synthetic-release',modelId:'gpt-6-luna',purpose:'extraction',provider:'azure-foundry',deployment:'gpt-6-luna'},tokenLimits:{version:'v',maxInputTokens:922000,maxOutputTokens:100,maxModelCalls:2,reservedUsd:2},cost:{version:'synthetic-azure',inputUsdPerMillion:1,outputUsdPerMillion:2},multimodalQuota:{...quota}};
 let calls=0;const wires:any[]=[];const reply:any={input_tokens:100,output_tokens:50,output_tokens_details:{reasoning_tokens:40}};
 const fetch:typeof globalThis.fetch=async(_url,init)=>{calls++;wires.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({id:'resp',object:'response',created_at:1,status:'completed',model:'gpt-6-luna',output:[{id:'msg',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"facts":[]}',annotations:[]}]}],usage:reply}),{headers:{'content-type':'application/json'}});};
 const adapter=new AzureLunaModelAdapter({baseURL:'https://synthetic.invalid/openai/v1',apiKey:'synthetic',route:{routeId:admission.route.routeId,modelId:'gpt-6-luna',purpose:'extraction',protocol:'azure-foundry-responses'},cost:{...admission.cost,effectiveAt:'2026-10-01T00:00:00Z'},fetch});
 return{admission,adapter,reply,wires,calls:()=>calls,bounded:()=>createBudgetedReplayAdapter(adapter,admission)};
}
describe('explicit native PDF provider-ceiling budget',()=>{
 it('passes actual SDK PDF wire and charges each reported call while reserving the full processed input ceiling',async()=>{
  const f=fixture(),bounded=f.bounded();const first=await bounded.invoke(request),second=await bounded.invoke(request);
  expect(first.usage.estimatedCostUsd).toBe(0.0002);expect(second.usage.estimatedCostUsd).toBe(0.0002);expect(f.calls()).toBe(2);
  expect(f.wires[0].input[1].content.some((part:any)=>part.type==='input_file')).toBe(true);expect(f.wires[0].max_output_tokens).toBe(100);expect(f.wires[0].store).toBe(false);
  await expect(bounded.invoke(request)).rejects.toThrow(/call_limit/);expect(f.calls()).toBe(2);
 });
 it('requires the provider ceiling for native images and applies the combined media count and byte bounds',async()=>{
  const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')),image={filename:'actual.png',mediaType:'image/png' as const,data:png},input={...request,files:[],images:[image]};
  const absent=fixture();delete absent.admission.multimodalQuota;await expect(absent.bounded().invoke(input)).rejects.toThrow('multimodal_token_bound_unavailable');expect(absent.calls()).toBe(0);
  const accepted=fixture();await accepted.bounded().invoke(input);expect(accepted.wires[0].input[1].content.some((p:any)=>p.type==='input_image')).toBe(true);
  const count=fixture();await expect(count.bounded().invoke({...input,files:Array.from({length:8},()=>request.files[0])})).rejects.toThrow();expect(count.calls()).toBe(0);
  const bytes=fixture();bytes.admission.multimodalQuota.maxRequestBytes=png.length;await expect(bytes.bounded().invoke(input)).rejects.toThrow('multimodal_request_bytes_exceeded');expect(bytes.calls()).toBe(0);
  const malformed=fixture();await expect(malformed.bounded().invoke({...input,images:[{...image,data:new Uint8Array([1,2,3])}]})).rejects.toThrow();expect(malformed.calls()).toBe(0);
 });
 it('does not estimate PDF input tokens from raw document bytes',async()=>{
  const f=fixture();f.reply.input_tokens=922000;const result=await f.bounded().invoke(request);expect(result.usage.inputTokens).toBe(922000);expect(result.usage.estimatedCostUsd).toBe(0.9221);expect(f.calls()).toBe(1);
 });
 it('keeps PDFs denied without the explicit quota before any SDK call',async()=>{const f=fixture();delete f.admission.multimodalQuota;await expect(f.bounded().invoke(request)).rejects.toThrow(/multimodal/);expect(f.calls()).toBe(0);});
 it.each(['provider','model','ceiling-method','ceiling','source-url','source-hash','future-observation','missing-version','negative-bytes','oversized-bytes','input-limit','underreserve'])('denies %s admission before SDK calls',async key=>{
  const f=fixture(),q=f.admission.multimodalQuota;if(key==='provider')q.provider='openai';if(key==='model')q.modelId='gpt-5';if(key==='ceiling-method')q.ceilingMethod='bytes_estimate';if(key==='ceiling')q.maxProcessedInputTokens=100;if(key==='source-url')q.sourceUrl='https://example.invalid';if(key==='source-hash')q.sourceHash='invalid';if(key==='future-observation')q.observedAt='2030-01-01T00:00:00Z';if(key==='missing-version')q.version='';if(key==='negative-bytes')q.maxRequestBytes=-1;if(key==='oversized-bytes')q.maxRequestBytes=21*1024*1024;if(key==='input-limit')f.admission.tokenLimits.maxInputTokens=921999;if(key==='underreserve')f.admission.tokenLimits.reservedUsd=0.9221;
  expect(()=>f.bounded()).toThrow();expect(f.calls()).toBe(0);
 });
 it.each(['total-bytes','bad-pdf','nine-files','abort'])('denies %s before SDK calls',async key=>{
  const f=fixture(),input:any={...request};if(key==='total-bytes')f.admission.multimodalQuota.maxRequestBytes=pdf.byteLength;if(key==='bad-pdf')input.files=[{...request.files[0],data:new Uint8Array([1,2,3])}];if(key==='nine-files')input.files=Array.from({length:9},()=>request.files[0]);if(key==='abort'){const c=new AbortController();c.abort();input.signal=c.signal;}
  await expect(f.bounded().invoke(input)).rejects.toThrow();expect(f.calls()).toBe(0);
 });
 it('rejects quota mutation before dispatch even when it raises only the byte cap',async()=>{const f=fixture(),bounded=f.bounded();f.admission.multimodalQuota.maxRequestBytes-=1;await expect(bounded.invoke(request)).rejects.toThrow(/changed/);expect(f.calls()).toBe(0);});
 it('makes unknown spend terminal after mutation during an actual SDK PDF call',async()=>{
  const f=fixture(),invoke=f.adapter.invoke.bind(f.adapter);f.adapter.invoke=async input=>{const result=await invoke(input);f.admission.multimodalQuota.sourceHash='b'.repeat(64);return result;};const bounded=f.bounded();await expect(bounded.invoke(request)).rejects.toThrow(/changed/);await expect(bounded.invoke(request)).rejects.toThrow(/unknown/);expect(f.calls()).toBe(1);
 });
 it.each(['input-ceiling','missing-usage','wrong-protocol'])('makes %s terminal after a dispatched call',async key=>{
  const f=fixture();if(key==='input-ceiling')f.reply.input_tokens=922001;if(key==='missing-usage')delete f.reply.input_tokens;if(key==='wrong-protocol'){const invoke=f.adapter.invoke.bind(f.adapter);f.adapter.invoke=async input=>{const result=await invoke(input);result.provenance!.protocol='bedrock';return result;};}
  const bounded=f.bounded();await expect(bounded.invoke(request)).rejects.toThrow();await expect(bounded.invoke(request)).rejects.toThrow(/unknown/);expect(f.calls()).toBe(1);
 });
 it('validates the optional quota on historical source qualification without fabricating it',()=>{
  const f=fixture(),row:any={version:'v',coverage:'authentic',authorizationId:'auth',scopeDigest:'scope',inputHash:'input',sourceHashes:['b'.repeat(64)],toolVersion:'v',observedAt:'2026-10-04T00:00:00Z',route:f.admission.route,tokenLimits:f.admission.tokenLimits,multimodalQuota:{...quota}};
  expect(admitSourceQualification(row).multimodalQuota).toEqual(quota);row.multimodalQuota.maxProcessedInputTokens=100;expect(()=>admitSourceQualification(row)).toThrow();
 });
 it('preserves conservative text byte admission when no PDF is sent',async()=>{
  const f=fixture();delete f.admission.multimodalQuota;f.admission.tokenLimits.maxInputTokens=8192;const bounded=f.bounded();await expect(bounded.invoke({...request,files:[],userPrompt:'x'.repeat(8192)})).rejects.toThrow(/text_input/);expect(f.calls()).toBe(0);
 });
});
