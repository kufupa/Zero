import {
  mailThread,
  message,
  mailDraft,
  mailDraftRevision,
  aiWorkflowRun,
  aiDraftGeneration,
  attachment,
} from '../src/db/schema/mail.js';
import {buildRevisionProposalPdf} from '../src/quote-proposal/proposal-pdf.js';
import {syntheticRevision} from './helpers/synthetic-quote-revision.js';
import {callerFor} from './helpers/trpc-caller.js';
import {configureDraftArtifactStorage,configureInboundAttachmentIdentityReader,evaluateHmsCandidateFreshness,assertHmsDraftFreshForAction} from '../src/trpc/routes/drafts.js';
import {sealReservationistDraftSource,type ReservationistDraftSource} from '../src/ai/reservationist-draft-source.js';
import {typedResultDigest,loadLiveThreadStateVersion} from '../src/ai/drafts.js';
import {mkdir,writeFile} from 'node:fs/promises';
import type { DraftModelRouteConfig } from '../src/ai/draft-route-factory.js';
import type { RuntimeTaskResult } from '../src/ai/reservationist-runtime.js';
import { enqueueAiRun, claimNextAiRun } from '../src/ai/run-ledger.js';
import { withSeededTestDb, probeTestDb } from './helpers/test-db.js';
import { aiWorkerOwnerId, executeAiRun } from '../src/ai/worker.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { eq } from 'drizzle-orm';
if (!(await probeTestDb())) throw new Error('Reservationist worker requires disposable DB');
const priorMode = process.env.HMS_DRAFT_ENRICHMENT_MODE,
  priorRoute = process.env.AI_MODEL_ROUTE;
afterEach(() => {
  configureDraftArtifactStorage(null);
  configureInboundAttachmentIdentityReader(null);
  __setDbForTests(null);
  if (priorMode === undefined) delete process.env.HMS_DRAFT_ENRICHMENT_MODE;
  else process.env.HMS_DRAFT_ENRICHMENT_MODE = priorMode;
  if (priorRoute === undefined) delete process.env.AI_MODEL_ROUTE;
  else process.env.AI_MODEL_ROUTE = priorRoute;
});
async function seed(db: DB) {
  const threadId = randomUUID(),
    triggerId = randomUUID();
  await db.insert(mailThread).values({
    id: threadId,
    transportId: TRANSPORT_ID,
    threadRootId: 'synthetic-' + threadId,
    subject: 'Synthetic question',
    latestMessageAt: new Date(),
  });
  await db.insert(message).values({
    id: triggerId,
    threadId,
    transportId: TRANSPORT_ID,
    direction: 'inbound',
    fromAddress: 'Synthetic Guest <actual-trigger@example.com>',
    toAddresses: ['centurion@legacyhotel.com'],
    subject: 'Synthetic question',
    textBody: 'Please answer our question.',
    receivedAt: new Date(),
  });
  const run = await enqueueAiRun(
    {
      transportId: TRANSPORT_ID,
      threadId,
      triggerMessageId: triggerId,
      runKind: 'candidate_draft',
      idempotencyKey: 'reservationist:' + triggerId,
      modelId: 'synthetic-reservationist',
      promptVersion: 'reservationist-v1',
    },
    db,
  );
  const generationId = run.id + '-generation';
  await db.insert(aiDraftGeneration).values({
    id: generationId,
    threadId,
    transportId: TRANSPORT_ID,
    requestedByUserId: 'user-navaai',
    contextMessageIds: [triggerId],
    model: 'synthetic',
    promptVersion: 'reservationist-v1',
  });
  const claimed = await claimNextAiRun({
    ownerId: aiWorkerOwnerId('default'),
    lane: 'default',
    idempotencyPrefix: 'reservationist:' + triggerId,
  });
  expect(claimed?.id).toBe(run.id);
  return { threadId, triggerId, run };
}
function configuredRoute(
  provider: DraftModelRouteConfig['reservationist'],
  wording: ReturnType<typeof vi.fn>,
): DraftModelRouteConfig {
  return {
    route: {
      routeId: 'synthetic-approved',
      modelId: 'synthetic-reservationist',
      purpose: 'draft',
      protocol: 'in_process',
      access: 'current_app',
      egress: 'none',
      retention: 'bounded',
      usage: 'reported',
    },
    transport: wording as never,
    release: {
      releaseId: 'synthetic-release',
      releaseVersion: '1',
      sourceRevision: 'synthetic-code',
      fingerprint: 'a'.repeat(64),
      purpose: 'draft',
      capabilityFamilyVersions: { reservationist: 'reservationist-runtime-v1' },
      issuedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      withdrawn: false,
    },
    reservationist: provider,
  };
}
it.each(['unchanged','added_descriptor','selected_quote'] as const)('carries actual converter PDF through worker, disposable revision, API and promotion for browser byte proof (%s)', async (mutation) => {
  process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
  process.env.AI_MODEL_ROUTE = 'approved-local';
  await withSeededTestDb(async (db) => {
    __setDbForTests({ db, conn: null as never });
    const { threadId, triggerId, run } = await seed(db);
    const selectedRevision=await syntheticRevision(['100.01'],'Room Only R','SKNG',new Date().toISOString());
    const converted=await buildRevisionProposalPdf(selectedRevision,{attention:'Synthetic only',company:'Synthetic',clientEmail:'test@example.invalid',clientTelephone:'',agency:'Synthetic',signerName:'Test',signerEmail:'test@example.invalid'},{url:'http://127.0.0.1:39180'});
    const body = Buffer.from(converted.pdf),
      sha256 = createHash('sha256').update(body).digest('hex'),
      objects = new Map<string, Buffer>();
    const wording = vi.fn(() => {
      throw new Error('final wording must not run');
    });
    const provider = vi.fn(async (context) => {
      expect(context.transportId).toBe(TRANSPORT_ID);
      expect(context.requestedByUserId).toBe('user-navaai');
      expect(context.input.trigger.id).toBe(triggerId);
      expect(context.input.clock.sourceMode).toBe('current_read');
      expect(context.fence.claimToken).toBeTruthy();
      if(mutation==='added_descriptor')await db.insert(attachment).values({id:randomUUID(),messageId:triggerId,filename:'Late business source.pdf',mimeType:'application/pdf',sizeBytes:10,s3Key:'attachments/'+triggerId+'/late.pdf',isInline:false});
      return {
        artifactStorage: {
          stage: async (key: string, b: Buffer) => {
            objects.set(key, b);
          },
          read: async (key: string) => objects.get(key) ?? null,
        },
        collectGeneratedArtifacts: () => [
          {
            artifactRef: 'generated:quote',
            filename: 'quote.pdf',
            mimeType: 'application/pdf' as const,
            body,
            sha256,
          },
        ],
        dependencies: {
          verifyGuestClause: async (task: RuntimeTaskResult) => task.guestText === 'We can assist with your request.',
          plan: async () => ({
            tasks: [{ id: 'answer', kind: mutation==='selected_quote'?'quote':'question', required: true }],
            facts: [],
          }),
          execute: async () => ({
            tasks: [
              {
                id: 'answer',
                status: 'complete' as const,
                guestText: 'We can assist with your request.',
                evidenceRefs: mutation==='selected_quote'?[selectedRevision.groups[0]!.sourceRef,'generated:quote']:['generated:quote'],
              },
            ],
            approvedGuestClauses: { answer: 'We can assist with your request.' },
            artifacts: [
              {
                ref: 'generated:quote',
                sha256,
                sizeBytes: body.length,
                fileName: 'quote.pdf',
                mimeType: 'application/pdf',
              },
            ],
            requiredArtifactRefs: ['generated:quote'],
            quoteRefs: mutation==='selected_quote'?[selectedRevision.id]:[],
            quoteRevisions: mutation==='selected_quote'?[selectedRevision]:[],
            packets: [],
            rateComparisons: [],
      preparedFacts: mutation==='selected_quote'?[{key:'quote_total_answer',label:'Selected quotation total',value:{total:'ZAR 200.02',amount:'200.02',currency:'ZAR'},source:'hms' as const,authority:'authorized' as const,status:'known' as const,evidenceRef:selectedRevision.groups[0]!.sourceRef,scopeVerified:true,disclosure:'guest' as const}]:[],
      recipientPreparations: [],
      paymentComparisons: [],
      readReceipts: [],
      existingDocumentReceipts: [],
      readRecoveries: [],
      sourceRecoveries: mutation==='selected_quote'?[]:[{kind:'unresolved_fact' as const,reason:'Private source recovery: child ages missing',disclosure:'staff_only' as const}],
            errors: [],
          }),
          verifyArtifact: async () => true,
        },
      };
    });
    const result = await executeAiRun(run.id, {
      candidateDraftRoute: configuredRoute(provider, wording),
    });
    if(mutation==='added_descriptor'){expect(['retry_wait','dead_letter']).toContain(result.state);const [failed]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,run.id));expect(failed.lastError).toContain('draft_source_revalidation_failed');expect(await db.select().from(mailDraft).where(eq(mailDraft.threadId,threadId))).toHaveLength(0);return;}
    if(result.state!=='succeeded'){const [failed]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,run.id));throw new Error('joined_worker_failed:'+failed.lastError);}
    expect(result.state).toBe('succeeded');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(wording).not.toHaveBeenCalled();
    const [draft] = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
    expect(draft.toAddresses).toEqual(['actual-trigger@example.com']);
    expect(draft.textBody).toContain('We can assist with your request.');
    expect(draft.textBody).not.toContain('Private source recovery');expect(draft.htmlBody).not.toContain('Private source recovery');
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0]).toMatchObject({sourceHash:sha256});
    const [revision] = await db
      .select()
      .from(mailDraftRevision)
      .where(eq(mailDraftRevision.draftId, draft.id));
    expect(revision.attachments).toEqual(draft.attachments);
    const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
    expect(stored.metrics?.reservationistResult).toMatchObject({
      version: 1,
      readiness: mutation==='selected_quote'?'ready_for_staff_review':'needs_clarification',
      sourceRecoveries: mutation==='selected_quote'?[]:[{kind:'unresolved_fact' as const,reason:'Private source recovery: child ages missing',disclosure:'staff_only' as const}],
      rateComparisons: [],
      preparedFacts: mutation==='selected_quote'?[{key:'quote_total_answer',label:'Selected quotation total',value:{total:'ZAR 200.02',amount:'200.02',currency:'ZAR'},source:'hms' as const,authority:'authorized' as const,status:'known' as const,evidenceRef:selectedRevision.groups[0]!.sourceRef,scopeVerified:true,disclosure:'guest' as const}]:[],
      recipientPreparations: [],
      paymentComparisons: [],
      readReceipts: [],
      existingDocumentReceipts: [],
      readRecoveries: [],
      packets: [],
    });
    expect(stored.metrics?.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.generationId).toBe(draft.generationId);
    const [generation] = await db
      .select()
      .from(aiDraftGeneration)
      .where(eq(aiDraftGeneration.id, draft.generationId!));
    expect(generation.requestedByUserId).toBe('user-navaai');
    expect(sha256).toBe(converted.pdfHash);
    const liveThreadStateVersion=await loadLiveThreadStateVersion(db,{transportId:TRANSPORT_ID,threadId});
    await mkdir('../../.private/reservationist-recovery-20261004/ui-joined-proof',{recursive:true,mode:0o700});
    await writeFile('../../.private/reservationist-recovery-20261004/ui-joined-proof/promotion-freshness-diagnostic.json',JSON.stringify({pinned:generation.threadStateVersion,live:liveThreadStateVersion,evidence:generation.evidence,outcome:generation.outcome,freshness:evaluateHmsCandidateFreshness({threadStateVersion:generation.threadStateVersion,liveThreadStateVersion,evidence:generation.evidence??[]})},null,2),{mode:0o600});
    const caller=await callerFor('user-navaai',{db,requestedTransportId:TRANSPORT_ID});
    configureDraftArtifactStorage({stage:async(key,b)=>{objects.set(key,b);},read:async key=>objects.get(key)??null});
    const guard=()=>assertHmsDraftFreshForAction({db,transportId:TRANSPORT_ID,draft,conflict:'STALE_AI_CANDIDATE'});
    const originalMetrics=stored.metrics!;
    if(mutation==='selected_quote'){
      await expect(assertHmsDraftFreshForAction({db,transportId:TRANSPORT_ID,draft,conflict:'STALE_AI_CANDIDATE',now:new Date(Date.now()+2*3600000)})).rejects.toThrow();
      await expect(guard()).resolves.toBeUndefined();
      const originalResult=originalMetrics.reservationistResult!;
      for(const changed of [
        {...originalResult,quoteRevisionIds:['quote:missing']},
        {...originalResult,quoteRevisions:[{...selectedRevision,totalMinor:20003}]},
        {...originalResult,preparedFacts:[{...(originalResult.preparedFacts![0]!),value:{total:'ZAR 200.03',amount:'200.03',currency:'ZAR'}}]},
        {...originalResult,preparedFacts:[...originalResult.preparedFacts!,{key:'unsupported_hotel_permission',label:'Unsupported',value:true,source:'hms' as const,status:'known' as const,authority:'authorized' as const,disclosure:'guest' as const}]},
      ]){
        const resultDigest=typedResultDigest(changed,draft.attachments);
        const saved=(originalMetrics as typeof originalMetrics&{reservationistDraftSource:ReservationistDraftSource&{digest:string}}).reservationistDraftSource;
        const {digest:oldSeal,...source}=saved;
        await db.update(aiWorkflowRun).set({metrics:{...originalMetrics,resultDigest,reservationistResult:changed,reservationistDraftSource:sealReservationistDraftSource({...source,resultDigest})}}).where(eq(aiWorkflowRun.id,run.id));
        await expect(guard()).rejects.toThrow('STALE_AI_CANDIDATE');
      }
      await db.update(aiWorkflowRun).set({metrics:originalMetrics}).where(eq(aiWorkflowRun.id,run.id));
    }
    for(const altered of [{...originalMetrics,reservationistDraftSource:undefined},{...originalMetrics,resultDigest:'0'.repeat(64)},{...originalMetrics,reservationistDraftSource:{...(originalMetrics as Record<string,unknown>).reservationistDraftSource as object,transportId:'foreign'}}]){
      await db.update(aiWorkflowRun).set({metrics:altered}).where(eq(aiWorkflowRun.id,run.id));await expect(guard()).rejects.toThrow('STALE_AI_CANDIDATE');
    }
    await db.update(aiWorkflowRun).set({metrics:originalMetrics}).where(eq(aiWorkflowRun.id,run.id));
    await db.update(message).set({textBody:'Changed original request'}).where(eq(message.id,triggerId));await expect(guard()).rejects.toThrow('STALE_AI_CANDIDATE');
    await db.update(message).set({textBody:'Please answer our question.'}).where(eq(message.id,triggerId));
    const artifactKey=draft.attachments[0]!.s3Key,actualStored=objects.get(artifactKey)!;objects.set(artifactKey,Buffer.from('%PDF-changed'));
    await expect(guard()).rejects.toThrow('STALE_AI_CANDIDATE');objects.set(artifactKey,actualStored);
    await db.update(aiDraftGeneration).set({threadStateVersion:'0'.repeat(64)}).where(eq(aiDraftGeneration.id,generation.id));await expect(guard()).rejects.toThrow('STALE_AI_CANDIDATE');
    await db.update(aiDraftGeneration).set({threadStateVersion:generation.threadStateVersion}).where(eq(aiDraftGeneration.id,generation.id));
    let inboundReads=0;configureInboundAttachmentIdentityReader(async()=>{inboundReads++;throw new Error('unexpected read over bound');});
    const one={id:randomUUID(),messageId:triggerId,filename:'added.pdf',mimeType:'application/pdf',sizeBytes:1,s3Key:'attachments/'+triggerId+'/added',isInline:false};await db.insert(attachment).values(one);await expect(guard()).rejects.toThrow('STALE_AI_CANDIDATE');expect(inboundReads).toBe(0);await db.delete(attachment).where(eq(attachment.id,one.id));
    const excess=Array.from({length:257},(_,i)=>({id:randomUUID(),messageId:triggerId,filename:'business-'+i+'.pdf',mimeType:'application/pdf',sizeBytes:1,s3Key:'attachments/'+triggerId+'/'+i,isInline:false}));
    await db.insert(attachment).values(excess);await expect(guard()).rejects.toThrow('STALE_AI_CANDIDATE');expect(inboundReads).toBe(0);await db.delete(attachment).where(eq(attachment.messageId,triggerId));configureInboundAttachmentIdentityReader(null);
    const promoted=await caller.drafts.ensureEditableForReply({threadId,replyToMessageId:triggerId});
    const loaded=await caller.drafts.getArtifact({draftId:promoted.id,artifactRef:'generated:quote'});
    expect(loaded.base64).toBe(Buffer.from(converted.pdf).toString('base64'));
    expect(promoted.attachments[0].sourceHash).toBe(converted.pdfHash);
    const reloaded=await caller.drafts.get({id:promoted.id});
    expect(reloaded.content).toBe(promoted.content);
    expect(reloaded.attachments[0].sourceHash).toBe(converted.pdfHash);
    const receiptRoot='../../.private/reservationist-recovery-20261004/ui-joined-proof';
    await mkdir(receiptRoot,{recursive:true,mode:0o700});
    await writeFile(receiptRoot+(mutation==='selected_quote'?'/actual-selected-quote-worker-api-promotion.json':'/actual-worker-api-promotion.json'),JSON.stringify({version:'synthetic-actual-PDF-U7-join-v1',sourceKind:'actual_local_Gotenberg',pdfHash:converted.pdfHash,sizeBytes:converted.pdf.length,base64:loaded.base64,draft:reloaded,workerResult:stored.metrics?.reservationistResult,disposableDatabase:true,productionQualified:false},null,2),{mode:0o600});
    configureDraftArtifactStorage(null);

  });
},30000);
