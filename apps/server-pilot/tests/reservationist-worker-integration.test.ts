import {
  mailThread,
  message,
  mailDraft,
  mailDraftRevision,
  aiWorkflowRun,
  aiDraftGeneration,
  attachment,
} from '../src/db/schema/mail.js';
import type { DraftModelRouteConfig } from '../src/ai/draft-route-factory.js';
import type { RuntimeTaskResult } from '../src/ai/reservationist-runtime.js';
import {createReservationistDependencies} from '../src/ai/reservationist-execution.js';
import { enqueueAiRun, claimNextAiRun } from '../src/ai/run-ledger.js';
import { withSeededTestDb, probeTestDb } from './helpers/test-db.js';
import { aiWorkerOwnerId, executeAiRun, runAiWorkerOnce } from '../src/ai/worker.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { eq } from 'drizzle-orm';
import {FakeS3Storage,setS3Storage,resetS3Storage} from '../src/storage/s3.js';
if (!(await probeTestDb())) throw new Error('Reservationist worker requires disposable DB');
const priorMode = process.env.HMS_DRAFT_ENRICHMENT_MODE,
  priorRoute = process.env.AI_MODEL_ROUTE;
afterEach(() => {
  resetS3Storage();
  __setDbForTests(null);
  if (priorMode === undefined) delete process.env.HMS_DRAFT_ENRICHMENT_MODE;
  else process.env.HMS_DRAFT_ENRICHMENT_MODE = priorMode;
  if (priorRoute === undefined) delete process.env.AI_MODEL_ROUTE;
  else process.env.AI_MODEL_ROUTE = priorRoute;
});
it.each(['valid','foreign-locator','changed-byte-hash'] as const)('checks actual worker raster acquisition and source recheck: %s',async mode=>{
 process.env.HMS_DRAFT_ENRICHMENT_MODE='off';process.env.AI_MODEL_ROUTE='approved-local';
 await withSeededTestDb(async db=>{
  __setDbForTests({db,conn:null as never});const{threadId,triggerId,run}=await seed(db),id=randomUUID(),body=Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z','base64'),hash=createHash('sha256').update(body).digest('hex'),key=`attachments/${mode==='foreign-locator'?'foreign-message':triggerId}/${id}`,storage=new FakeS3Storage('actual-worker-local-raster');
  setS3Storage(storage);await storage.putObject({key,body,contentType:'image/jpeg'});await db.insert(attachment).values({id,messageId:triggerId,filename:'business.jpg',mimeType:'image/jpeg',sizeBytes:body.length,s3Key:key});
  const provider=vi.fn(async context=>{
   expect(context.admissions).toHaveLength(1);expect(context.admissions[0]).toMatchObject({status:'admitted',reason:'visual_review_required',metadata:{sourceHash:hash,ownerRef:TRANSPORT_ID,threadId},draftReady:false});expect(context.admissions[0].bytes?.body).toEqual(body);
   return{collectGeneratedArtifacts:()=>[],dependencies:{verifyGuestClause:async(task:RuntimeTaskResult)=>task.guestText==='Staff must review the business image.',plan:async()=>{if(mode==='changed-byte-hash'){const changed=Buffer.from(body);changed[changed.length-1]^=1;storage.stored.set(key,{body:changed,contentType:'image/jpeg'});}return{tasks:[{id:'answer',kind:'question',required:true}],facts:[]};},execute:async()=>({tasks:[{id:'answer',status:'needs_clarification' as const,guestText:'Staff must review the business image.',evidenceRefs:[]}],approvedGuestClauses:{answer:'Staff must review the business image.'},artifacts:[],quoteRefs:[],packets:[],errors:[]})}};
  });
  const capture=vi.fn(async(value:any)=>{expect(value.result.assessment.ok).toBe(true);expect(value.result.digest).toMatch(/^[a-f0-9]{64}$/);expect(value.input.trigger.id).toBe(triggerId);value.input.messages[0].text='changed evaluator copy';value.result.textBody='forged evaluator copy';value.result.tasks[0].guestText='forged evaluator task';value.result.preparedFacts=[{key:'forged'}];});
  const result=await executeAiRun(run.id,{candidateDraftRoute:configuredRoute(provider,vi.fn(()=>{throw new Error('no extra model');})),onReservationistResult:capture} as any),drafts=await db.select().from(mailDraft).where(eq(mailDraft.threadId,threadId));
  if(mode==='valid'){const[stored]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,run.id));expect(result.state,stored.lastError??'no worker error').toBe('succeeded');expect(provider).toHaveBeenCalledTimes(1);expect(capture).toHaveBeenCalledOnce();expect(drafts).toHaveLength(1);expect(drafts[0].attachments).toEqual([]);expect(drafts[0].textBody).toContain('Staff must review the business image.');expect(JSON.stringify(stored.metrics)).not.toContain('forged evaluator');}
  else{expect(result.state).not.toBe('succeeded');expect(drafts).toHaveLength(0);expect(provider).toHaveBeenCalledTimes(mode==='foreign-locator'?0:1);}
 });
});
async function seed(db: DB, claim = true) {
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
      requestedByUserId: 'user-navaai',
      modelId: 'synthetic-reservationist',
      promptVersion: 'reservationist-v1',
    } as any,
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
  if (claim) {
  const claimed = await claimNextAiRun({
    ownerId: aiWorkerOwnerId('default'),
    lane: 'default',
    idempotencyPrefix: 'reservationist:' + triggerId,
  });
  expect(claimed?.id).toBe(run.id);
  }
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
it.each(['valid','changed-source','omitted-request'] as const)('runs verified no action through the ordinary worker without a draft: %s',async mode=>{
 process.env.HMS_DRAFT_ENRICHMENT_MODE='off';process.env.AI_MODEL_ROUTE='approved-local';
 await withSeededTestDb(async db=>{
  __setDbForTests({db,conn:null as never});const{threadId,triggerId,run}=await seed(db);
  const text=mode==='omitted-request'?'Thank you. Please book one room.':'Thank you for the quote. I will review it and revert to you on how we would like to proceed.';
  await db.update(message).set({textBody:text}).where(eq(message.id,triggerId));
  const invoke=vi.fn(async()=>({modelId:'synthetic-reservationist',output:{facts:[],tasks:[],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,totalTokens:2,estimatedCostUsd:0,rateTableVersion:'test'}})),tool=vi.fn(()=>{throw Error('no-action must not execute a business tool');}),storagePut=vi.fn(()=>{throw Error('no-action must not persist an artifact');});
  const provider=vi.fn(async context=>{
   if(mode==='changed-source')await db.update(message).set({textBody:'Please make a booking.'}).where(eq(message.id,triggerId));
   const factory=createReservationistDependencies({adapter:{invoke,reserveCalls:async()=>{}},admissions:context.admissions,header:{},converter:{url:'unused'},services:{resolveQuote:tool,resolveReadTask:tool},extractionMode:'task_first'} as any);
   return{...factory,artifactStorage:{put:storagePut,get:async()=>null,delete:async()=>{throw Error('no-action must not delete an artifact');}}};
  });
  const capture=vi.fn(async({result}:any)=>{expect(result.readiness).toBe('no_action');expect(result.tasks).toEqual([]);expect(result.packets).toEqual([]);});
  const result=await executeAiRun(run.id,{candidateDraftRoute:configuredRoute(provider,vi.fn(()=>{throw Error('no extra wording model');})),onReservationistResult:capture} as any),[stored]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,run.id)),drafts=await db.select().from(mailDraft).where(eq(mailDraft.threadId,threadId)),revisions=await db.select().from(mailDraftRevision).where(eq(mailDraftRevision.generationId,run.id+'-generation'));
  expect(invoke).toHaveBeenCalledOnce();expect(tool).not.toHaveBeenCalled();expect(storagePut).not.toHaveBeenCalled();expect(drafts).toHaveLength(0);expect(revisions).toHaveLength(0);
  if(mode==='valid'){expect(result.state,stored.lastError??'no error').toBe('succeeded');expect(stored.metrics).toMatchObject({preparedReplyOutcome:'no_action',businessWorkCompleted:0,draftPersisted:false,noAction:true});expect(capture).toHaveBeenCalledOnce();}
  else{expect(result.state).not.toBe('succeeded');expect(stored.lastError).toContain(mode==='changed-source'?'no_action_source_changed':'no_action_unproven');expect(stored.metrics).not.toMatchObject({noAction:true});}
 });
});
it('runs shared reservationist lower edge through actual worker with hash-bound artifact/result and trigger recipient', async () => {
  process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
  process.env.AI_MODEL_ROUTE = 'approved-local';
  await withSeededTestDb(async (db) => {
    __setDbForTests({ db, conn: null as never });
    const { threadId, triggerId, run } = await seed(db);
    const body = Buffer.from('%PDF-synthetic-worker'),
      sha256 = createHash('sha256').update(body).digest('hex'),
      objects = new Map<string, Buffer>();
    const wording = vi.fn(() => {
      throw new Error('final wording must not run');
    });
    const provider = vi.fn(async (context) => {
      expect(context.transportId).toBe(TRANSPORT_ID);
      expect(context.requestedByUserId).toBe('user-navaai');
      expect(context.input.trigger.id).toBe(triggerId);
      expect(context.input.messages.find((m: {id: string}) => m.id === triggerId)?.subject).toBe('Synthetic question');
      expect(context.input.messages.find((m: {id: string}) => m.id === triggerId)?.text).toBe('Please answer our question.');
      expect(context.input.clock.sourceMode).toBe('current_read');
      expect(context.fence.claimToken).toBeTruthy();
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
            tasks: [{ id: 'answer', kind: 'question', required: true }],
            facts: [],
          }),
          execute: async () => ({
            tasks: [
              {
                id: 'answer',
                status: 'complete' as const,
                guestText: 'We can assist with your request.',
                evidenceRefs: ['generated:quote'],
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
            quoteRefs: [],
            packets: [],
            rateComparisons: [],
      preparedFacts: [],
      recipientPreparations: [],
      paymentComparisons: [],
      readReceipts: [],
      existingDocumentReceipts: [],
      readRecoveries: [],
      sourceRecoveries: [{kind:'unresolved_fact' as const,reason:'Private source recovery: child ages missing',disclosure:'staff_only' as const}],
            errors: [],
          }),
          verifyArtifact: async () => true,
        },
      };
    });
    const result = await executeAiRun(run.id, {
      candidateDraftRoute: configuredRoute(provider, wording),
    });
    expect(result.state).toBe('succeeded');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(wording).not.toHaveBeenCalled();
    const [draft] = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
    expect(draft.toAddresses).toEqual(['actual-trigger@example.com']);
    expect(draft.textBody).toContain('We can assist with your request.');
    expect(draft.textBody).not.toContain('Private source recovery');expect(draft.htmlBody).not.toContain('Private source recovery');
    expect(draft.attachments).toHaveLength(1);
    expect((draft.attachments[0] as any).sourceHash).toBe(sha256);
    const [revision] = await db
      .select()
      .from(mailDraftRevision)
      .where(eq(mailDraftRevision.draftId, draft.id));
    expect(revision.attachments).toEqual(draft.attachments);
    const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
    expect(stored.metrics?.reservationistResult).toMatchObject({
      version: 1,
      readiness: 'needs_clarification',
      sourceRecoveries: [{kind:'unresolved_fact' as const,reason:'Private source recovery: child ages missing',disclosure:'staff_only' as const}],
      rateComparisons: [],
      preparedFacts: [],
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
  });
});
it('keeps absent provider on legacy deterministic skeleton and denies mismatched release capability', async () => {
  process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
  process.env.AI_MODEL_ROUTE = 'approved-local';
  await withSeededTestDb(async (db) => {
    __setDbForTests({ db, conn: null as never });
    const first = await seed(db);
    expect((await executeAiRun(first.run.id)).state).toBe('succeeded');
    const [legacy] = await db
      .select()
      .from(mailDraft)
      .where(eq(mailDraft.threadId, first.threadId));
    expect(legacy.textBody).toContain('manual review');
    const second = await seed(db),
      provider = vi.fn();
    const route = configuredRoute(provider, vi.fn());
    route.release!.capabilityFamilyVersions = { draft: 'legacy' };
    expect((await executeAiRun(second.run.id, { candidateDraftRoute: route })).state).not.toBe(
      'succeeded',
    );
    expect(provider).not.toHaveBeenCalled();
    const rows = await db.select().from(mailDraft).where(eq(mailDraft.threadId, second.threadId));
    expect(rows).toHaveLength(0);
  });
});
it('never invokes reservationist provider or artifact storage on shadow lane', async () => {
  process.env.HMS_DRAFT_ENRICHMENT_MODE = 'shadow';
  process.env.AI_MODEL_ROUTE = 'approved-local';
  await withSeededTestDb(async (db) => {
    __setDbForTests({ db, conn: null as never });
    const { threadId, run } = await seed(db);
    const provider = vi.fn(async () => {
      throw new Error('shadow provider forbidden');
    });
    await executeAiRun(run.id, { candidateDraftRoute: configuredRoute(provider, vi.fn()) });
    expect(provider).not.toHaveBeenCalled();
    const drafts = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
    expect(drafts).toHaveLength(0);
  });
});

it('persists source-bound local recipient proof without exposing addresses or claiming send',async()=>{
 process.env.HMS_DRAFT_ENRICHMENT_MODE='off';process.env.AI_MODEL_ROUTE='approved-local';
 await withSeededTestDb(async db=>{
  __setDbForTests({db,conn:null as never});const{threadId,triggerId,run}=await seed(db),text='Please copy all when you reply.';
  await db.update(message).set({textBody:text}).where(eq(message.id,triggerId));
  const {createReservationistDependencies}=await import('../src/ai/reservationist-execution.js'),{prepareReservationistRecipients}=await import('../src/ai/reservationist-recipient-preparation.js');
  const provider:NonNullable<DraftModelRouteConfig['reservationist']>=async context=>{
   const now=new Date().toISOString(),at=context.input.trigger.at,source={attachmentId:`message:${triggerId}`,sourceHash:createHash('sha256').update(text).digest('hex'),page:1 as const,quote:text,start:0,end:text.length},capture={version:'synthetic-current-mailbox',ownerRef:TRANSPORT_ID,observedAt:now,row:{id:TRANSPORT_ID,email:'self@hotel.invalid',send_from_config:{aliases:[]},is_active:true as const,updated_at:at}},serialized=JSON.stringify(capture)+'\n';
   const receipt=prepareReservationistRecipients({kind:'user_authorized_local_recipient_preparation',authorizationSource:'reservationist-recovery-user-20261004',taskId:'copy',requestId:context.input.requestId,ownerRef:TRANSPORT_ID,threadId,propertyCode:context.input.propertyCode,triggerMessageId:triggerId,taskSource:source,originalRequest:{text,at},headerProof:{ownerRef:TRANSPORT_ID,threadId,messageRef:triggerId,at,bodyHash:source.sourceHash,sourceRowHash:'a'.repeat(64),headers:{from:['actual-trigger@example.com'],to:['self@hotel.invalid'],cc:['private-review@example.invalid'],bcc:[]}},mailboxSource:{capture,serialized,sourceHash:createHash('sha256').update(serialized).digest('hex')},preparedAt:now,expiresAt:new Date(Date.parse(now)+600000).toISOString(),maxSourceAgeMs:1800000,historicalMailboxTruth:false,emailSend:false,productionDraftWrite:false});
   const factory=createReservationistDependencies({adapter:{invoke:async()=>({modelId:'gpt-6-luna',output:{facts:[],tasks:[{id:'copy',kind:'question',factIds:[],source}],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,totalTokens:2,latencyMs:1,estimatedCostUsd:0,rateTableVersion:'synthetic'}})},admissions:[],header:{attention:'Synthetic',company:'Test',clientEmail:'test@example.invalid',clientTelephone:'',agency:'Test',signerName:'Test',signerEmail:'test@example.invalid'},converter:{url:'unused'},services:{resolveRecipientPreparation:async()=>receipt,authorizeRecipientPreparation:async()=>true}});
   return {...factory,artifactStorage:{stage:async()=>{throw new Error('no artifact writes');},read:async()=>null}};
  };
  const result=await executeAiRun(run.id,{candidateDraftRoute:configuredRoute(provider,vi.fn(()=>{throw new Error('no wording');}))});expect(result.state).toBe('succeeded');
  const[stored]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,run.id)),proof=stored.metrics?.reservationistResult as {recipientPreparations?:{prepared:{cc:string[]}}[];preparedFacts?:{key:string}[]};expect(proof.recipientPreparations![0].prepared.cc).toEqual(['private-review@example.invalid']);expect(proof.preparedFacts![0].key).toBe('reply_recipients_copy');
  const[draft]=await db.select().from(mailDraft).where(eq(mailDraft.threadId,threadId));expect(draft.textBody).toContain('Reply recipients are prepared for staff review; no email has been sent.');expect(draft.textBody).not.toContain('private-review');expect(draft.htmlBody).not.toContain('private-review');
 });
});

it('claims and captures the installed candidate result through runAiWorkerOnce without exposing mutable runtime objects',async()=>{
 process.env.HMS_DRAFT_ENRICHMENT_MODE='off';process.env.AI_MODEL_ROUTE='approved-local';
 await withSeededTestDb(async db=>{
  __setDbForTests({db,conn:null as never});const {threadId,triggerId,run}=await seed(db,false);
  await db.update(message).set({textBody:'Thank you for the quote. I will review it and revert to you on how we would like to proceed.'}).where(eq(message.id,triggerId));
  const invoke=vi.fn(async()=>({modelId:'synthetic-reservationist',output:{facts:[],tasks:[],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,totalTokens:2,estimatedCostUsd:0,rateTableVersion:'test'}}));
  const provider=vi.fn(async context=>{
   const [claimed]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,run.id));
   expect(claimed.state).toBe('running');expect(context.fence.claimToken).toBe(claimed.claimToken);
   return createReservationistDependencies({adapter:{invoke,reserveCalls:async()=>{}},admissions:context.admissions,header:{},converter:{url:'unused'},services:{resolveQuote:vi.fn(()=>{throw Error('no action must not read a quote');})},extractionMode:'task_first'} as any);
  });
  const capture=vi.fn(async({input,result}:any)=>{expect(input.trigger.id).toBe(triggerId);expect(result.readiness).toBe('no_action');result.textBody='mutated capture';});
  const route=configuredRoute(provider,vi.fn(()=>{throw Error('no extra model');}));
  const worked=await runAiWorkerOnce({runKind:'candidate_draft',idempotencyPrefix:'reservationist:'+triggerId,candidateDraftRouteFactory:()=>route,onReservationistResult:capture} as any);
  expect(worked).toBe(true);expect(provider).toHaveBeenCalledOnce();expect(capture).toHaveBeenCalledOnce();
  const [stored]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,run.id));
  expect(stored.state,stored.lastError??'no worker error').toBe('succeeded');expect(JSON.stringify(stored.metrics)).not.toContain('mutated capture');
  expect(await db.select().from(mailDraft).where(eq(mailDraft.threadId,threadId))).toHaveLength(0);
 });
});
