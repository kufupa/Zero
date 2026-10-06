import {expect,it} from 'vitest';
import {createReservationistBusinessServices} from '../src/ai/reservationist-business-services.js';
import {resolveQuoteRevision} from '../src/quote-proposal/quote-revision.js';
import {ReservationistTaskEvidenceUnavailable} from '../src/ai/reservationist-execution.js';

it.each(['null','invalid'] as const)('distinguishes missing policy evidence from invalid policy authority: %s',async mode=>{
 const at=new Date().toISOString(),source={attachmentId:'message:m',sourceHash:'a'.repeat(64),page:1,quote:'Please quote 1 room for 2 adults, breakfast.',start:0,end:43};
 const f=(id:string,kind:string,value:any)=>({id,kind,value,source,verification:'text_verified',authority:'customer_claim',disclosure:'guest'});
 const c:any={task:{id:'q',kind:'quote',source,factIds:['dates','room','board']},facts:[f('dates','dates',{arrival:'2026-10-16',departure:'2026-10-17'}),f('room','room',{roomRef:'1',quantity:1,adults:2,childAges:[]}),f('board','board','breakfast')],input:{requestId:'m',propertyCode:'HRCEN',authorizationScope:{ownerRef:'owner',threadId:'thread'},clock:{sourceMode:'current_read',sourceAt:at},capabilities:{pmsWrite:false,emailSend:false},messages:[]},signal:new AbortController().signal};
 const {normalizeQuoteRequest}=await import('../tooling/playwright-quote/quote-contract.mjs');
 let reads=0;
 const services=createReservationistBusinessServices({authorizationId:'authorized-local',authorizeContext:async()=>true,signer:{signerName:'Local',signerEmail:''},resolvePolicy:async()=>mode==='null'?null:{propertyCode:'foreign',sourceHashes:[],authoredDates:[],families:[],vat:'included',levy:'included'} as any,readQuote:async(request:any)=>{reads++;const normalized=normalizeQuoteRequest({schemaVersion:2,...request}).request;return{ref:'native:'+reads,sha256:'b'.repeat(64),toolVersion:'native-v2',observedAt:at,request:normalized,result:{outcome:'quote',propertyCode:'HRCEN',groups:[{id:'1',request:normalized.rooms[0],completeness:{search:'complete',requiredFacts:'complete'},options:[{id:'HRCEN:SKNG:BAR',room:{code:'SKNG',buildingCode:null},rate:{code:'BAR'},board:'Bed & Breakfast R',eligibility:'verified',availability:'available',matchStatus:'match',held:false,appliedContext:{},totals:{taxInclusive:null},nightly:[{date:'2026-10-16',inventory:5,price:{amount:'2140.00',currency:'ZAR'}}]}]}]}} as any;}});
 const revisionInput=await services.resolveQuoteTask!(c);
 let failure:any;try{await resolveQuoteRevision(revisionInput);}catch(e){failure=e;}
 if(mode==='null'){expect(failure).toBeInstanceOf(ReservationistTaskEvidenceUnavailable);expect(failure).toMatchObject({code:'business_quote_policy_unavailable',staffTopics:['tax_inclusion']});}
 else{expect(failure).not.toBeInstanceOf(ReservationistTaskEvidenceUnavailable);expect(String(failure)).toContain('unqualified_inclusions');}
 expect(reads).toBe(2);
});
