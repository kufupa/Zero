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
import { eq,and } from 'drizzle-orm';
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
    textBody: 'What is the check-in time?',
    receivedAt: new Date(),
  });
  const priorId=randomUUID();
  await db.insert(message).values({id:priorId,threadId,transportId:TRANSPORT_ID,direction:'outbound',fromAddress:'centurion@legacyhotel.com',toAddresses:['actual-trigger@example.com'],subject:'Earlier source',textBody:'Check-in time is 14:00.',sentAt:new Date(Date.now()-60000)});
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
    contextMessageIds: [priorId,triggerId],
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

import {createReservationistDependencies} from '../src/ai/reservationist-execution.ts';
import type {ModelAdapter} from '../src/ai/bedrock/adapter.ts';
import {draftSourceHash} from '../src/ai/reservationist-draft-source.ts';
import {type ReservationistPersistedResult} from '../src/ai/drafts.ts';

/** Genuine shared factory receipt crosses the disposable worker/promotion boundary. */
const mutations=['unchanged','staff_audience','changed_trigger_guest','changed_source','native_fact','receipt_owner','receipt_value','receipt_task'] as const;
it.each(mutations)('causal original guest mail check-in reaches disposable worker and promotion, %s',async mutation=>{
 process.env.HMS_DRAFT_ENRICHMENT_MODE='off';process.env.AI_MODEL_ROUTE='approved-local';
 await withSeededTestDb(async db=>{
  __setDbForTests({db,conn:null as never});const {threadId,triggerId,run}=await seed(db);let nativeReads=0;
  const wording=vi.fn(()=>{throw new Error('no extra wording')});
  const provider:NonNullable<DraftModelRouteConfig['reservationist']>=async context=>{
   const current=context.input.messages.find(m=>m.id===triggerId)!,prior=context.input.messages.find(m=>m.direction==='outbound')!,source={attachmentId:`message:${triggerId}`,sourceHash:createHash('sha256').update(current.text).digest('hex'),page:1,quote:current.text,start:0,end:current.text.length};
   expect(prior.disclosure).toBe('guest');
   const model:ModelAdapter={invoke:async()=>({modelId:'synthetic-unpaid',output:{facts:[],tasks:[{id:'check-in',kind:'question',factIds:[],source}],unresolvedAsks:[]},usage:{inputTokens:1,outputTokens:1,totalTokens:2,latencyMs:1,estimatedCostUsd:0,rateTableVersion:'synthetic-unpaid'}})};
   const fact={key:'check_in_check-in',label:'check_in',value:'14:00',source:'mail' as const,authority:'authorized' as const,status:'known' as const,scopeVerified:true,disclosure:'guest' as const,evidenceRef:`message:${prior.id}`,sourceHash:createHash('sha256').update(prior.text).digest('hex')};
   const factory=createReservationistDependencies({adapter:model,admissions:context.admissions,header:{attention:'',company:'',clientEmail:'',clientTelephone:'',agency:'',signerName:'',signerEmail:''},converter:{url:'unused'},services:{resolveTaskAnswer:async()=>({kind:'check_in',value:'14:00',disclosure:'guest',evidenceRefs:[fact.evidenceRef],preparedFacts:[fact]}),authorizeAnswerSource:async sourceFact=>sourceFact.evidenceRef===fact.evidenceRef&&sourceFact.sourceHash===fact.sourceHash,resolveReadTask:async()=>{nativeReads++;throw new Error('no PMS dependency allowed');},resolveQuoteTask:async()=>{nativeReads++;throw new Error('no pricing dependency allowed');}}});
   const execute=factory.dependencies.execute;return{...factory,dependencies:{...factory.dependencies,execute:async(...args)=>{const result=await execute(...args);if(mutation==='native_fact')result.preparedFacts!.push({...fact,key:'hms',source:'hms'});return result;}}};
  };
  const result=await executeAiRun(run.id,{candidateDraftRoute:configuredRoute(provider,wording)});expect(result.state).toBe('succeeded');expect(nativeReads).toBe(0);expect(wording).not.toHaveBeenCalled();
  const[draft]=await db.select().from(mailDraft).where(eq(mailDraft.threadId,threadId));const[stored]=await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id,run.id));const metrics=stored!.metrics as typeof stored.metrics&{reservationistDraftSource?:{operationalAnswers?:unknown[]}};expect(metrics!.reservationistDraftSource!.operationalAnswers).toHaveLength(1);expect(draft!.textBody).toContain('Check-in time is 14:00.');
  if(mutation==='staff_audience')await db.update(message).set({toAddresses:['staff@example.com']}).where(and(eq(message.threadId,threadId),eq(message.direction,'outbound')));
  if(mutation==='changed_trigger_guest')await db.update(message).set({fromAddress:'other@example.com'}).where(eq(message.id,triggerId));
  if(mutation==='changed_source')await db.update(message).set({textBody:'Check-in time is 15:00.'}).where(and(eq(message.threadId,threadId),eq(message.direction,'outbound')));
  if(mutation.startsWith('receipt_')){const changed=structuredClone(stored!.metrics!) as typeof stored.metrics&{reservationistDraftSource:any};const proof=changed!.reservationistDraftSource.operationalAnswers[0];if(mutation==='receipt_owner')proof.binding.ownerRef='foreign';if(mutation==='receipt_value')proof.answer.value='15:00';if(mutation==='receipt_task')proof.task.id='other';const{digest,...unsigned}=changed!.reservationistDraftSource;changed!.reservationistDraftSource.digest=draftSourceHash(unsigned);await db.update(aiWorkflowRun).set({metrics:changed}).where(eq(aiWorkflowRun.id,run.id));}
  const guard=()=>assertHmsDraftFreshForAction({db,transportId:TRANSPORT_ID,draft:draft!,conflict:'STALE_AI_CANDIDATE'});
  if(mutation!=='unchanged'){await expect(guard()).rejects.toThrow('STALE_AI_CANDIDATE');return;}
  await expect(guard()).resolves.toBeUndefined();const caller=await callerFor('user-navaai',{db,requestedTransportId:TRANSPORT_ID});const promoted=await caller.drafts.ensureEditableForReply({threadId,replyToMessageId:triggerId});expect(promoted.content).toContain('Check-in time is 14:00.');expect(promoted.attachments).toEqual([]);const reloaded=await caller.drafts.get({id:promoted.id});expect(reloaded.content).toBe(promoted.content);
 });
},30000);
