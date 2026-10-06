import {
  mailThread,
  message,
  mailDraft,
  aiWorkflowRun,
  aiDraftGeneration,
  attachment,
} from '../src/db/schema/mail.js';
import {callerFor} from './helpers/trpc-caller.js';
import {configureDraftArtifactStorage,configureInboundAttachmentIdentityReader,assertHmsDraftFreshForAction} from '../src/trpc/routes/drafts.js';
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
    textBody: 'I will like to check in by 3:00pm.',
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

import {createReservationistDependencies,deriveRequestedArrivalAcknowledgement} from '../src/ai/reservationist-execution.ts';
import type {ModelAdapter} from '../src/ai/bedrock/adapter.ts';
import {draftSourceHash} from '../src/ai/reservationist-draft-source.ts';
import {type ReservationistPersistedResult} from '../src/ai/drafts.ts';

/** Genuine shared factory receipt crosses the disposable worker/promotion boundary. */
const arrivalCases=['unchanged','hotel_permission','native_fact','receipt_owner','receipt_property','receipt_scope_property','receipt_hash','receipt_task','changed_original','future_inbound'] as const;
it.each(arrivalCases)('source-only genuine factory arrival reaches worker/DB/promotion, with scoped refusal for %s',async mutation=>{
 process.env.HMS_DRAFT_ENRICHMENT_MODE='off';process.env.AI_MODEL_ROUTE='approved-local';
 await withSeededTestDb(async db=>{
  __setDbForTests({db,conn:null as never});const {threadId,triggerId,run}=await seed(db);
  let nativeReads=0;const wording=vi.fn(()=>{throw new Error('no extra wording')});
  const provider:NonNullable<DraftModelRouteConfig['reservationist']>=async context=>{
   const current=context.input.messages.find(m=>m.id===triggerId)!;
   const quote='I will like to check in by 3:00pm.',start=current.text.indexOf(quote),source={attachmentId:`message:${triggerId}`,sourceHash:createHash('sha256').update(current.text).digest('hex'),page:1,quote,start,end:start+quote.length};
   const model:ModelAdapter={invoke:async()=>({modelId:'synthetic-unpaid',output:{facts:[],tasks:[{id:'arrival',kind:'question',factIds:[],source}],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,totalTokens:2,latencyMs:1,estimatedCostUsd:0,rateTableVersion:'synthetic-unpaid'}})};
   const factory=createReservationistDependencies({adapter:model,admissions:context.admissions,header:{attention:'',company:'',clientEmail:'',clientTelephone:'',agency:'',signerName:'',signerEmail:''},converter:{url:'unused'},services:{resolveRequestedArrivalAcknowledgement:async ctx=>deriveRequestedArrivalAcknowledgement(ctx),resolveReadTask:async()=>{nativeReads++;throw new Error('no PMS dependency allowed');},resolveQuoteTask:async()=>{nativeReads++;throw new Error('no pricing dependency allowed');}}});
   const originalExecute=factory.dependencies.execute;
   return {...factory,dependencies:{...factory.dependencies,execute:async(...args)=>{
    const result=await originalExecute(...args);
    expect(result.tasks).toHaveLength(1);expect(result.tasks[0]!.status).toBe('complete');
    expect(result.preparedFacts).toHaveLength(1);expect(result.preparedFacts![0]!.value).toEqual({requestedTime:'3:00pm',authority:'customer_claim',hotelPermission:'unverified'});
    if(mutation==='hotel_permission')result.preparedFacts![0]!.value={requestedTime:'3:00pm',authority:'customer_claim',hotelPermission:'granted'};
    if(mutation==='native_fact')result.preparedFacts!.push({key:'native_permission',label:'Hotel permission',value:true,source:'hms',authority:'authorized',status:'known',scopeVerified:true,disclosure:'guest',evidenceRef:'fabricated-native'});
    return result;
   }}};
  };
  const result=await executeAiRun(run.id,{candidateDraftRoute:configuredRoute(provider,wording)});
  if(mutation==='hotel_permission'){expect(result.state).not.toBe('succeeded');const [failed]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,run.id));expect(failed!.lastError).toContain('arrival_draft_fact_invalid');expect(await db.select().from(mailDraft).where(eq(mailDraft.threadId,threadId))).toEqual([]);expect(nativeReads).toBe(0);return;}
  expect(result.state).toBe('succeeded');expect(wording).not.toHaveBeenCalled();expect(nativeReads).toBe(0);
  const [draft]=await db.select().from(mailDraft).where(eq(mailDraft.threadId,threadId));
  const [stored]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,run.id));
  const [generation]=await db.select().from(aiDraftGeneration).where(eq(aiDraftGeneration.id,draft!.generationId!));
  expect(draft!.textBody).toContain('We have noted your request to check in by 3:00pm.');expect(draft!.textBody).toContain('Staff must verify the requested arrival time.');
  expect(draft!.attachments).toEqual([]);expect((stored!.metrics!.reservationistResult as ReservationistPersistedResult).quoteRevisionIds).toEqual([]);
  const guard=()=>assertHmsDraftFreshForAction({db,transportId:TRANSPORT_ID,draft:draft!,conflict:'STALE_AI_CANDIDATE'});
  if(mutation.startsWith('receipt_')){
   // Worker proof retains the exact plan source; a rehashed forged receipt
   // must still fail against the original causal message and result.
   const metrics=structuredClone(stored!.metrics!) as typeof stored.metrics&{reservationistDraftSource?:Record<string,unknown>};
   const source=metrics!.reservationistDraftSource!;
   const receipts=source.arrivalAcknowledgements as Array<{task:{id:string};receipt:{ownerRef:string;propertyCode:string;source:{sourceHash:string}}}>;
   expect(receipts).toHaveLength(1);
   if(mutation==='receipt_owner')receipts[0]!.receipt.ownerRef='foreign';
   if(mutation==='receipt_property')receipts[0]!.receipt.propertyCode='FOREIGN';
   if(mutation==='receipt_scope_property'){source.propertyCode='FOREIGN';receipts[0]!.receipt.propertyCode='FOREIGN';}
   if(mutation==='receipt_hash')receipts[0]!.receipt.source.sourceHash='f'.repeat(64);
   if(mutation==='receipt_task')receipts[0]!.task.id='other';
   // Preserve all live original inputs/result digest. Rehashing a forged proof
   // must not turn it into a valid source-derived acknowledgement.
   const {digest,...unsigned}=source;source.digest=draftSourceHash(unsigned);
   await db.update(aiWorkflowRun).set({metrics}).where(eq(aiWorkflowRun.id,run.id));
  }
  if(mutation==='changed_original')await db.update(message).set({textBody:'I will like to check in by 4:00pm.'}).where(eq(message.id,triggerId));
  if(mutation==='future_inbound')await db.insert(message).values({id:randomUUID(),threadId,transportId:TRANSPORT_ID,direction:'inbound',fromAddress:'Synthetic Guest <actual-trigger@example.com>',toAddresses:['centurion@legacyhotel.com'],subject:'Later request',textBody:'Please change my request.',receivedAt:new Date(Date.now()+1000)});
  if(mutation!=='unchanged'){await expect(guard()).rejects.toThrow('STALE_AI_CANDIDATE');return;}
  // Source-only customer preference remains promotable with no PMS evidence.
  expect(generation!.evidence??[]).toEqual([]);await expect(guard()).resolves.toBeUndefined();
  const caller=await callerFor('user-navaai',{db,requestedTransportId:TRANSPORT_ID});
  const promoted=await caller.drafts.ensureEditableForReply({threadId,replyToMessageId:triggerId});
  expect(promoted.content).toContain('3:00pm');expect(promoted.attachments).toEqual([]);
  const reloaded=await caller.drafts.get({id:promoted.id});expect(reloaded.content).toBe(promoted.content);
 });
},30000);
