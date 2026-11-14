import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { message } from '../src/db/schema/mail.js';
import { workItem } from '../src/db/schema/work.js';
import { approveHmsWrite, formDigest, storeHmsSnapshot, publicHmsPreparedSummary } from '../src/ai/hms-approval.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { hmsApprovalRouter } from '../src/trpc/routes/hms-approval.js';
import { hmsPreparationSchema, hmsWriteGrantV2Schema, loadHmsPreparation,
  preparationDigest } from '../src/hms/hms-preparation.js';
import { resolvePropertyScope } from '../src/hms/property-registry.js';

const transportId = 'transport-centurion';
const workItemId = '48a2ac3d-b4c8-48f1-a17e-4a8f1f31b3a6';
const selected = '<Selected@Example.com>';
const source = { id: 'message-1', threadId: 'thread-1', direction: 'inbound',
  transportId, messageIdHeader: 'selected@example.com', subject: 'Voucher', textBody: 'Original mail', htmlBody: null };

function fixture() {
  const item = { id: workItemId, transportId, sourceMessageId: source.id, threadId: source.threadId,
    status: 'needs_you', state: { action: 'amend', arrival: '2027-09-14' } };
  let messages = [{ ...source }];
  const operations: string[] = [];
  const dialect = new PgDialect();
  const select = vi.fn(() => {
    let table: unknown;
    let params: unknown[] = [];
    const query = {
      from: (value: unknown) => { table = value; return query; },
      innerJoin: () => query,
      where: (value: SQL) => { params = dialect.sqlToQuery(value).params; return query; },
      limit: (n: number) => {
        const rows = table === workItem
          ? (params.includes(item.id) && params.includes(item.transportId) ? [item] : [])
          : table === message
            ? messages.filter((row) => params[1] === row.messageIdHeader
              ? row.transportId === params[0] && (params.length === 2 || (row.id === params[2] && row.threadId === params[3]))
              : row.id === params[0] && row.transportId === params[1] && row.threadId === params[2] && row.direction === params[3])
            : [];
        const result = Promise.resolve(rows.slice(0, n));
        return Object.assign(result, { for: async (mode: string) => {
          operations.push(`${table === workItem ? 'item' : 'message'}:${mode}`);
          return result;
        } });
      },
    };
    return query;
  });
  const update = vi.fn(() => ({ set: () => ({ where: async () => undefined }) }));
  const insert = vi.fn(() => { throw new Error('unexpected insert'); });
  const db = { select, update, insert,
    execute: vi.fn(async () => { operations.push('mailbox:lock'); }),
    transaction: async (callback: (tx: DB) => Promise<unknown>) => callback(db as unknown as DB),
  } as unknown as DB;
  const caller = () => hmsApprovalRouter.createCaller({ auth: null as never, reqHeaders: new Headers(),
    sessionUser: { id: 'staff', email: 'staff@example.invalid', name: 'Staff' },
    activeTransportId: transportId, accessRole: 'owner', transportEmail: 'hotel@example.invalid' } as never);
  return { db, item, update, insert, operations, caller, setMessages: (next: typeof messages) => { messages = next; } };
}

afterEach(() => __setDbForTests(null));

describe('approval selected-email scope', () => {
  it('requires a selected email on every mounted approval procedure', async () => {
    const f = fixture();
    __setDbForTests({ db: f.db, conn: null as never });
    const caller = f.caller();
    const missing = { workItemId };
    for (const request of [
      () => caller.writeState(missing as never), () => caller.reread(missing as never),
      () => caller.approve({ ...missing, formDigest: 'a'.repeat(64) } as never),
      () => caller.review({ ...missing, runId: workItemId, decision: 'ok' } as never),
      () => caller.resolveNeedsCheck({ ...missing, note: 'checked' } as never),
      () => caller.evidence({ ...missing, eventId: workItemId } as never),
    ]) await expect(request()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.operations).toEqual([]);
  });

  it('rejects wrong, ambiguous, outbound, cross-thread and cross-mailbox sources before approval', async () => {
    for (const messages of [[], [{ ...source, id: 'message-other' }], [source, { ...source, id: 'duplicate' }],
      [{ ...source, direction: 'outbound' }], [{ ...source, threadId: 'thread-other' }],
      [{ ...source, transportId: 'another-mailbox' }]]) {
      const f = fixture();
      f.setMessages(messages);
      await expect(approveHmsWrite({ db: f.db, transportId, workItemId, actorUserId: 'staff',
        selectedInternetMessageId: selected, formDigest: 'wrong' })).rejects.toMatchObject({ refusal: 'source_mail_changed' });
      expect(f.operations).toEqual(['mailbox:lock', 'item:update', 'message:share']);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.insert).not.toHaveBeenCalled();
    }
  });

  it('canonicalizes the selected header and admits an exact inbound source despite another identical header', async () => {
    const f = fixture();
    f.setMessages([source, { ...source, id: 'duplicate' }]);
    const selectedSource = { messageId: source.id, threadId: source.threadId, sourceHash: staffQuoteSourceHash(source) };
    await expect(approveHmsWrite({ db: f.db, transportId, workItemId, actorUserId: 'staff',
      selectedInternetMessageId: selected, selectedSource, formDigest: 'wrong' })).rejects.toMatchObject({ refusal: 'form_outdated' });
    expect(f.operations).toEqual(['mailbox:lock', 'item:update', 'message:share']);
    expect(f.insert).not.toHaveBeenCalled();
    for (const changed of [
      { ...selectedSource, sourceHash: '0'.repeat(64) },
      { ...selectedSource, messageId: 'duplicate' },
      { ...selectedSource, threadId: 'other-thread' },
    ]) {
      const mismatch = fixture();
      mismatch.setMessages([source, { ...source, id: 'duplicate' }]);
      await expect(approveHmsWrite({ db: mismatch.db, transportId, workItemId, actorUserId: 'staff',
        selectedInternetMessageId: selected, selectedSource: changed, formDigest: 'wrong' }))
        .rejects.toMatchObject({ refusal: 'source_mail_changed' });
      expect(mismatch.insert).not.toHaveBeenCalled();
    }
    __setDbForTests({ db: f.db, conn: null as never });
    const caller = f.caller();
    const request = { workItemId, internetMessageId: selected, selectedSource };
    f.item.status = 'done';
    await expect(caller.review({ ...request, runId: workItemId, decision: 'ok' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'not_open' });
    f.item.state.action = 'attach_document';
    await expect(caller.resolveNeedsCheck({ ...request, note: 'checked' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'filing_unavailable' });
    await expect(caller.evidence({ ...request, eventId: workItemId }))
      .resolves.toEqual({ status: 'unavailable', reason: 'evidence_unavailable' });
  });

  it('rejects a changed selection on each mounted action before a side effect', async () => {
    const f = fixture();
    __setDbForTests({ db: f.db, conn: null as never });
    const caller = f.caller();
    const input = { workItemId, internetMessageId: '<other@example.com>' };
    for (const request of [
      () => caller.writeState(input), () => caller.reread(input),
      () => caller.approve({ ...input, formDigest: 'a'.repeat(64) }),
      () => caller.review({ ...input, runId: workItemId, decision: 'ok' }),
      () => caller.resolveNeedsCheck({ ...input, note: 'checked' }),
      () => caller.evidence({ ...input, eventId: workItemId }),
    ]) await expect(request()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'source_mail_changed' });
    const stale = { workItemId, internetMessageId: selected, selectedSource: {
      messageId: source.id, threadId: source.threadId, sourceHash: '0'.repeat(64) } };
    for (const request of [
      () => caller.review({ ...stale, runId: workItemId, decision: 'ok' }),
      () => caller.resolveNeedsCheck({ ...stale, note: 'checked' }),
      () => caller.evidence({ ...stale, eventId: workItemId }),
    ]) await expect(request()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'source_mail_changed' });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('refuses to store a read made for a form or source that changed during HMS lookup', async () => {
    const f = fixture();
    const expectedFormDigest = formDigest(f.item.state);
    await expect(storeHmsSnapshot({ db: f.db, transportId, workItemId, selectedInternetMessageId: selected,
      expectedFormDigest, readHmsState: async () => { f.item.state.arrival = '2027-09-15'; return {}; },
    })).rejects.toMatchObject({ refusal: 'form_outdated' });
    expect(f.update).not.toHaveBeenCalled();
    f.item.state.arrival = '2027-09-14';
    await expect(storeHmsSnapshot({ db: f.db, transportId, workItemId, selectedInternetMessageId: selected,
      expectedFormDigest, readHmsState: async () => { f.item.sourceMessageId = 'message-other'; return {}; },
    })).rejects.toMatchObject({ refusal: 'source_mail_changed' });
    expect(f.update).not.toHaveBeenCalled();
  });
});

const preparedFixture = () => {
  const fields = { action: 'cancel', confirmation: '123456-1', reason: 'Guest request' };
  const aliases = ['verified:123456-1'];
  return hmsPreparationSchema.parse({ version: 2, preparedRef: '7a1c23e2-0f23-4dbe-89c1-61f6beb0674a', workItemId,
    scope: resolvePropertyScope({ transportId }), session: { actorUserId: 'staff', sessionId: 'staff-session', sessionProfile: 'remote' },
    source: { transportId, threadId: source.threadId, sourceMessageId: source.id, sourceHash: staffQuoteSourceHash(source) },
    generationId: 'generation-2', revision: 2, operation: 'cancel', targetAliases: aliases,
    businessFields: fields, businessDigest: preparationDigest(fields), targetDigest: preparationDigest(aliases),
    nativeObservation: { beforeDigest: 'a'.repeat(64), capturedAt: '2026-11-14T07:00:00.000Z', price: null, warnings: [] },
    policyIdentity: 'policy-v2', catalogueIdentity: 'catalogue-v2', capturedAt: '2026-11-14T07:01:00.000Z',
    expiresAt: '2026-11-14T07:30:00.000Z' });
};

describe('durable HMS preparation and v2 Go receipt', () => {
  it('round-trips preparation through JSON and rejects altered persisted evidence', async () => {
    const prepared = preparedFixture();
    let row = { value: JSON.parse(JSON.stringify(prepared)), payloadHash: preparationDigest(prepared),
      actorKind: 'user', actorUserId: 'staff', expiresAt: new Date(prepared.expiresAt) };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [row] }) }) }) }) } as unknown as DB;
    await expect(loadHmsPreparation(db, prepared.preparedRef, workItemId)).resolves.toEqual(prepared);
    row = { ...row, value: { ...row.value, targetDigest: 'b'.repeat(64) } };
    await expect(loadHmsPreparation(db, prepared.preparedRef, workItemId)).rejects.toThrow('hms_preparation_invalid');
  });

  it('requires exact source/scope and snapshot expiry and refuses private browser data', () => {
    const prepared = preparedFixture();
    expect(hmsPreparationSchema.safeParse({ ...prepared, source: { ...prepared.source, transportId: 'transport-davinci' } }).success).toBe(false);
    expect(hmsPreparationSchema.safeParse({ ...prepared, expiresAt: '2026-11-14T07:31:00.000Z' }).success).toBe(false);
    expect(hmsPreparationSchema.safeParse({ ...prepared, businessFields: { storageState: {} } }).success).toBe(false);
  });

  it('requires session, preparation, property and all business/source bindings on new receipts', () => {
    const p = preparedFixture();
    const grant = { version: 2, grantId: 'abf42ce1-17dc-4b87-9ac9-fd4a96f6425a', preparedRef: p.preparedRef,
      workItemId, ...p.session, transportId, threadId: p.source.threadId, sourceMessageId: p.source.sourceMessageId,
      sourceHash: p.source.sourceHash, propertyCode: p.scope.propertyCode, tenantId: p.scope.tenantId,
      operation: p.operation, generationId: p.generationId, expectedRevision: p.revision,
      businessDigest: p.businessDigest, targetDigest: p.targetDigest, formDigest: p.businessDigest,
      hmsBeforeDigest: p.nativeObservation.beforeDigest, hmsReadAt: p.nativeObservation.capturedAt,
      issuedAt: p.capturedAt, expiresAt: p.expiresAt };
    expect(hmsWriteGrantV2Schema.safeParse(JSON.parse(JSON.stringify(grant))).success).toBe(true);
    for (const field of ['sessionId', 'sessionProfile', 'preparedRef', 'sourceHash', 'targetDigest', 'generationId', 'propertyCode']) {
      const incomplete: Record<string, unknown> = { ...grant };
      delete incomplete[field];
      expect(hmsWriteGrantV2Schema.safeParse(incomplete).success).toBe(false);
    }
    expect(hmsWriteGrantV2Schema.safeParse({ ...grant, formDigest: 'c'.repeat(64) }).success).toBe(false);
  });
});


it('uses the pane privacy projection for the durable preparation summary', () => {
  const prepared = preparedFixture();
  prepared.businessFields.reservationNote = 'Card 4111111111111111';
  prepared.businessFields.cloudCancel = { preimage: { privateNativeField: 'not public' } };
  prepared.businessDigest = preparationDigest(prepared.businessFields);
  const summary = publicHmsPreparedSummary(prepared);
  expect(summary.stagedFields.cloudCancel).toEqual({});
  expect(JSON.stringify(summary)).not.toContain('4111111111111111');
  expect(JSON.stringify(summary)).not.toContain('privateNativeField');
  expect(summary).not.toHaveProperty('scope');
});
