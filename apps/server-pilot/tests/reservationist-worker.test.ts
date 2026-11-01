import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { __setDbForTests } from '../src/db/client.js';
import { aiDraftGeneration, aiWorkflowRun, attachment, mailDraft, mailThread, message } from '../src/db/schema/mail.js';
import { workItem } from '../src/db/schema/work.js';
import { CENTURION_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { quoteDigest } from '../src/quote-proposal/quote-revision.js';
import type { DraftModelRouteConfig } from '../src/ai/draft-route-factory.js';
import { RESERVATIONIST_RUNTIME_VERSION } from '../src/ai/reservationist-runtime.js';
import { runReservationistWorkerCandidate } from '../src/ai/reservationist-worker.js';
import { refreshThreadWork } from '../src/ai/work-items.js';
import { createReservationistDependencies } from '../src/ai/reservationist-execution.js';
import { createInstalledReservationistProvider } from '../src/ai/reservationist-installed-provider.js';
import { buildReservationistReviewSummary } from '../src/trpc/routes/drafts.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();
describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('reservationist worker candidate', () => {
  it.each(['question', 'no_action', 'source_review', 'missing_file', 'installed'] as const)('persists the causal mailbox outcome for %s', async (mode) => {
    await withSeededTestDb(async (db) => {
      __setDbForTests({ db, conn: null as never });
      try {
        const threadId=randomUUID(),previousId=randomUUID(),previousReplyId=randomUUID(),previousPop3Id=randomUUID(),currentId=randomUUID(),generationId=randomUUID(),runId=randomUUID();
        const at=new Date(Date.now()-60_000),previousAt=new Date(at.getTime()-60_000),deadlineAt=new Date(Date.now()+180_000);
        const arrival='I will like to check in by 3:00pm.',shuttle='Is an airport shuttle available?';
        const text=mode==='installed'?`${arrival} ${shuttle}`:mode==='question'?shuttle:mode==='source_review'||mode==='missing_file'?'Please see attached.':'Thank you.';
        const s3=new FakeS3Storage(),fileId=randomUUID(),body=Buffer.from('synthetic rooming workbook');
        const modelPrompts:string[]=[];
        await db.insert(mailThread).values({id:threadId,transportId:TRANSPORT_ID,threadRootId:`<${threadId}@example.invalid>`,latestMessageAt:at});
        await db.insert(message).values([
          {id:previousId,transportId:TRANSPORT_ID,threadId,direction:'inbound',fromAddress:'guest@example.invalid',toAddresses:['centurion@legacyhotels.co.za'],textBody:'Previous context.',receivedAt:previousAt},
          {id:currentId,transportId:TRANSPORT_ID,threadId,direction:'inbound',fromAddress:'guest@example.invalid',toAddresses:['centurion@legacyhotels.co.za'],textBody:text,receivedAt:at},
        ]);
        if(mode==='installed')await db.insert(message).values([
          {id:randomUUID(),transportId:TRANSPORT_ID,threadId,direction:'outbound',fromAddress:'centurion@legacyhotels.co.za',toAddresses:['guest@example.invalid'],textBody:'Unsent synthetic reply.',receivedAt:previousAt,sentAt:null},
          {id:randomUUID(),transportId:TRANSPORT_ID,threadId,direction:'outbound',fromAddress:'centurion@legacyhotels.co.za',toAddresses:['guest@example.invalid'],textBody:'Sent after the synthetic request.',receivedAt:previousAt,sentAt:new Date(at.getTime()+20_000)},
          {id:previousReplyId,transportId:TRANSPORT_ID,threadId,direction:'outbound',fromAddress:'centurion@legacyhotels.co.za',toAddresses:['guest@example.invalid'],textBody:'Earlier synthetic reply, synced late.',receivedAt:new Date(at.getTime()+20_000),sentAt:new Date(previousAt.getTime()+30_000)},
          {id:previousPop3Id,transportId:TRANSPORT_ID,threadId,direction:'outbound',fromAddress:'centurion@legacyhotels.co.za',toAddresses:['guest@example.invalid'],textBody:'Earlier imported reply.',pop3Uidl:'earlier-pop3',receivedAt:previousAt,sentAt:null,createdAt:new Date(previousAt.getTime()+10_000)},
          {id:randomUUID(),transportId:TRANSPORT_ID,threadId,direction:'outbound',fromAddress:'centurion@legacyhotels.co.za',toAddresses:['guest@example.invalid'],textBody:'Later imported reply with backdated header.',pop3Uidl:'later-pop3',receivedAt:previousAt,sentAt:previousAt,createdAt:new Date(at.getTime()+20_000)},
        ]);
        let dismissedItemId:string|undefined;
        if(mode==='question'||mode==='source_review'){
          const newerId=randomUUID();
          await db.insert(message).values({id:newerId,transportId:TRANSPORT_ID,threadId,direction:'inbound',fromAddress:'guest@example.invalid',toAddresses:['centurion@legacyhotels.co.za'],textBody:'A later request.',receivedAt:new Date(at.getTime()+10_000)});
          const [older]=await db.insert(workItem).values({transportId:TRANSPORT_ID,threadId,sourceMessageId:currentId,kind:'other'}).returning();
          dismissedItemId=older!.id;
          await db.insert(workItem).values({transportId:TRANSPORT_ID,threadId,sourceMessageId:newerId,kind:'quote'});
          await refreshThreadWork(db,{transportId:TRANSPORT_ID,threadId});
          expect((await db.select().from(workItem).where(eq(workItem.id,dismissedItemId)))[0]?.status).toBe('dismissed');
        }
        if(mode==='source_review'||mode==='missing_file'){
          const key='attachments/'+currentId+'/rooms.xlsx',mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          if(mode==='source_review')await s3.putObject({key,body,contentType:mimeType});
          await db.insert(attachment).values({id:fileId,messageId:currentId,filename:'rooms.xlsx',mimeType,sizeBytes:body.length,s3Key:key,sha256:mode==='source_review'?createHash('sha256').update(body).digest('hex'):null});
        }
        if(mode==='installed'){
          const key='attachments/'+currentId+'/note.txt',body=Buffer.from('Synthetic attachment: arrival note.');
          await s3.putObject({key,body,contentType:'text/plain'});
          await db.insert(attachment).values({id:fileId,messageId:currentId,filename:'note.txt',mimeType:'text/plain',sizeBytes:body.length,s3Key:key,sha256:createHash('sha256').update(body).digest('hex')});
        }
        await db.insert(aiDraftGeneration).values({id:generationId,transportId:TRANSPORT_ID,threadId,requestedByUserId:CENTURION_USER_ID,contextMessageIds:[currentId],model:'gpt-6-luna',promptVersion:'draft-v1',status:'queued'});
        const [run]=await db.insert(aiWorkflowRun).values({id:runId,transportId:TRANSPORT_ID,threadId,triggerMessageId:currentId,generationId,runKind:'candidate_draft',idempotencyKey:runId,modelId:'gpt-6-luna',promptVersion:'draft-v1',state:'running',claimOwner:'worker',claimToken:'token',deadlineAt}).returning();
        const route:DraftModelRouteConfig={
          route:{routeId:'synthetic',purpose:'draft',protocol:'in_process',access:'current_app',egress:'none',retention:'bounded',usage:'reported',modelId:'gpt-6-luna'},
          release:{releaseId:'synthetic',releaseVersion:'1',sourceRevision:'synthetic',fingerprint:'synthetic',purpose:'draft',capabilityFamilyVersions:{reservationist:RESERVATIONIST_RUNTIME_VERSION},issuedAt:new Date(Date.now()-60_000).toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),withdrawn:false},
          transport:async()=>({output:{},usage:{inputTokens:0,outputTokens:0,latencyMs:0}}),
          reservationist:mode==='installed'?createInstalledReservationistProvider({invoke:async(request)=>{
            modelPrompts.push(request.userPrompt);
            const sourceHash=createHash('sha256').update(text).digest('hex');
            const source=(quote:string)=>({attachmentId:`message:${currentId}`,sourceHash,page:1,quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length});
            return {modelId:'gpt-6-luna',output:{facts:[],tasks:[{id:'arrival',kind:'question',factIds:[],source:source(arrival)},{id:'shuttle',kind:'question',factIds:[],source:source(shuttle)}],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,totalTokens:2,latencyMs:1,estimatedCostUsd:0,rateTableVersion:'synthetic'}};
          }}):async(context)=>mode==='source_review'||mode==='missing_file'?createReservationistDependencies({
            adapter:{invoke:async()=>({modelId:'gpt-6-luna',output:{facts:[],tasks:[],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,totalTokens:2,latencyMs:1,estimatedCostUsd:0,rateTableVersion:'synthetic'}})},
            admissions:context.admissions,header:{attention:'',company:'',clientEmail:'',clientTelephone:'',agency:'',signerName:'',signerEmail:''},converter:{url:'unused'},services:{},
          }):({
            dependencies:{
              plan:async(input)=>{
                expect(input.messages.map(item=>item.id)).toEqual([previousId,currentId]);
                const trigger=input.messages.find(item=>item.id===currentId)!;
                const sourceHash=createHash('sha256').update(trigger.text).digest('hex');
                if(mode==='no_action')return {tasks:[],facts:[],noAction:{kind:'no_current_request',modelSelectionCompleted:true,inputDigest:quoteDigest(input),triggerMessageId:currentId,sourceHash}};
                return {tasks:[{id:'shuttle',kind:'question',required:true,source:{attachmentId:`message:${currentId}`,sourceHash,page:1,start:0,end:trigger.text.length,quote:trigger.text}}],facts:[]};
              },
              execute:async()=>({tasks:[{id:'shuttle',status:'needs_clarification',guestText:'Staff must verify shuttle availability.',evidenceRefs:[`message:${currentId}`]}],artifacts:[],quoteRefs:[],packets:[],errors:[],approvedGuestClauses:{shuttle:'Staff must verify shuttle availability.'}}),
              verifyGuestClause:async()=>true,
            },
            collectGeneratedArtifacts:()=>[],
          }),
        };
        const result=await runReservationistWorkerCandidate({db,run:run!,fence:{runId,claimOwner:'worker',claimToken:'token',deadlineAt},route,replyTo:'guest@example.invalid',subject:'Re: Booking',signal:new AbortController().signal,s3});
        expect(result.state).toBe('succeeded');
        if(dismissedItemId)expect((await db.select().from(workItem).where(eq(workItem.id,dismissedItemId)))[0]?.status).toBe('needs_you');
        const [saved]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,runId));
        const [generation]=await db.select().from(aiDraftGeneration).where(eq(aiDraftGeneration.id,generationId));
        const drafts=await db.select().from(mailDraft).where(eq(mailDraft.generationId,generationId));
        expect(saved?.state).toBe('succeeded');
        expect(generation?.contextMessageIds).toEqual(mode==='installed'?[previousId,previousPop3Id,previousReplyId,currentId]:[previousId,currentId]);
        if(mode==='no_action'){
          expect(generation?.outcome).toBe('no_action');
          expect(drafts).toHaveLength(0);
        }else if(mode==='source_review'||mode==='missing_file'){
          expect(generation?.outcome).toBe('needs_clarification');
          expect(drafts).toHaveLength(1);expect(drafts[0]?.textBody).toBe('');
          const review=buildReservationistReviewSummary(saved?.metrics?.reservationistResult,new Date(),[{sourceRef:fileId,messageId:currentId,filename:'rooms.xlsx'}]);
          expect(review?.staffActions).toContainEqual(expect.objectContaining({filename:'rooms.xlsx',text:mode==='source_review'?'rooms.xlsx: This attachment format could not be read.':'rooms.xlsx: This attachment could not be checked; open the original source.'}));
          if(mode==='missing_file')expect(saved?.metrics?.reservationistDraftSource?.attachments).toEqual([expect.objectContaining({attachmentId:fileId,sourceIdentity:'metadata_only'})]);
        }else if(mode==='installed'){
          expect(drafts).toHaveLength(1);
          expect(modelPrompts[0]).toContain('Synthetic attachment: arrival note.');
          expect(modelPrompts[0]).not.toContain('Unsent synthetic reply.');
          expect(modelPrompts[0]).not.toContain('Sent after the synthetic request.');
          expect(modelPrompts[0]).toContain('Earlier synthetic reply, synced late.');
          expect(modelPrompts[0]).toContain('Earlier imported reply.');
          expect(modelPrompts[0]).not.toContain('Later imported reply with backdated header.');
          expect(drafts[0]?.textBody).toContain('We have noted your request to check in by 3:00pm.');
          expect(saved?.metrics?.reservationistResult?.tasks).toEqual(expect.arrayContaining([
            expect.objectContaining({id:'arrival',status:'complete'}),
            expect.objectContaining({id:'shuttle',status:'needs_clarification'}),
          ]));
        }else{
          expect(drafts).toHaveLength(1);
          expect(drafts[0]?.textBody).toContain('Staff must verify shuttle availability.');
          expect(saved?.metrics).toMatchObject({reservationistResult:{readiness:'needs_clarification'},reservationistDraftSource:{triggerMessageId:currentId}});
        }
      } finally { __setDbForTests(null); }
    });
  });
});
