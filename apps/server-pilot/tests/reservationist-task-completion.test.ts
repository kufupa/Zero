import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { handledRequestKeys, hasOutstandingRequestHistory, hasOutstandingRequests, outstandingRequestHistory, requestCompletionKeys, setRequestHandled } from '../src/ai/reservationist-task-completion.js';
import { refreshThreadWork } from '../src/ai/work-items.js';
import { markAiRunSucceeded } from '../src/ai/run-ledger.js';
import { approveHmsWrite } from '../src/ai/hms-approval.js';
import { aiWorkflowRun, mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../src/db/schema/work.js';
import { CENTURION_USER_ID, TRANSPORT_EMAIL, TRANSPORT_ID } from '../src/db/seed.js';
import { TEST_DB_AVAILABLE, openTestDbSession, probeTestDb, withSeededTestDb } from './helpers/test-db.js';

const task = (id: string, start: number) => ({ id, kind: 'question', requestSource: {
  attachmentId: 'message:one', sourceHash: 'a'.repeat(64), page: 1, start, end: start + 4, quote: 'test',
} });

it('carries staff completion only across an unchanged, unique source span', () => {
  const before = requestCompletionKeys({ version: 1, tasks: [task('one', 0), task('two', 5)] }, 'run-a');
  const rerun = requestCompletionKeys({ version: 1, tasks: [task('renamed', 0), task('other', 9)] }, 'run-b');
  expect(before.get('one')).toBe(rerun.get('renamed'));
  expect(before.get('two')).not.toBe(rerun.get('other'));
  const ambiguous = requestCompletionKeys({ version: 1, tasks: [task('one', 0), task('two', 0)] }, 'run-a');
  expect(ambiguous.get('one')).not.toBe(ambiguous.get('two'));
  expect(ambiguous.get('one')).not.toBe(requestCompletionKeys({ version: 1, tasks: [task('one', 0), task('two', 0)] }, 'run-b').get('one'));
  const quote = `${'Earlier request. '.repeat(20)}Final detail.`;
  const long = {...task('long', 0), requestSource:{...task('long', 0).requestSource, end:quote.length, quote}};
  expect(outstandingRequestHistory([{id:'run',result:{version:1,tasks:[long]}}], {})[0]?.quote).toBe(quote);
});

it('does not auto-close a malformed stored task inventory', () => {
  expect(hasOutstandingRequests(undefined, 'run', {})).toBe(false);
  expect(hasOutstandingRequests({ version: 1, tasks: null }, 'run', {})).toBe(true);
  expect(hasOutstandingRequests({ version: 2, tasks: [] }, 'run', {})).toBe(true);
});

it('keeps an unread business attachment open even when no request could be extracted', () => {
  const recovery = {kind:'attachment_manual', disclosure:'staff_only', sourceRef:'sheet', reason:'too_large'};
  expect(hasOutstandingRequests({version:1,tasks:[],sourceRecoveries:[recovery]}, 'run', {})).toBe(true);
  expect(hasOutstandingRequests({version:1,tasks:[],sourceRecoveries:[{...recovery,signatureNoise:true}]}, 'run', {})).toBe(false);
});

it('clears an old unread-file warning only after reviewing that file, without losing earlier requests', () => {
  const recovery = {kind:'attachment_manual', disclosure:'staff_only', sourceRef:'sheet', sourceHash:'a'.repeat(64), reason:'too_large'};
  const latest = {id:'new', result:{version:1,tasks:[]}, source:{attachments:[{attachmentId:'sheet',sourceHash:'a'.repeat(64)}]}};
  const oldWarning = {id:'old', result:{version:1,tasks:[],sourceRecoveries:[recovery]}};
  expect(hasOutstandingRequestHistory([latest, oldWarning], {})).toBe(false);
  expect(hasOutstandingRequestHistory([{...latest,source:{attachments:[]}}, oldWarning], {})).toBe(true);
  expect(hasOutstandingRequestHistory([{...latest,source:{attachments:[{attachmentId:'sheet',sourceHash:'b'.repeat(64)}]}}, oldWarning], {})).toBe(true);
  expect(hasOutstandingRequestHistory([oldWarning], {})).toBe(true);
  expect(hasOutstandingRequestHistory([{id:'legacy',result:undefined}, oldWarning], {})).toBe(true);
  const oldAsk = {id:'older', result:{version:1,tasks:[task('one',0)]}};
  expect(hasOutstandingRequestHistory([latest, oldAsk], {})).toBe(true);
  const oldEmail = {id:'old-email', result:{version:1,tasks:[],sourceRecoveries:[{...recovery,sourceKind:'message',sourceRef:'message:mail'}]}};
  expect(hasOutstandingRequestHistory([{...latest,source:{messages:[{id:'mail',sourceHash:'a'.repeat(64)}]}}, oldEmail], {})).toBe(false);
  const oldSubject = {id:'old-subject',result:{version:1,tasks:[],sourceRecoveries:[{...recovery,sourceKind:'message',sourceRef:'message-subject:mail'}]},source:{messages:[{id:'mail',identityHash:'b'.repeat(64)}]}};
  expect(hasOutstandingRequestHistory([{...latest,source:{messages:[{id:'mail',identityHash:'b'.repeat(64)}]}}, oldSubject], {})).toBe(false);
  expect(hasOutstandingRequestHistory([{...latest,source:{messages:[{id:'mail',identityHash:'c'.repeat(64)}]}}, oldSubject], {})).toBe(true);
});

const reachable = await probeTestDb();
describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('staff request completion', () => {
  it('persists one acknowledgement, survives a rerun and refuses a stale or other-mailbox update', async () => {
    await withSeededTestDb(async db => {
      const threadId = randomUUID(), messageId = randomUUID(), runId = randomUUID(), nextRunId = randomUUID();
      const now = new Date();
      await db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: `<${threadId}@example.invalid>`, latestMessageAt: now });
      await db.insert(message).values({ id: messageId, transportId: TRANSPORT_ID, threadId, direction: 'inbound', fromAddress: 'guest@example.invalid', toAddresses: [], textBody: 'test test', receivedAt: now });
      const [item] = await db.insert(workItem).values({ transportId: TRANSPORT_ID, threadId, sourceMessageId: messageId, kind: 'other' }).returning();
      const result = { version: 1, tasks: [task('one', 0), task('two', 5)] };
      const run = { transportId: TRANSPORT_ID, threadId, triggerMessageId: messageId, runKind: 'candidate_draft' as const,
        modelId: 'synthetic', promptVersion: 'test', state: 'succeeded' as const, metrics: { reservationistResult: result } };
      await db.insert(aiWorkflowRun).values({ ...run, id: runId, idempotencyKey: runId, createdAt: new Date(now.getTime() - 1000) });
      const input = { transportId: TRANSPORT_ID, workItemId: item!.id, userId: CENTURION_USER_ID, runId, taskId: 'one', handled: true };
      expect(await setRequestHandled(db, input)).toBe('recorded');
      const [saved] = await db.select().from(workItem).where(eq(workItem.id, item!.id));
      const keys = requestCompletionKeys(result, runId);
      expect(handledRequestKeys(saved!.state)).toEqual(new Set([keys.get('one')]));
      expect(saved!.status).toBe('needs_you');
      expect(await db.select().from(workEvent).where(eq(workEvent.workItemId, item!.id))).toHaveLength(1);
      const nextResult = { version: 1, tasks: [task('renamed', 0), task('two', 5)] };
      await db.insert(aiWorkflowRun).values({ ...run, id: nextRunId, idempotencyKey: nextRunId, createdAt: now, metrics: { reservationistResult: nextResult } });
      expect(handledRequestKeys(saved!.state).has(requestCompletionKeys(nextResult, nextRunId).get('renamed')!)).toBe(true);
      expect(await setRequestHandled(db, { ...input, runId: randomUUID(), handled: false })).toBe('stale');
      expect(await setRequestHandled(db, { ...input, runId: nextRunId, taskId: 'renamed', handled: false })).toBe('recorded');
      expect(await setRequestHandled(db, { ...input, transportId: 'different-mailbox' })).toBe('not_found');
    });
  });

  it('keeps the older email open across a newer request and a reply until both asks are handled', async () => {
    await withSeededTestDb(async db => {
      const threadId = randomUUID(), oldMessage = randomUUID(), newerMessage = randomUUID(), reply = randomUUID(), runId = randomUUID(), rerunId = randomUUID();
      const start = Date.now() - 180_000, at = (offset: number) => new Date(start + offset);
      await db.insert(mailThread).values({id:threadId,transportId:TRANSPORT_ID,threadRootId:`<${threadId}@example.invalid>`,latestMessageAt:at(20_000)});
      await db.insert(message).values([
        {id:oldMessage,transportId:TRANSPORT_ID,threadId,direction:'inbound',fromAddress:'guest@example.invalid',toAddresses:[TRANSPORT_EMAIL],textBody:'test test',receivedAt:at(0)},
        {id:newerMessage,transportId:TRANSPORT_ID,threadId,direction:'inbound',fromAddress:'guest@example.invalid',toAddresses:[TRANSPORT_EMAIL],textBody:'Another request.',receivedAt:at(10_000)},
      ]);
      const [old] = await db.insert(workItem).values({transportId:TRANSPORT_ID,threadId,sourceMessageId:oldMessage,kind:'other'}).returning();
      await db.insert(workItem).values({transportId:TRANSPORT_ID,threadId,sourceMessageId:newerMessage,kind:'quote'});
      const state = async () => (await db.select().from(workItem).where(eq(workItem.id, old!.id)))[0]!;
      await refreshThreadWork(db, {transportId:TRANSPORT_ID,threadId});
      expect((await state()).status).toBe('dismissed');
      await db.insert(aiWorkflowRun).values({id:runId,idempotencyKey:runId,transportId:TRANSPORT_ID,threadId,
        triggerMessageId:oldMessage,runKind:'candidate_draft',modelId:'synthetic',promptVersion:'test',state:'running',claimOwner:'worker',claimToken:'token',
        createdAt:at(21_000),metrics:{reservationistResult:{version:1,tasks:[task('one',0),task('two',5)]}}});
      await markAiRunSucceeded({runId,claimOwner:'worker',claimToken:'token',expectedStates:['running']},db);
      expect((await state()).status).toBe('needs_you');
      await db.insert(message).values({id:reply,transportId:TRANSPORT_ID,threadId,direction:'outbound',fromAddress:TRANSPORT_EMAIL,
        toAddresses:['guest@example.invalid'],textBody:'Acknowledged.',receivedAt:at(20_000),sentAt:at(20_000)});
      const input = {transportId:TRANSPORT_ID,workItemId:old!.id,userId:CENTURION_USER_ID,runId,handled:true};
      const original = {version:1,tasks:[task('one',0),task('two',5)]}, rerun = {version:1,tasks:[task('one',0)]};
      await db.insert(aiWorkflowRun).values({id:rerunId,idempotencyKey:rerunId,transportId:TRANSPORT_ID,threadId,
        triggerMessageId:oldMessage,runKind:'candidate_draft',modelId:'synthetic',promptVersion:'test',state:'succeeded',
        createdAt:at(22_000),metrics:{reservationistResult:rerun}});
      await setRequestHandled(db,{...input,runId:rerunId,taskId:'one'});
      await refreshThreadWork(db, {transportId:TRANSPORT_ID,threadId});
      expect((await state()).status).toBe('needs_you');
      expect(outstandingRequestHistory([{id:rerunId,result:rerun},{id:runId,result:original}],(await state()).state))
        .toMatchObject([{runId,taskId:'two'}]);
      await setRequestHandled(db,{...input,taskId:'two'});
      await refreshThreadWork(db, {transportId:TRANSPORT_ID,threadId});
      expect((await state()).status).toBe('done');
      await setRequestHandled(db,{...input,taskId:'two',handled:false});
      await refreshThreadWork(db, {transportId:TRANSPORT_ID,threadId});
      expect((await state()).status).toBe('needs_you');
    });
  });

  it('reopens only the current classification for a late request', async () => {
    await withSeededTestDb(async db => {
      const threadId=randomUUID(), messageId=randomUUID(), reply=randomUUID(), runId=randomUUID();
      const start=Date.now()-180_000, at=(offset:number)=>new Date(start+offset);
      await db.insert(mailThread).values({id:threadId,transportId:TRANSPORT_ID,threadRootId:`<${threadId}@example.invalid>`,latestMessageAt:at(20_000)});
      await db.insert(message).values([
        {id:messageId,transportId:TRANSPORT_ID,threadId,direction:'inbound',fromAddress:'guest@example.invalid',toAddresses:[TRANSPORT_EMAIL],textBody:'test',receivedAt:at(0)},
        {id:reply,transportId:TRANSPORT_ID,threadId,direction:'outbound',fromAddress:TRANSPORT_EMAIL,toAddresses:['guest@example.invalid'],sentAt:at(20_000),receivedAt:at(20_000)},
      ]);
      const [older, latest] = await db.insert(mailExtraction).values([
        {messageId,extractorVersion:'old',status:'succeeded',kind:'other',payload:{},createdAt:at(1_000)},
        {messageId,extractorVersion:'new',status:'succeeded',kind:'quote',payload:{},createdAt:at(2_000)},
      ]).returning();
      const [oldItem, currentItem] = await db.insert(workItem).values([
        {transportId:TRANSPORT_ID,threadId,sourceMessageId:messageId,kind:'other',status:'done',extractionId:older!.id,sentAt:at(20_000),sentMessageId:reply},
        {transportId:TRANSPORT_ID,threadId,sourceMessageId:messageId,kind:'quote',status:'done',extractionId:latest!.id,sentAt:at(20_000),sentMessageId:reply},
      ]).returning();
      await db.insert(workEvent).values([oldItem!,currentItem!].map(item=>({workItemId:item.id,actorKind:'system' as const,type:'status.changed' as const,
        value:{from:'needs_you',to:'done',reason:'hotel_replied'}})));
      await db.insert(aiWorkflowRun).values({id:runId,idempotencyKey:runId,transportId:TRANSPORT_ID,threadId,triggerMessageId:messageId,
        runKind:'candidate_draft',modelId:'synthetic',promptVersion:'test',state:'running',claimOwner:'worker',claimToken:'token',
        metrics:{reservationistResult:{version:1,tasks:[task('one',0)]}}});
      await markAiRunSucceeded({runId,claimOwner:'worker',claimToken:'token',expectedStates:['running']},db);
      const status = async (id:string) => (await db.select().from(workItem).where(eq(workItem.id,id)))[0]!.status;
      expect(await status(oldItem!.id)).toBe('done');
      expect(await status(currentItem!.id)).toBe('needs_you');
      await setRequestHandled(db,{transportId:TRANSPORT_ID,workItemId:currentItem!.id,userId:CENTURION_USER_ID,runId,taskId:'one',handled:true});
      await refreshThreadWork(db,{transportId:TRANSPORT_ID,threadId});
      expect(await status(oldItem!.id)).toBe('done');
      expect(await status(currentItem!.id)).toBe('done');
      const [latestRead] = await db.insert(mailExtraction).values({messageId,extractorVersion:'later',status:'succeeded',
        kind:'amendment',payload:{},createdAt:at(3_000)}).returning();
      const [laterItem] = await db.insert(workItem).values({transportId:TRANSPORT_ID,threadId,sourceMessageId:messageId,
        kind:'amendment',status:'done',extractionId:latestRead!.id,sentAt:at(20_000),sentMessageId:reply}).returning();
      await db.insert(workEvent).values({workItemId:laterItem!.id,actorKind:'system',type:'status.changed',
        value:{from:'needs_you',to:'done',reason:'hotel_replied'}});
      await refreshThreadWork(db,{transportId:TRANSPORT_ID,threadId});
      expect(await status(laterItem!.id)).toBe('done'); // Earlier acknowledgement still applies.
      await setRequestHandled(db,{transportId:TRANSPORT_ID,workItemId:laterItem!.id,userId:CENTURION_USER_ID,runId,taskId:'one',handled:false});
      await refreshThreadWork(db,{transportId:TRANSPORT_ID,threadId});
      expect(await status(laterItem!.id)).toBe('needs_you');
      expect(await status(currentItem!.id)).toBe('done');
      await setRequestHandled(db,{transportId:TRANSPORT_ID,workItemId:laterItem!.id,userId:CENTURION_USER_ID,runId,taskId:'one',handled:true});
      await refreshThreadWork(db,{transportId:TRANSPORT_ID,threadId});
      expect(await status(laterItem!.id)).toBe('done');
    });
  });

  it('serializes a completed analysis with a reply already closing its work item', async () => {
    const setup = openTestDbSession(), locker = openTestDbSession(), finisher = openTestDbSession();
    const transportId=`race-${randomUUID()}`, threadId=randomUUID(), messageId=randomUUID(), replyId=randomUUID(), runId=randomUUID();
    let release: () => void = () => {};
    let held: Promise<void> | undefined, completion: ReturnType<typeof markAiRunSucceeded> | undefined;
    try {
      const receivedAt=new Date(Date.now()-60_000), sentAt=new Date(receivedAt.getTime()+30_000);
      await setup.db.insert(mailboxTransport).values({id:transportId,email:`${transportId}@example.invalid`,ownerHeaderValue:transportId});
      await setup.db.insert(mailThread).values({id:threadId,transportId,threadRootId:`<${threadId}@example.invalid>`,latestMessageAt:sentAt});
      await setup.db.insert(message).values([
        {id:messageId,transportId,threadId,direction:'inbound',fromAddress:'guest@example.invalid',toAddresses:[],textBody:'test',receivedAt},
        {id:replyId,transportId,threadId,direction:'outbound',fromAddress:`${transportId}@example.invalid`,toAddresses:[],sentAt,receivedAt:sentAt},
      ]);
      const [item] = await setup.db.insert(workItem).values({transportId,threadId,sourceMessageId:messageId,kind:'other'}).returning();
      await setup.db.insert(aiWorkflowRun).values({id:runId,idempotencyKey:runId,transportId,threadId,triggerMessageId:messageId,
        runKind:'candidate_draft',modelId:'synthetic',promptVersion:'test',state:'running',claimOwner:'worker',claimToken:'token',
        metrics:{reservationistResult:{version:1,tasks:[task('one',0)]}}});
      let acquired!: (pid: number) => void;
      const locked = new Promise<number>(resolve => { acquired = resolve; });
      const unlock = new Promise<void>(resolve => { release = resolve; });
      held = locker.db.transaction(async tx => {
        const [connection] = await tx.execute(sql<{pid:number}>`select pg_backend_pid() as pid`);
        await tx.select({id:workItem.id}).from(workItem).where(eq(workItem.id,item!.id)).for('update');
        acquired(connection!.pid);
        await unlock;
        await tx.update(workItem).set({status:'done',sentAt,sentMessageId:replyId}).where(eq(workItem.id,item!.id));
        await tx.insert(workEvent).values({workItemId:item!.id,actorKind:'system',type:'status.changed',
          value:{from:'needs_you',to:'done',reason:'hotel_replied'}});
      });
      const holderPid = await locked;
      completion = markAiRunSucceeded({runId,claimOwner:'worker',claimToken:'token',expectedStates:['running']},finisher.db);
      let blocked = false;
      for (let attempt=0; attempt<100; attempt++) {
        const [state] = await setup.db.execute(sql<{blocked:boolean}>`select exists (
          select 1 from pg_stat_activity a where a.datname=current_database()
            and a.wait_event_type='Lock' and ${holderPid}=any(pg_blocking_pids(a.pid))
        ) as blocked`);
        if (state!.blocked) { blocked=true; break; }
        await new Promise(resolve => setTimeout(resolve,20));
      }
      expect(blocked).toBe(true);
      release();
      await held;
      await completion;
      expect((await setup.db.select().from(workItem).where(eq(workItem.id,item!.id)))[0]?.status).toBe('needs_you');
    } finally {
      release();
      if (held) await held.catch(() => undefined);
      if (completion) await completion.catch(() => undefined);
      await Promise.all([setup.close(),locker.close(),finisher.close()]);
    }
  }, 15_000);

  it('allows concurrent request acknowledgement and HMS approval', async () => {
    const setup = openTestDbSession(), approver = openTestDbSession(), acknowledger = openTestDbSession();
    const transportId=`race-${randomUUID()}`, threadId=randomUUID(), messageId=randomUUID(), runId=randomUUID();
    let release: () => void = () => {};
    let approval: ReturnType<typeof approveHmsWrite> | undefined, acknowledgement: ReturnType<typeof setRequestHandled> | undefined;
    try {
      const now=new Date();
      await setup.db.insert(mailboxTransport).values({id:transportId,email:`${transportId}@example.invalid`,ownerHeaderValue:transportId});
      await setup.db.insert(mailThread).values({id:threadId,transportId,threadRootId:`<${threadId}@example.invalid>`,latestMessageAt:now});
      await setup.db.insert(message).values({id:messageId,transportId,threadId,direction:'inbound',fromAddress:'guest@example.invalid',toAddresses:[],textBody:'test',receivedAt:now});
      const [item]=await setup.db.insert(workItem).values({transportId,threadId,sourceMessageId:messageId,kind:'other'}).returning();
      await setup.db.insert(aiWorkflowRun).values({id:runId,idempotencyKey:runId,transportId,threadId,triggerMessageId:messageId,
        runKind:'candidate_draft',modelId:'synthetic',promptVersion:'test',state:'succeeded',
        metrics:{reservationistResult:{version:1,tasks:[task('one',0)]}}});
      const [connection]=await approver.db.execute(sql<{pid:number}>`select pg_backend_pid() as pid`);
      let acquired!: () => void;
      const locked=new Promise<void>(resolve => { acquired=resolve; });
      const proceed=new Promise<void>(resolve => { release=resolve; });
      approval=approveHmsWrite({db:approver.db,transportId,actorUserId:'staff',workItemId:item!.id,
        rereadHmsState:async()=>{acquired();await proceed;return {confirmation:'synthetic'};}});
      await locked;
      acknowledgement=setRequestHandled(acknowledger.db,{transportId,workItemId:item!.id,userId:'staff',runId,taskId:'one',handled:true});
      let blocked=false;
      for(let attempt=0;attempt<100;attempt++){
        const [state]=await setup.db.execute(sql<{blocked:boolean}>`select exists (
          select 1 from pg_stat_activity a where a.datname=current_database()
            and a.wait_event_type='Lock' and ${connection!.pid}=any(pg_blocking_pids(a.pid))
        ) as blocked`);
        if(state!.blocked){blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect(blocked).toBe(true);
      release();
      const [grant,handled]=await Promise.all([approval,acknowledgement]);
      expect(grant.runId).toBeTruthy();
      expect(handled).toBe('recorded');
    } finally {
      release();
      await Promise.allSettled([...(approval?[approval]:[]),...(acknowledgement?[acknowledgement]:[])]);
      await Promise.all([setup.close(),approver.close(),acknowledger.close()]);
    }
  }, 15_000);
});
