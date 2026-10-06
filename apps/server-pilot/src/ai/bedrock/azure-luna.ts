import {validateReservationistRaster} from '../reservationist-attachment-input.js';
import type {ModelAdapter,ModelInvokeInput,ModelInvokeResult} from './adapter.js';
import {createAzureLunaModel,LUNA_PROVIDER_OPTIONS,type LunaLanguageModel} from './luna.js';
import {parseModelJson} from './bedrock.js';

export type AzureLunaAdapterOptions={
 baseURL:string;apiKey:string;
 route:{routeId:string;modelId:'gpt-6-luna';purpose:'extraction'|'judge'|'draft';protocol:'azure-foundry-responses'};
 cost:{version:string;effectiveAt:string;inputUsdPerMillion:number;outputUsdPerMillion:number};
 fetch?:typeof fetch;
};
export class AzureLunaModelAdapter implements ModelAdapter{
 private readonly model:LunaLanguageModel;
 private readonly route:AzureLunaAdapterOptions['route'];
 private readonly cost:AzureLunaAdapterOptions['cost'];
 constructor(options:AzureLunaAdapterOptions){
  if('model' in options)throw new Error('azure_luna_model_injection_denied');
  let endpoint:URL;try{endpoint=new URL(options.baseURL);}catch{throw new Error('azure_luna_endpoint_invalid');}
  const {route,cost}=options;
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||!options.apiKey||!route?.routeId||route.modelId!=='gpt-6-luna'||!['extraction','judge','draft'].includes(route.purpose)||route.protocol!=='azure-foundry-responses'||!cost?.version||!Number.isFinite(Date.parse(cost.effectiveAt))||Date.parse(cost.effectiveAt)>Date.now()||![cost.inputUsdPerMillion,cost.outputUsdPerMillion].every(n=>Number.isFinite(n)&&n>=0)||cost.inputUsdPerMillion+cost.outputUsdPerMillion<=0)throw new Error('azure_luna_route_or_cost_invalid');
  this.route=structuredClone(route);this.cost=structuredClone(cost);
  const responseURL=`${options.baseURL.replace(/\/+$/,'')}/responses`,fetchImpl=options.fetch??fetch;
  this.model=createAzureLunaModel({baseURL:options.baseURL,apiKey:options.apiKey,deployment:route.modelId,fetch:async(input,init)=>{
   if(new URL(input instanceof Request?input.url:String(input)).href!==new URL(responseURL).href)throw new Error('azure_luna_physical_endpoint_invalid');
   return fetchImpl(input,init);
  }});
  if(this.model.modelId!==route.modelId)throw new Error('azure_luna_model_identity_invalid');
 }
 async invoke(input:ModelInvokeInput):Promise<ModelInvokeResult>{
  if(input.modelId!==this.route.modelId)throw new Error('azure_luna_model_identity_invalid');
  if(input.maxOutputTokens!==undefined&&(!Number.isSafeInteger(input.maxOutputTokens)||input.maxOutputTokens<1||input.maxOutputTokens>32768))throw new Error('model_output_limit_invalid');
  const files=input.files??[],images=input.images??[];
  if(files.length+images.length>8)throw new Error('invalid_model_media_count');
  for(const image of images){if(!image.filename||!(image.data instanceof Uint8Array)||!['image/png','image/jpeg','image/webp'].includes(image.mediaType))throw new Error('invalid_model_image_input');validateReservationistRaster(image.data,image.mediaType);}
  if(files.length>8||files.some(file=>!file.filename||file.mediaType!=='application/pdf'||!(file.data instanceof Uint8Array)||file.data.byteLength>20*1024*1024||file.data.byteLength<=5||new TextDecoder().decode(file.data.subarray(0,5))!=='%PDF-'))throw new Error('invalid_model_file_input');
  const bytes=Buffer.byteLength(input.systemPrompt)+Buffer.byteLength(input.userPrompt)+Buffer.byteLength(JSON.stringify(input.responseSchema??{}))+[...files,...images].reduce((sum,file)=>sum+file.data.byteLength,0);
  if(input.maxInputBytes!==undefined&&(!Number.isSafeInteger(input.maxInputBytes)||input.maxInputBytes<1||bytes>input.maxInputBytes))throw new Error('model_input_limit_exceeded');
  input.signal?.throwIfAborted();const started=Date.now();
  if(input.deadlineAt!==undefined&&(!Number.isFinite(input.deadlineAt)||input.deadlineAt<=started))throw new Error('azure_luna_deadline_exceeded');
  const signals=[...(input.signal?[input.signal]:[]),...(input.deadlineAt!==undefined?[AbortSignal.timeout(Math.min(2147483647,Math.max(1,input.deadlineAt-started)))]:[])];
  const signal=signals.length?AbortSignal.any(signals):undefined;
  const result=await abortable(this.model.doGenerate({
   prompt:[{role:'system',content:input.systemPrompt},{role:'user',content:[{type:'text',text:input.userPrompt},...[...files,...images].map(file=>({type:'file' as const,mediaType:file.mediaType,filename:file.filename,data:{type:'data' as const,data:file.data}}))]}],
   ...(input.maxOutputTokens!==undefined?{maxOutputTokens:input.maxOutputTokens}:{}),
   responseFormat:input.responseSchema?{type:'json',schema:input.responseSchema as never,name:'mail_ai_output'}:{type:'json'},
   providerOptions:{openai:{...LUNA_PROVIDER_OPTIONS.openai,strictJsonSchema:false}},abortSignal:signal,
  }),signal);
  signal?.throwIfAborted();
  if(result.finishReason?.unified!=='stop')throw new Error('azure_luna_completion_incomplete');
  const body=typeof result.response?.body==='string'?JSON.parse(result.response.body):result.response?.body;
  const raw=body as {status?:unknown;output?:Array<{type?:unknown;status?:unknown;content?:Array<{type?:unknown}>}>;usage?:{total_tokens?:unknown}}|undefined;
  if(raw?.status!=='completed'||!Array.isArray(raw.output)||!raw.output.some(part=>part.type==='message')||raw.output.some(part=>part.type==='reasoning'?part.status!==undefined&&part.status!=='completed':part.type!=='message'||part.status!=='completed'||part.content?.some(item=>item.type!=='output_text')))throw new Error('azure_luna_completion_incomplete');
  if(result.response?.modelId!==this.route.modelId)throw new Error('azure_luna_observed_model_identity_invalid');
  const inTotal=result.usage?.inputTokens?.total,out=result.usage?.outputTokens,outTotal=out?.total;
  if(!Number.isSafeInteger(inTotal)||inTotal!<0||!Number.isSafeInteger(outTotal)||outTotal!<0||!Number.isSafeInteger(inTotal!+outTotal!)||out.reasoning!==undefined&&(!Number.isSafeInteger(out.reasoning)||out.reasoning<0||out.reasoning>outTotal!)||out.text!==undefined&&(!Number.isSafeInteger(out.text)||out.text<0||out.text>outTotal!)||out.reasoning!==undefined&&out.text!==undefined&&out.reasoning+out.text!==outTotal||input.maxOutputTokens!==undefined&&outTotal!>input.maxOutputTokens)throw new Error('azure_luna_usage_unknown');
  const inputUsage=result.usage.inputTokens;
  if([inputUsage.noCache,inputUsage.cacheRead,inputUsage.cacheWrite].some(n=>n!==undefined&&(!Number.isSafeInteger(n)||n<0||n>inTotal!)))throw new Error('azure_luna_usage_unknown');
  if(raw.usage?.total_tokens!==undefined&&raw.usage.total_tokens!==inTotal!+outTotal!)throw new Error('azure_luna_usage_unknown');
  const estimatedCostUsd=(inTotal!*this.cost.inputUsdPerMillion+outTotal!*this.cost.outputUsdPerMillion)/1000000;
  if(!Number.isFinite(estimatedCostUsd))throw new Error('azure_luna_usage_unknown');
  return{modelId:this.route.modelId,output:parseModelJson(result.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('')),usage:{inputTokens:inTotal!,outputTokens:outTotal!,totalTokens:inTotal!+outTotal!,latencyMs:Date.now()-started,estimatedCostUsd,rateTableVersion:this.cost.version},provenance:{...this.route,usageSource:'reported'}};
 }
}
function abortable<T>(operation:PromiseLike<T>,signal:AbortSignal|undefined):Promise<T>{
 const pending=Promise.resolve(operation);if(!signal)return pending;
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason??new Error('azure_luna_aborted'));signal.addEventListener('abort',abort,{once:true});pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});
}
