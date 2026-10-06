import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {expect,it,vi} from 'vitest';

it.each(['matched','foreign_owner','other_query','changed_bytes','foreign_worker'] as const)('uses an original bounded standalone party receipt: %s',async mode=>{
 const cwd=process.cwd(),root=await mkdtemp(resolve('../../.private/recorded-party-synthetic-'));
 try{
  const directory=join(root,'.private/pms-pipeline/party-lookup/out/capture'),inventory=join(root,'.private/reservationist-recovery-20261004/reusable-product-20261005');
  await mkdir(directory,{recursive:true});await mkdir(inventory,{recursive:true});
  const bytes=Buffer.from(JSON.stringify({outcome:'no_match',candidates:[],evidenceDirectory:directory}));
  await writeFile(join(directory,'result.json'),mode==='changed_bytes'?Buffer.concat([bytes,Buffer.from(' ')]):bytes);
  const at=new Date(Date.now()-1000).toISOString();
  const receipt={ownerRef:mode==='foreign_owner'?'foreign':'transport-centurion',caseId:'m',request:{kind:'organization',query:{organizationName:'Requested company'}},sha256:createHash('sha256').update(bytes).digest('hex'),outcome:'no_match',evidenceDirectory:directory,completedAt:at,currentReadOnlyQualification:true,historicalTruth:false,pmsWrite:false,modelRequests:0};
  await writeFile(join(inventory,mode==='foreign_worker'?'ordinary-worker-foreign.json':'native-party-receipt.json'),JSON.stringify(mode==='foreign_worker'?{caseId:'m',runtimeInput:{requestId:'m',authorizationScope:{ownerRef:'foreign'}},tools:[{...receipt,tool:'party'}]}:receipt));
  const {createRecordedPmsBoundary}=await import(resolve(cwd,'../../.private/reservationist-recovery-20261004/reusable-product-20261005/recorded-pms-boundary-v1/source.mts'));
  process.chdir(root);const capture=vi.fn(async()=>{}),reader=await createRecordedPmsBoundary({causalAt:'2026-09-01T00:00:00Z',ownerRef:'transport-centurion',onCapture:capture});
  const call=()=>reader.readParty('organization',mode==='other_query'?'Other company':'Requested company',new AbortController().signal);
  if(mode==='matched'){expect(await call()).toMatchObject({outcome:'no_match',query:'Requested company',observedAt:at});expect(capture).toHaveBeenCalledOnce();reader.advanceObservation(new Date(Date.parse(at)+1000).toISOString());expect(await call()).toMatchObject({observedAt:at,outcome:'no_match'});expect(reader.evaluateClock()).toBe(Date.parse(at)+1000);}
  else {await expect(call()).rejects.toThrow();expect(capture).not.toHaveBeenCalled();}
 }finally{process.chdir(cwd);await rm(root,{recursive:true,force:true});}
});

it.each(['no_match','unavailable'] as const)('retains a complete native negative quote observation: %s',async outcome=>{
 const cwd=process.cwd(),root=await mkdtemp(resolve('../../.private/recorded-negative-quote-'));
 try{
  const {normalizeQuoteRequest}=await import('../tooling/playwright-quote/quote-contract.mjs');
  const request=normalizeQuoteRequest({schemaVersion:2,propertyCode:'HRCEN',arrivalDate:'2026-10-10',departureDate:'2026-10-16',rooms:[{id:'1',quantity:1,adults:1,children:0,childAges:[],required:{boardBases:['dinner_bed_breakfast']}}],details:'summary',maxOptionsPerGroup:50,search:{includeRestricted:false,includeAlternatives:false,salesStrategy:'BAR'}}).request;
  const at=new Date(Date.now()-1000).toISOString(),dir=join(root,'.private/playwright-quote/capture');await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'result.json'),JSON.stringify({schemaVersion:2,outcome,requested:request,observedAt:at,audit:{status:'complete'},groups:[{id:'1',request:request.rooms[0],outcome,options:[],completeness:{search:'complete',requiredFacts:'complete'}}]}));
  const {createRecordedPmsBoundary}=await import(resolve(cwd,'../../.private/reservationist-recovery-20261004/reusable-product-20261005/recorded-pms-boundary-v1/source.mts'));process.chdir(root);
  const onCapture=vi.fn(async()=>{}),reader=await createRecordedPmsBoundary({causalAt:'2026-09-01T00:00:00Z',onCapture});
  const{normalizedFrom,...wire}=request;expect((await reader.readQuote(wire,new AbortController().signal)).result.outcome).toBe(outcome);expect(onCapture).toHaveBeenCalledOnce();
 }finally{process.chdir(cwd);await rm(root,{recursive:true,force:true});}
});
