import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimPaneStayCommit, finishPaneStayCommit } from '../src/ai/pane-stay-commit-guard.js';
import { openTestDbSession, TEST_DB_AVAILABLE } from './helpers/test-db.js';

// Separate sessions exercise PostgreSQL's real transaction lock and JSON predicates on a disposable database.
describe.skipIf(!TEST_DB_AVAILABLE)('property-wide pane save fence', () => {
  const schemaName = `pane_save_${randomUUID().replaceAll('-', '')}`;
  let first: ReturnType<typeof openTestDbSession>;
  let second: ReturnType<typeof openTestDbSession>;
  let created = false;
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
  ];
  const scope = (index: number, transportId: string) => ({
    workItemId: ids[index]!, transportId, stayId: `s_${index + 1}`,
  });
  const unknown = { status: 'unknown', confirmationNumber: null, screenshotRef: null };
  const booked = { status: 'booked' as const, confirmationNumber: '11111111-1', screenshotRef: null };

  async function insert(index: number, transportId: string, state: unknown = {}) {
    await first.db.execute(sql`insert into work_item (id, transport_id, state)
      values (${ids[index]}, ${transportId}, ${JSON.stringify(state)}::jsonb)`);
  }

  beforeAll(async () => {
    first = openTestDbSession();
    second = openTestDbSession();
    await first.db.execute(sql.raw(`create schema "${schemaName}"`));
    created = true;
    await first.db.execute(sql.raw(`set search_path to "${schemaName}"`));
    await second.db.execute(sql.raw(`set search_path to "${schemaName}"`));
    await first.db.execute(sql`create table work_item (
      id uuid primary key, transport_id text not null, state jsonb not null default '{}'::jsonb,
      updated_at timestamp not null default now()
    )`);
  });
  beforeEach(async () => { await first.db.execute(sql`delete from work_item`); });
  afterAll(async () => {
    if (created) await first.db.execute(sql.raw(`drop schema "${schemaName}" cascade`));
    await Promise.all([first?.close(), second?.close()]);
  });

  it('blocks a different mailbox and omitted parent at the same property, but not another hotel', async () => {
    await insert(0, 'transport-davinci', { stays: { s_1: unknown } });
    await insert(1, 'transport-faith');
    await insert(2, 'transport-centurion');
    expect(await claimPaneStayCommit(second.db, scope(1, 'transport-faith')))
      .toEqual({ status: 'refused', reason: 'pane_save_dependency_unconfirmed' });
    const otherHotel = await claimPaneStayCommit(second.db, scope(2, 'transport-centurion'));
    expect(otherHotel.status).toBe('ready');
  });

  it.each([
    { stays: { s_1: { ...unknown, confirmationNumber: '11111111-1' } } },
    { paneStaySaveClaims: { s_1: 'stranded-claim' } },
    { stays: null },
    { stays: { s_1: { status: 'booked', confirmationNumber: '' } } },
    { stays: { s_1: { status: 'booked', confirmationNumber: ' \t\n ' } } },
    { stays: { s_1: { status: 'booked', confirmationNumber: 'not-a-confirmation' } } },
    { stays: { 'bad id': booked } },
  ])('holds a property for unresolved or malformed legacy state', async (state) => {
    await insert(0, 'transport-centurion', state);
    await insert(1, 'transport-centurion');
    expect(await claimPaneStayCommit(second.db, scope(1, 'transport-centurion')))
      .toEqual({ status: 'refused', reason: 'pane_save_dependency_unconfirmed' });
  });

  it('allows another item when the prior receipt is confirmed', async () => {
    await insert(0, 'transport-centurion', { stays: { s_1: booked } });
    await insert(1, 'transport-centurion');
    expect((await claimPaneStayCommit(second.db, scope(1, 'transport-centurion'))).status).toBe('ready');
  });

  it('serializes concurrent claims across work items and retains a confirmed receipt', async () => {
    await insert(0, 'transport-davinci');
    await insert(1, 'transport-faith');
    const inputs = [scope(0, 'transport-davinci'), scope(1, 'transport-faith')];
    const results = await Promise.all([
      claimPaneStayCommit(first.db, inputs[0]!), claimPaneStayCommit(second.db, inputs[1]!),
    ]);
    const winner = results.findIndex((result) => result.status === 'ready');
    const loser = 1 - winner;
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(results[loser]).toEqual({ status: 'refused', reason: 'pane_save_dependency_unconfirmed' });
    const claim = results[winner]!;
    if (claim.status !== 'ready') throw new Error('expected one claim');
    expect(await finishPaneStayCommit(first.db, { ...inputs[winner]!, claimId: claim.claimId, record: booked }))
      .toBe(true);
    expect((await claimPaneStayCommit(second.db, inputs[loser]!)).status).toBe('ready');
    const rows = await first.db.execute(sql`select state from work_item where id = ${inputs[winner]!.workItemId}`);
    expect(rows[0]?.state).toMatchObject({ stays: { [inputs[winner]!.stayId]: booked } });
  });
});
