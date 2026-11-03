import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { aiWorkflowRun } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { canonicalJson } from '../src/ai/draft-approval.js';
import { recordHmsWriteEvidence } from '../src/ai/hms-approval.js';
import { captureHmsLabtestDispatchEpoch, claimHmsLabtestDispatch, recoverHmsLabtestAttach,
  resolveNeverDispatchedAttach } from '../src/ai/hms-labtest-dispatch.js';
import { recordNeverDispatchedAttach } from '../src/ai/pane-cloud-attach-recovery.js';
import { HMS_LABTEST_ATTACH_PROMPT_VERSION } from '../src/ai/run-ledger.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { createDocumentUploadGate, documentUploadRequestDigest } from '../tooling/hms-cloud/stay360-document-attach.mjs';

const f = vi.hoisted(() => ({ quiesced: true, failRead: false, mismatch: false, loseQuiescence: false, reads: 0,
  entered: null as null | (() => void), release: null as null | Promise<void> }));
vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', async (original) => ({
  ...(await original<typeof import('../tooling/playwright-quote/centurion-stay360.mjs')>()),
  centurionWriterQuiesced: () => f.quiesced,
}));
vi.mock('../src/ai/pane-stay-save.js', async (original) => ({
  ...(await original<typeof import('../src/ai/pane-stay-save.js')>()),
  paneStayPropertyLock: () => ({ withLock: (fn: () => Promise<unknown>) => fn() }),
}));
vi.mock('../tooling/hms-cloud/pane-attach-session.mjs', async (original) => ({
  ...(await original<typeof import('../tooling/hms-cloud/pane-attach-session.mjs')>()),
  provePositiveAttachRecovery: async (intent: { nativeGuestId: string; recovery: { confirmation: string;
    documentCode: string; documentName: string } }) => {
    f.reads++; f.entered?.(); if (f.release) await f.release;
    if (f.failRead) return { outcome: 'unconfirmed' };
    if (f.loseQuiescence) f.quiesced = false;
    return { outcome: 'verified', confirmation: intent.recovery.confirmation, screenshot: png,
      readback: { confirmation: intent.recovery.confirmation, nativeGuestId: intent.nativeGuestId,
        documentCode: intent.recovery.documentCode, documentName: f.mismatch ? 'wrong.pdf' : intent.recovery.documentName,
        uniqueFreshListing: true } };
  },
}));

const root = process.env.NAVA_U6_RECOVERY_PRIVATE_PG_ROOT;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function syntheticUpload() {
  const names = ['documentcode', 'description', 'organization', 'filename', 'filepath', 'multiorg', 'typecode',
    'uploaddoc', 'pagemode', 'recordid', 'uploadorcreatedoc', 'daeRentity', 'daeType', 'daeCode', 'pages', 'filetype'];
  const file = { name: 'voucher.pdf', documentCode: 'NAVAAAAAAAAAAAAAAAAAAAAAAAAAAA', description: 'voucher.pdf',
    mimeType: 'application/pdf', bytes: Buffer.from('%PDF-synthetic') };
  const fields = new Map(names.map((name) => [name, '']));
  for (const [key, value] of Object.entries({ documentcode: file.documentCode, description: file.description,
    organization: 'HRCEN', filename: `C:\\fakepath\\${file.name}`, typecode: 'U', uploaddoc: 'U',
    uploadorcreatedoc: 'U', daeRentity: 'RESV', daeCode: '123#123456-1#HRCEN' })) fields.set(key, value);
  const token = new URLSearchParams({ requestToken: 'synthetic-token', browserTabID: '1' }), boundary = 'synthetic-boundary';
  const parts = names.map((key) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${fields.get(key)}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${file.name}"\r\nContent-Type: ${file.mimeType}\r\n\r\n${file.bytes.toString('latin1')}\r\n`);
  const body = Buffer.from(parts.join('') + `--${boundary}--\r\n`, 'latin1');
  const query = new URLSearchParams();
  for (const key of names.filter((key) => key !== 'filetype')) query.set(key, fields.get(key)!);
  query.set('requestToken', token.get('requestToken')!); query.set('browserTabID', '1'); query.set('isPopup', 'true');
  const frame = {}, child = { parentFrame: () => frame, name: () => 'ext-gen1', url: () => 'about:blank' };
  const request = { method: () => 'POST', isNavigationRequest: () => true, frame: () => child,
    url: () => `https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/BSUPLD.upload?${query}`,
    headers: () => ({ 'content-type': `multipart/form-data; boundary=${boundary}` }), postDataBuffer: () => body };
  return { frame, token, fields, file, request };
}

describe.skipIf(!root)('positive Filing recovery on a private synthetic PostgreSQL socket', () => {
  let conn: ReturnType<typeof postgres>, admin: ReturnType<typeof postgres>, db: DB;
  const storage = new FakeS3Storage();
  const schema = `u6recovery_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    for (const name of ['DATABASE_URL', 'VITEST_ALLOW_PILOT_RDS', 'TEST_DATABASE_URL']) expect(process.env[name]).toBeUndefined();
    expect(root).toMatch(/^\/tmp\/nava-u6-approval-pg-[A-Za-z0-9]+$/);
    expect(await realpath(root!)).toBe(root);
    for (const path of [root!, `${root}/data`, `${root}/socket`]) {
      const info = await stat(path); expect(info.uid).toBe(process.getuid?.()); expect(info.mode & 0o077).toBe(0);
    }
    const connection = { path: `${root}/socket/.s.PGSQL.58731`, database: 'postgres', user: 'nava_u6', ssl: false as const };
    admin = postgres({ ...connection, max: 1 });
    const [identity] = await admin`select current_setting('data_directory') as dir,
      current_setting('listen_addresses') as listen, inet_server_addr() is null as socket_only, current_user as username`;
    expect(identity).toMatchObject({ dir: `${root}/data`, listen: '', socket_only: true, username: 'nava_u6' });
    await admin.unsafe(`create schema "${schema}"`);
    conn = postgres({ ...connection, max: 5, connection: { search_path: schema } });
    for (const table of [workItem, workEvent, aiWorkflowRun]) {
      const columns = Object.values(getTableColumns(table)).map((column) => {
        const wanted = column.getSQLType(), type = /^(uuid|text|boolean|integer|smallint|bigint|jsonb|timestamp(?: with(?:out)? time zone)?|varchar\(\d+\))$/i.test(wanted)
          ? wanted : 'text';
        const primary = column.name === 'id' ? ' PRIMARY KEY' : '';
        const defaults = column.name === 'id' && type === 'uuid' ? ' DEFAULT gen_random_uuid()'
          : ['created_at', 'updated_at', 'at'].includes(column.name) ? ' DEFAULT now()' : '';
        return `"${column.name}" ${type}${primary}${defaults}`;
      });
      await conn.unsafe(`create table "${getTableName(table)}" (${columns.join(',')})`);
    }
    db = drizzle(conn) as unknown as DB; setS3Storage(storage);
  });
  afterAll(async () => {
    resetS3Storage(); await conn?.end();
    if (admin) { await admin.unsafe(`drop schema if exists "${schema}" cascade`); await admin.end(); }
  });

  it('atomically closes a route-proven never-sent upload for active and already-unknown runs', async () => {
    for (const alreadyUnknown of [false, true]) {
      const workItemId = randomUUID(), runId = randomUUID(), grantId = randomUUID();
      const transportId = 'transport-centurion', actorUserId = 'synthetic-staff';
      const fence = { runId, claimOwner: 'synthetic-worker', claimToken: randomUUID(), deadlineAt: new Date(Date.now() + 60_000) };
      await db.insert(workItem).values({ id: workItemId, transportId, kind: 'payment', status: 'needs_you',
        state: { hmsSnapshot: { digest: 'd'.repeat(64) } } });
      await db.insert(aiWorkflowRun).values({ id: runId, workItemId, transportId, threadId: 'thread-synthetic',
        runKind: 'hms_write', promptVersion: HMS_LABTEST_ATTACH_PROMPT_VERSION, modelId: 'n/a', executorLane: 'hms',
        idempotencyKey: `hms-write:${grantId}`, state: 'running', claimOwner: fence.claimOwner, claimToken: fence.claimToken,
        deadlineAt: fence.deadlineAt, metrics: {} });
      const { frame, token, fields, file, request } = syntheticUpload();
      const before = await recordHmsWriteEvidence({ db, transportId, workItemId, runId, name: 'before.png', png });
      const claim = { workItemId, transportId, actorUserId, grantId, propertyCode: 'HRCEN' as const,
        firstName: 'Proof' as const, lastName: 'Labtest' as const, nativeGuestId: '123', operation: 'attach_document' as const,
        sourceDigest: 'a'.repeat(64), approvedDigest: 'b'.repeat(64), requestDigest: documentUploadRequestDigest(request)!,
        recovery: { confirmation: '123456-1', arrival: '2027-10-12', departure: '2027-10-13',
          documentCode: file.documentCode, documentName: file.name, pdfSha256: sha(file.bytes.toString()), runId,
          claimDigest: sha(canonicalJson({ claimOwner: fence.claimOwner, claimToken: fence.claimToken })),
          before: { eventId: before.eventId, sha256: before.sha256 }, writer: { synthetic: true } } };
      const epoch = await captureHmsLabtestDispatchEpoch(db), dir = await mkdtemp(join(tmpdir(), 'u6-no-dispatch-pg-'));
      let sent = 0, aborted = 0;
      let entered!: () => void, release!: () => void;
      const claiming = new Promise<void>((resolve) => { entered = resolve; });
      const late = new Promise<void>((resolve) => { release = resolve; });
      try {
        const route = { request: () => request, continue: () => { sent++; return 'sent'; },
          abort: () => { aborted++; return 'aborted'; } };
        const gate = createDocumentUploadGate({ frame, token, fields, file, evidenceDir: dir, confirmation: '123456-1',
          onDispatch: () => {}, onIntentError: () => {}, onAuthorityError: () => {},
          dispatchWithAuthority: async (next: (() => Promise<unknown>) & { proveNeverDispatched: () => unknown },
            _digest: string, _before: string, intercepted: unknown) => {
            const handle = await claimHmsLabtestDispatch(db, claim, async () => {}, epoch);
            if (alreadyUnknown) { entered(); await late; }
            gate.disarm();
            try { await next(); } catch (error) {
              const proof = next.proveNeverDispatched();
              await expect(resolveNeverDispatchedAttach(db, handle, {}, intercepted, async () => {}))
                .rejects.toMatchObject({ reason: 'invalid' });
              await expect(resolveNeverDispatchedAttach(db, handle, proof, { ...request }, async () => {}))
                .rejects.toMatchObject({ reason: 'invalid' });
              await resolveNeverDispatchedAttach(db, handle, proof, intercepted,
                (tx, intent) => recordNeverDispatchedAttach(tx, intent, fence));
              throw error;
            }
          } });
        const admitted = gate(route, { candidate: request, armed: true, checkStatus: 200, blocked: 0 });
        expect(admitted).not.toBeNull();
        if (alreadyUnknown) {
          await claiming; gate.disarm();
          expect(await gate.drain(5)).toBe(false);
          await conn`update ai_workflow_run set state = 'dead_letter', failure_class = 'UNKNOWN',
            claim_owner = null, claim_token = null where id = ${runId}`;
          release();
        }
        await admitted!.result;
        expect(sent).toBe(0); expect(aborted).toBe(1);
        const [run] = await conn`select state, failure_class, last_error from ai_workflow_run where id = ${runId}`;
        expect(run).toMatchObject({ state: 'dead_letter', failure_class: 'NEEDS_CHECK', last_error: 'filing_not_dispatched' });
        const [item] = await conn`select state from work_item where id = ${workItemId}`;
        expect(item.state).not.toHaveProperty('hmsSnapshot');
        const history = await conn`select value from work_event where work_item_id = ${workItemId}
          and field_path = 'nava.hms.labtest.dispatch.v1' order by at, id`;
        expect(history.map((row) => row.value.kind)).toEqual(['intent', 'not_dispatched']);
        const laterEpoch = await captureHmsLabtestDispatchEpoch(db);
        await expect(claimHmsLabtestDispatch(db, claim, async () => {}, laterEpoch)).rejects.toMatchObject({ reason: 'occupied' });
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });

  it('holds on missing quiescence, absent readback or failed commit, then atomically records the original confirmed run', async () => {
    const workItemId = randomUUID(), runId = randomUUID(), grantId = randomUUID();
    const transportId = 'transport-centurion', actorUserId = 'synthetic-staff';
    await db.insert(workItem).values({ id: workItemId, transportId, kind: 'payment', status: 'needs_you', state: {} });
    await db.insert(aiWorkflowRun).values({ id: runId, workItemId, transportId, threadId: 'thread-synthetic',
      runKind: 'hms_write', promptVersion: HMS_LABTEST_ATTACH_PROMPT_VERSION, modelId: 'n/a', executorLane: 'hms',
      idempotencyKey: `hms-write:${grantId}`, state: 'dead_letter', failureClass: 'UNKNOWN', metrics: {} });
    const grant = { grantId, workItemId, transportId, actorUserId, sessionId: 'session-1', sessionProfile: 'remote',
      formDigest: 'b'.repeat(64), hmsBeforeDigest: 'd'.repeat(64), hmsReadAt: new Date().toISOString() };
    const payloadHash = sha(canonicalJson(grant));
    await db.insert(workEvent).values({ id: grantId, workItemId, actorKind: 'user', actorUserId,
      type: 'approval.granted', payloadHash, value: grant });
    await db.insert(workEvent).values({ workItemId, actorKind: 'system', type: 'approval.consumed', payloadHash,
      value: { runId, grantId } });
    const before = await recordHmsWriteEvidence({ db, transportId, workItemId, runId, name: 'before.png', png });
    const claim = { workItemId, transportId, actorUserId, grantId, propertyCode: 'HRCEN' as const,
      firstName: 'Proof' as const, lastName: 'Labtest' as const, nativeGuestId: '123', operation: 'attach_document' as const,
      sourceDigest: 'a'.repeat(64), approvedDigest: grant.formDigest, requestDigest: 'c'.repeat(64),
      recovery: { confirmation: '123456-1', arrival: '2027-10-12', departure: '2027-10-13',
        documentCode: 'NAVAAAAAAAAAAAAAAAAAAAAAAAAAAA', documentName: 'voucher.pdf', pdfSha256: 'd'.repeat(64),
        runId, claimDigest: 'e'.repeat(64), before: { eventId: before.eventId, sha256: before.sha256 }, writer: { synthetic: true } } };
    const epoch = await captureHmsLabtestDispatchEpoch(db);
    const handle = await claimHmsLabtestDispatch(db, claim, async () => {}, epoch);
    f.quiesced = false;
    await expect(recoverHmsLabtestAttach(db, handle.holdId)).rejects.toMatchObject({ reason: 'phase' });
    expect(f.reads).toBe(0);
    f.quiesced = true;
    await storage.deleteObject(before.key);
    await expect(recoverHmsLabtestAttach(db, handle.holdId)).rejects.toThrow('filing_recovery_evidence_unavailable');
    expect(f.reads).toBe(0);
    await storage.putObject({ key: before.key, body: png, contentType: 'image/png' });
    f.failRead = true;
    await expect(recoverHmsLabtestAttach(db, handle.holdId)).rejects.toThrow('filing_recovery_readback_unavailable');
    f.failRead = false;
    f.mismatch = true;
    await expect(recoverHmsLabtestAttach(db, handle.holdId)).rejects.toThrow('filing_recovery_readback_unavailable');
    f.mismatch = false; f.loseQuiescence = true;
    await expect(recoverHmsLabtestAttach(db, handle.holdId)).rejects.toMatchObject({ reason: 'phase' });
    f.loseQuiescence = false; f.quiesced = true;
    await conn`update work_event set payload_hash = ${'0'.repeat(64)} where id = ${grantId}`;
    await expect(recoverHmsLabtestAttach(db, handle.holdId)).rejects.toThrow('no_grant');
    expect(await conn`select id from work_event where value->>'kind' = 'resolved'`).toHaveLength(0);
    expect((await conn`select state from ai_workflow_run where id = ${runId}`)[0]?.state).toBe('dead_letter');
    await conn`update work_event set payload_hash = ${payloadHash} where id = ${grantId}`;
    await conn`update ai_workflow_run set state = 'running', failure_class = null,
      claim_owner = 'different-worker', claim_token = ${randomUUID()} where id = ${runId}`;
    await expect(recoverHmsLabtestAttach(db, handle.holdId)).rejects.toThrow('filing_recovery_run_changed');
    await conn`update ai_workflow_run set state = 'dead_letter', failure_class = 'UNKNOWN',
      claim_owner = null, claim_token = null where id = ${runId}`;
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    f.entered = entered; f.release = new Promise<void>((resolve) => { release = resolve; });
    const running = recoverHmsLabtestAttach(db, handle.holdId);
    await reading;
    await expect(claimHmsLabtestDispatch(db, { ...claim, grantId: randomUUID() }, async () => {}, epoch))
      .rejects.toMatchObject({ reason: 'occupied' });
    release(); await running; f.entered = null; f.release = null;
    const [run] = await conn`select state, failure_class, metrics from ai_workflow_run where id = ${runId}`;
    expect(run).toMatchObject({ state: 'succeeded', failure_class: null,
      metrics: { action: 'attach_document', outcome: 'confirmed', listed: true, recovered: true } });
    expect(await conn`select id from work_event where value->>'kind' = 'resolved'`).toHaveLength(1);
    const laterEpoch = await captureHmsLabtestDispatchEpoch(db);
    expect(laterEpoch).not.toBe(epoch);
    await expect(claimHmsLabtestDispatch(db, { ...claim, grantId: randomUUID() }, async () => {}, epoch))
      .rejects.toMatchObject({ reason: 'occupied' });
    await expect(claimHmsLabtestDispatch(db, claim, async () => {}, laterEpoch)).rejects.toMatchObject({ reason: 'occupied' });
    await claimHmsLabtestDispatch(db, { ...claim, grantId: randomUUID() }, async () => {}, laterEpoch);
  });
});
