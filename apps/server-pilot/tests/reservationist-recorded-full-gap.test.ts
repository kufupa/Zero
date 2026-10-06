import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {expect,it,vi} from 'vitest';
import {ReservationistTaskEvidenceUnavailable} from '../src/ai/reservationist-execution.js';

it.each(['business_gap','invalid_audit','wrong_request','changed_bytes'] as const)('preserves the exact recorded full capture business gap: %s',async mode=>{
 const {normalizeQuoteRequest,composeAllocation}=await import('../tooling/playwright-quote/quote-contract.mjs');
 const root=await mkdtemp(resolve('../../.private/recorded-full-gap-synthetic-'));
 const originalCwd=process.cwd();
 try{
  const dir=join(root,'.private/playwright-quote/capture');await mkdir(dir,{recursive:true});
  const request={propertyCode:'HRCEN',arrivalDate:'2026-10-12',departureDate:'2026-10-13',requestedCurrency:'ZAR',details:'full',rooms:['A','B'].map(id=>({id,quantity:1,adults:1,children:0,childAges:[],required:{roomCodes:['STWN'],rateCodes:['BAR']}}))};
  const normalized=normalizeQuoteRequest({schemaVersion:2,...request}).request;
  const groups=normalized.rooms.map((room:any)=>({id:room.id,request:room,outcome:'quote',completeness:{search:'complete',requiredFacts:'complete'},issues:[],options:[{id:'HRCEN:STWN:BAR',room:{code:'STWN',buildingCode:null},rate:{code:'BAR'},rateScope:'public',eligibility:'eligible',availability:'available',matchStatus:'match',held:false,issues:[],details:{status:'complete'},nightly:[{date:'2026-10-12',inventory:64,price:{amount:'1780.00',currency:'ZAR'}}]}]}));
  const at=new Date(Date.now()-1000).toISOString(),capture:any={schemaVersion:2,outcome:'partial',observedAt:at,requested:normalized,groups,allocation:composeAllocation(groups,'HRCEN'),issues:[],searchCompleteness:{status:'complete'},audit:{status:'complete'},evidenceDirectory:dir};
  if(mode==='invalid_audit')capture.audit.status='partial';
  const path=join(dir,'result.json');await writeFile(path,JSON.stringify(capture));
  const sourcePath=resolve(originalCwd,'../../.private/reservationist-recovery-20261004/reusable-product-20261005/recorded-pms-boundary-v1/source.mts');
  const {createRecordedPmsBoundary}=await import(sourcePath);
  process.chdir(root);
  const onCapture=vi.fn(async()=>{}),read=await createRecordedPmsBoundary({causalAt:new Date(Date.now()-5000).toISOString(),onCapture});
  if(mode==='changed_bytes'){
   await expect(read.readQuote({...request,arrivalDate:'2026-10-11'},new AbortController().signal)).rejects.toMatchObject({code:'recorded_quote_request_unavailable'});
   await writeFile(path,(await readFile(path,'utf8'))+' ');
  }
  let error:any;try{await read.readQuote(mode==='wrong_request'?{...request,arrivalDate:'2026-10-11'}:request,new AbortController().signal);}catch(e){error=e;}
  if(mode==='business_gap'){expect(error).toBeInstanceOf(ReservationistTaskEvidenceUnavailable);expect(error).toMatchObject({code:'native_quote_business_evidence_unavailable'});expect(onCapture).toHaveBeenCalledOnce();expect(read.evaluateClock()).toBe(Date.parse(at));}
  else if(mode==='changed_bytes'){expect(String(error)).toContain('recorded_native_bytes_changed');expect(onCapture).not.toHaveBeenCalled();}
  else{expect(error).toMatchObject({code:'recorded_quote_request_unavailable'});expect(onCapture).not.toHaveBeenCalled();}
  expect(capture.outcome).toBe('partial');
 }finally{process.chdir(originalCwd);await rm(root,{recursive:true,force:true});}
});
