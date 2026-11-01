import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {quoteDigest} from '../src/quote-proposal/quote-revision.js';
import {runReservationistRuntime,VOUCHER_REVIEW_RECOVERY_REASON,type RuntimeSourceRecovery} from '../src/ai/reservationist-runtime.js';
import {hasOutstandingRequests} from '../src/ai/reservationist-task-completion.js';

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
 const review=buildReservationistReviewSummary(result,new Date(at));
 expect(review?.staffActions).toEqual([expect.objectContaining({kind:'voucher_review',text,sourceRef:'message:inbound',sourceHash,sourceKind:'message',messageId:'inbound',blockingQuote:false,status:'open',reason:expect.stringContaining('No voucher has been verified')})]);
 const {toDraftWire}=await import('../src/trpc/routes/draft-wire.js');
 const wire=toDraftWire({id:'draft',generationId:'generation',attachments:[],updatedAt:new Date(at),threadId:'thread',replyToMessageId:'inbound',toAddresses:[],ccAddresses:[],bccAddresses:[],subject:'Voucher review',textBody:'',status:'candidate',origin:'ai'} as any,false,review);
 expect(wire.reviewSummary?.staffActions).toMatchObject([{kind:'voucher_review',sourceRef:'message:inbound'}]);
});

it('retains the voucher review beside an independent selected task',async()=>{
 const input=makeInput(),task={id:'question',kind:'question',required:true,source:{attachmentId:'message:inbound',sourceHash,page:1,start:0,end:text.length,quote:text}},taskResult={id:'question',status:'needs_clarification' as const,guestText:'',evidenceRefs:[],disclosure:'staff_only' as const};
 const result=await runReservationistRuntime(input,{plan:async()=>({tasks:[task],facts:[],sourceRecoveries:[recovery]}),execute:async()=>({tasks:[taskResult],artifacts:[],quoteRefs:[],packets:[],errors:[],approvedGuestClauses:{question:''}})});
 expect(result.tasks).toHaveLength(1);expect(result.sourceRecoveries).toEqual([recovery]);expect(result.readiness).toBe('needs_clarification');expect(result.textBody).toBe('');
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
