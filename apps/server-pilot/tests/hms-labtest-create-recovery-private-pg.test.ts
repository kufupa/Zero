import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { DB } from '../src/db/client.js';
import { claimHmsLabtestDispatch, recoverHmsLabtestCreate } from '../src/ai/hms-labtest-dispatch.js';

const f = vi.hoisted(() => ({ quiesced: true, proofFails: false, recordFails: false, reads: 0 }));
vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', async (original) => ({
  ...await original<typeof import('../tooling/playwright-quote/centurion-stay360.mjs')>(),
  centurionWriterQuiesced: () => f.quiesced,
}));
vi.mock('../src/ai/pane-cloud-preview.js', () => ({
  withRecoveryLock: async (_intent: unknown, run: () => Promise<unknown>) => run(),
  proveCreateRecovery: async () => {
    f.reads += 1;
    if (f.proofFails) throw new Error('synthetic read unavailable');
    return { confirmation: '123456-1', readbackDigest: 'd'.repeat(64),
      savedShot: { runId: randomUUID(), sha256: 'e'.repeat(64) }, shots: [] };
  },
  recordRecoveredCreate: async (tx: any, intent: { grantId: string }) => {
    await tx.execute(sql`insert into synthetic_receipt (grant_id) values (${intent.grantId})`);
    if (f.recordFails) throw new Error('synthetic receipt failure');
  },
}));

const root = process.env.NAVA_U3_PRIVATE_PG_ROOT;
describe.skipIf(!root)('positive Create recovery on a private synthetic PostgreSQL socket', () => {
  let conn: ReturnType<typeof postgres>, db: DB;
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.TEST_DATABASE_URL).toBeUndefined();
    expect(process.env.VITEST_ALLOW_PILOT_RDS).toBeUndefined();
    expect(root).toMatch(/^\/tmp\/nava-u3-positive-pg-[A-Za-z0-9]+$/);
    expect(await realpath(root!)).toBe(root);
    const dir = await stat(root!);
    expect(dir.uid).toBe(process.getuid?.());
    expect(dir.mode & 0o077).toBe(0);
    conn = postgres({ host: `${root}/socket`, port: 55464, username: 'nava_u3', database: 'postgres', ssl: false, max: 4 });
    const [identity] = await conn`select current_setting('data_directory') as dir,
      current_setting('listen_addresses') as listen, inet_server_addr() is null as socket_only, current_user as username`;
    expect(identity).toMatchObject({ dir: `${root}/data`, listen: '', socket_only: true, username: 'nava_u3' });
    await conn.unsafe(`create table work_event (
      id uuid primary key default gen_random_uuid(), work_item_id uuid not null,
      at timestamp not null default now(), actor_kind text not null, actor_user_id text,
      type text not null, field_path text, ai_value jsonb, value jsonb, ai_source text,
      ms_since_open integer, payload_hash text, expires_at timestamp, evidence jsonb)`);
    await conn.unsafe('create table synthetic_receipt (grant_id uuid primary key)');
    db = drizzle(conn) as unknown as DB;
  });
  afterAll(async () => { await conn?.end(); });

  it('keeps UNKNOWN on failed quiescence, readback or result recording; success resolves atomically without replay', async () => {
    const claim = { workItemId: randomUUID(), transportId: 'synthetic', actorUserId: 'staff', grantId: randomUUID(),
      propertyCode: 'HRCEN' as const, firstName: 'Proof' as const, lastName: 'Labtest' as const,
      nativeGuestId: '123', operation: 'create' as const, stayId: 's1_1', sourceDigest: 'a'.repeat(64),
      approvedDigest: 'b'.repeat(64), requestDigest: 'c'.repeat(64), recovery: { writer: { synthetic: true } } };
    const handle = await claimHmsLabtestDispatch(db, claim, async () => {});
    f.quiesced = false;
    await expect(recoverHmsLabtestCreate(db, handle.holdId)).rejects.toMatchObject({ reason: 'phase' });
    expect(f.reads).toBe(0);
    f.quiesced = true; f.proofFails = true;
    await expect(recoverHmsLabtestCreate(db, handle.holdId)).rejects.toThrow('synthetic read unavailable');
    f.proofFails = false; f.recordFails = true;
    await expect(recoverHmsLabtestCreate(db, handle.holdId)).rejects.toThrow('synthetic receipt failure');
    expect(await conn`select grant_id from synthetic_receipt`).toHaveLength(0);
    expect(await conn`select id from work_event where value->>'kind' = 'resolved'`).toHaveLength(0);
    await expect(claimHmsLabtestDispatch(db, { ...claim, grantId: randomUUID() }, async () => {}))
      .rejects.toMatchObject({ reason: 'occupied' });
    f.recordFails = false;
    await recoverHmsLabtestCreate(db, handle.holdId);
    expect(await conn`select grant_id from synthetic_receipt`).toHaveLength(1);
    const resolved = await conn`select value from work_event where value->>'kind' = 'resolved'`;
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.value).toMatchObject({ recovered: true, holdId: handle.holdId, confirmation: '123456-1' });
    await expect(claimHmsLabtestDispatch(db, claim, async () => {})).rejects.toMatchObject({ reason: 'occupied' });
    await claimHmsLabtestDispatch(db, { ...claim, grantId: randomUUID() }, async () => {});
  });
});
