import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {quoteDigest} from '../src/quote-proposal/quote-revision.js';
import {runReservationistRuntime,VOUCHER_REVIEW_RECOVERY_REASON,type RuntimeSourceRecovery} from '../src/ai/reservationist-runtime.js';
import {hasOutstandingRequestHistory,hasOutstandingRequests,outstandingSourceRecoveries,requestCompletionKeys,voucherReviewCompletionKeys} from '../src/ai/reservationist-task-completion.js';

const text='Please review the attached hotel voucher for our booking.';
const at='2026-10-04T10:00:00.000Z';
const sourceHash=createHash('sha256').update(text).digest('hex');
const recovery:RuntimeSourceRecovery={kind:'voucher_review',reason:VOUCHER_REVIEW_RECOVERY_REASON,sourceRef:'message:inbound',sourceHash,sourceKind:'message',messageId:'inbound',page:1,start:0,end:text.length,quote:text,disclosure:'staff_only'};
const makeInput=()=>({version:1 as const,requestId:'inbound',propertyCode:'HRCEN',trigger:{id:'inbound',at},messages:[{id:'inbound',at,direction:'inbound' as const,text}],authorizedArtifacts:[],requiredTaskKinds:[],requiredAskSpans:[],clock:{causalAt:at,sourceAt:at,deadlineAt:Date.now()+60_000},capabilities:{pmsWrite:false as const,emailSend:false as const}});

it('keeps an unmatched voucher request as source-bound staff review when no task was selected',async()=>{
 const input=makeInput(),execute=vi.fn();
 const result=await runReservationistRuntime(input,{plan:async current=>({tasks:[],facts:[],sourceRecoveries:[recovery],noAction:{kind:'source_review',modelSelectionCompleted:true,inputDigest:quoteDigest(current),triggerMessageId:'inbound',sourceHash}}),execute});
 expect(result.readiness).toBe('needs_clarification');expect(result.noAction).toBeUndefined();expect(result.tasks).toEqual([]);expect(result.textBody).toBe('');expect(result.sourceRecoveries).toEqual([recovery]);expect(execute).not.toHaveBeenCalled();
 expect(hasOutstandingRequests({...result,version:1},'run',{})).toBe(true);
 const {buildReservationistReviewSummary}=await import('../src/trpc/routes/drafts.js');
 const review=buildReservationistReviewSummary({...result,version:1},new Date(at));
 expect(review?.staffActions).toEqual([expect.objectContaining({kind:'voucher_review',text,sourceRef:'message:inbound',sourceHash,sourceKind:'message',messageId:'inbound',blockingQuote:false,status:'open',reason:expect.stringContaining('No voucher has been verified')})]);
 const {toDraftWire}=await import('../src/trpc/routes/draft-wire.js');
 const wire=toDraftWire({id:'draft',generationId:'generation',attachments:[],updatedAt:new Date(at),threadId:'thread',replyToMessageId:'inbound',toAddresses:[],ccAddresses:[],bccAddresses:[],subject:'Voucher review',textBody:'',status:'candidate',origin:'ai'} as any,false,review);
 expect(wire.reviewSummary?.staffActions).toMatchObject([{kind:'voucher_review',sourceRef:'message:inbound'}]);
});

it('retains the voucher review beside an independent selected task',async()=>{
 const question='Is parking available?',mixedText=`${text} ${question}`,mixedHash=createHash('sha256').update(mixedText).digest('hex'),baseInput=makeInput(),input={...baseInput,messages:[{...baseInput.messages[0]!,text:mixedText}]},source={attachmentId:'message:inbound',sourceHash:mixedHash,page:1,start:text.length+1,end:mixedText.length,quote:question},mixedRecovery={...recovery,sourceHash:mixedHash},task={id:'parking',kind:'question',required:true,source},taskResult={id:'parking',status:'complete' as const,guestText:'Parking is available.',evidenceRefs:['parking-policy'],disclosure:'guest' as const};
 const result=await runReservationistRuntime(input,{plan:async()=>({tasks:[task],facts:[],sourceRecoveries:[mixedRecovery]}),execute:async()=>({tasks:[taskResult],artifacts:[],quoteRefs:[],packets:[],errors:[],approvedGuestClauses:{parking:taskResult.guestText}}),verifyGuestClause:async()=>true});
 expect(result.tasks).toHaveLength(1);expect(result.sourceRecoveries).toEqual([mixedRecovery]);expect(result.readiness).toBe('needs_clarification');expect(result.textBody).toContain('Parking is available.');expect(result.textBody).not.toContain('voucher');
});

it('keeps voucher work outstanding after the independent task is acknowledged',()=>{
 const question='Is parking available?',mixedText=`${text} ${question}`,mixedHash=createHash('sha256').update(mixedText).digest('hex'),task={id:'parking',kind:'question',requestSource:{attachmentId:'message:inbound',sourceHash:mixedHash,page:1,start:text.length+1,end:mixedText.length,quote:question}},result={version:1,tasks:[task],sourceRecoveries:[{...recovery,sourceHash:mixedHash}]},key=requestCompletionKeys(result,'run').get('parking');
 expect(key).toBeDefined();
 expect(hasOutstandingRequests(result,'run',{reservationistHandledRequests:{[key!]:true}})).toBe(true);
});

it('keeps a source-bound voucher review through a later read of the same email',()=>{
 const earlier={id:'earlier',result:{version:1,tasks:[],sourceRecoveries:[recovery]}},reread={id:'reread',result:{version:1,tasks:[]},source:{messages:[{id:'inbound',sourceHash}]}};
 const expected={runId:'earlier',sourceRef:'message:inbound',kind:'voucher_review',id:`voucher:message:inbound:${sourceHash}:0:${text.length}`};
 expect(outstandingSourceRecoveries([reread,earlier])).toEqual([expected]);
 expect(hasOutstandingRequestHistory([reread,earlier],{})).toBe(true);
 expect(outstandingSourceRecoveries([{...reread,result:{version:1,tasks:[],sourceRecoveries:[recovery]}},earlier])).toEqual([{...expected,runId:'reread'}]);
});

it('acknowledges voucher citations independently and retains only unhandled cites after a reread',()=>{
 const messageText='Please review attached hotel voucher for guest A, then check enclosed hotel voucher for guest B.',hash=createHash('sha256').update(messageText).digest('hex');
 const cite=(quote:string)=>({...recovery,sourceHash:hash,start:messageText.indexOf(quote),end:messageText.indexOf(quote)+quote.length,quote});
 const first=cite('attached hotel voucher for guest A'),second=cite('enclosed hotel voucher for guest B');
 const result={version:1,tasks:[],sourceRecoveries:[first,second]},keys=voucherReviewCompletionKeys(result);
 const [firstId,firstKey]=[...keys.entries()][0]!,[secondId,secondKey]=[...keys.entries()][1]!;
 expect(firstId).not.toBe(secondId);
 const oneDone={reservationistHandledRequests:{[firstKey]:true}};
 expect(hasOutstandingRequests(result,'run',oneDone)).toBe(true);
 expect(outstandingSourceRecoveries([{id:'reread',result:{version:1,tasks:[]}},{id:'old',result}],oneDone)).toEqual([
  {runId:'old',sourceRef:'message:inbound',kind:'voucher_review',id:secondId},
 ]);
 const bothDone={reservationistHandledRequests:{[firstKey]:true,[secondKey]:true}};
 expect(hasOutstandingRequests(result,'rerun',bothDone)).toBe(false);
 expect(hasOutstandingRequestHistory([{id:'reread',result},{id:'old',result}],bothDone)).toBe(false);
 expect(outstandingSourceRecoveries([{id:'reread',result},{id:'old',result}],bothDone)).toEqual([]);
});

it.each([
 {...recovery,sourceHash:'b'.repeat(64)},
 {...recovery,sourceRef:'message:other'},
 {...recovery,end:text.length-1},
 {...recovery,quote:'Please review the attached folio.'},
])('rejects stale or malformed voucher recovery evidence',async invalid=>{
 const input=makeInput();
 await expect(runReservationistRuntime(input,{plan:async current=>({tasks:[],facts:[],sourceRecoveries:[invalid],noAction:{kind:'source_review',modelSelectionCompleted:true,inputDigest:quoteDigest(current),triggerMessageId:'inbound',sourceHash}}),execute:async()=>({tasks:[],artifacts:[],quoteRefs:[],packets:[],errors:[]})})).rejects.toThrow('no_action_unproven');
});
