import { createHash } from 'node:crypto';
import { getTableName, type Table } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { workbookToBytes } from '@office-kit/xlsx/io';
import { addWorksheet, createWorkbook } from '@office-kit/xlsx/workbook';
import { setCell } from '@office-kit/xlsx/worksheet';
import type { DB } from '../src/db/client.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { loadReservationistMailboxInput } from '../src/ai/reservationist-mailbox-input.js';
import { assertMetadataSourceRecoveries, assertReservationistDraftSource, draftSourceMessage, sealReservationistDraftSource } from '../src/ai/reservationist-draft-source.js';
import { reservationistMessageAt } from '../src/ai/reservationist-worker-input.js';

function setup() {
  const now = Date.now(), deadline = new Date(now + 180_000);
  const message = (id: string, minutes: number, direction: 'inbound' | 'outbound', fromAddress: string) => ({
    id, transportId: 'mailbox', threadId: 'thread', direction, fromAddress, textBody: `${id} text`,
    htmlBody: null as string | null, subject: null, toAddresses: direction === 'outbound' ? ['Guest <guest@example.invalid>'] : [],
    ccAddresses: [], bccAddresses: [], receivedAt: new Date(now + minutes * 60_000),
    sentAt: direction === 'outbound' ? new Date(now + minutes * 60_000) : null,
    pop3Uidl: null as string | null, sourceProvenance: null as Record<string, unknown> | null,
    arrivedAt: new Date(now + minutes * 60_000), createdAt: new Date(now + minutes * 60_000),
  });
  const state = {
    grant: true, claim: true,
    binding: { id: 'run', transportId: 'mailbox', threadId: 'thread', triggerId: 'current', generationId: 'generation',
      requestedByUserId: 'staff', deadlineAt: deadline, grantId: 'grant', grantRole: 'member', grantUpdatedAt: new Date(now - 600_000) },
    rows: [message('earlier', -4, 'inbound', 'guest@example.invalid'), message('staff', -3, 'outbound', 'hotel@example.invalid'),
      message('other', -2, 'inbound', 'other@example.invalid'), message('current', -1, 'inbound', 'guest@example.invalid')],
    files: [] as Array<{ id: string; messageId: string; mimeType: string; sizeBytes: number; sha256: string | null; s3Key: string; isInline: boolean; contentId: string | null }>,
  };
  // This fixture models query results, not PostgreSQL's predicate evaluation.
  const db = { select(selection: Record<string, unknown>) {
    let table = '';
    const result = () => {
      if (table === 'ai_workflow_run') return state.grant && state.claim ? [state.binding] : [];
      if (table === 'mail_draft_revision') return [];
      if (table === 'attachment') return state.files;
      if (table === 'message') {
        if ('fromAddress' in selection && !('transportId' in selection)) return state.rows.filter((row) => row.id === state.binding.triggerId);
        if ('transportId' in selection) {
          const cutoff = state.rows.find((r) => r.id === state.binding.triggerId)!.arrivedAt;
          return state.rows.filter((row) => { const at = reservationistMessageAt(row); return at && at <= cutoff; });
        }
        return state.rows;
      }
      throw new Error(`unexpected table ${table}`);
    };
    const query = Promise.resolve().then(result);
    return Object.assign(query, {
      from(value: Table) { table = getTableName(value); return query; },
      innerJoin() { return query; }, where() { return query; }, orderBy() { return query; },
      limit(count: number) { return Promise.resolve(result().slice(0, count)); },
    });
  } } as unknown as DB;
  const s3 = new FakeS3Storage();
  const args = { db, runId: 'run', claimOwner: 'worker', claimToken: 'token', deadlineAt: deadline, propertyCode: 'HRCEN', s3, signal: new AbortController().signal };
  return { state, args, s3, message };
}

describe('reservationist mailbox input', () => {
  it('seals an ignored signature by metadata without reading its bytes, and detects changed identity', async () => {
    const { state, args, s3 } = setup();
    state.rows.find((row) => row.id === 'current')!.textBody = 'Please quote two rooms.\nKind regards\nGuest\nTel: 12345\nEmail: info@example.invalid\nWebsite: example.invalid\nhttps://hotel.example.invalid\ncid:logo';
    state.files.push({ id: 'logo', messageId: 'current', mimeType: 'image/png', sizeBytes: 21 * 1024 * 1024,
      sha256: null, s3Key: 'attachments/current/logo.png', isInline: true, contentId: 'logo' });
    const read = vi.spyOn(s3, 'getObjectBounded');
    const result = await loadReservationistMailboxInput(args);
    expect(result.ignoredSignatureIds).toEqual(['logo']);
    expect(result.admissions).toEqual([]);
    const persisted = { version: 1 as const, readiness: 'no_action' as const, tasks: [], quoteRevisionIds: [], artifactRefs: [], actionDigest: 'a'.repeat(64) };
    const source = await result.createDraftSource({ tasks: [], facts: [] }, persisted);
    expect(source.attachments).toMatchObject([{ attachmentId: 'logo', sourceIdentity: 'ignored_signature', contentId: 'logo' }]);
    const sealed = sealReservationistDraftSource({ ...source, resultDigest: 'b'.repeat(64) });
    expect(() => assertMetadataSourceRecoveries(sealed, persisted)).not.toThrow();
    const changed = { ...source, resultDigest: 'b'.repeat(64), attachments: source.attachments.map(item => ({ ...item, contentId: 'different' })) };
    expect(() => assertReservationistDraftSource(sealed, changed)).toThrow();
    expect(read).not.toHaveBeenCalled();
    state.files[0]!.contentId = 'different';
    expect(await result.revalidateSources()).toBe(false);
  });

  it('loads causal context and a file without a stored hash, then detects changed source bytes', async () => {
    const { state, args, s3, message } = setup(), body = Buffer.from('Please allocate two rooms.');
    const key = 'attachments/current/rooming.txt';
    state.files.push({ id: 'file', messageId: 'current', mimeType: 'text/plain', sizeBytes: body.length, sha256: null, s3Key: key, isInline: false, contentId: null });
    await s3.putObject({ key, body, contentType: 'text/plain' });
    state.rows.push(message('later', 0, 'inbound', 'guest@example.invalid'));
    const result = await loadReservationistMailboxInput(args);
    expect(result.input.messages.map((row) => [row.id, row.disclosure])).toEqual([
      ['earlier', 'guest'], ['staff', 'guest'], ['other', 'staff_only'], ['current', 'guest'],
    ]);
    expect(result.input.requestId).toBe('current');
    expect(result.requestedByUserId).toBe('staff');
    expect(result.admissions[0]).toMatchObject({ status: 'admitted', source: { pages: ['Please allocate two rooms.'],
      sourceHash: createHash('sha256').update(body).digest('hex') } });
    const source = await result.createDraftSource({ tasks: [], facts: [] }, {
      version: 1, readiness: 'ready_for_staff_review', tasks: [], quoteRevisionIds: [], artifactRefs: [], actionDigest: 'a'.repeat(64),
    });
    expect(source).toMatchObject({ runId: 'run', generationId: 'generation', requestedByUserId: 'staff',
      triggerMessageId: 'current', attachments: [{ attachmentId: 'file', sourceHash: createHash('sha256').update(body).digest('hex') }] });
    expect(source.messages.map((row) => row.id)).toEqual(['current', 'earlier', 'other', 'staff']);
    expect(await result.revalidateSources()).toBe(true);
    await s3.putObject({ key, body: Buffer.from('Please allocate two tents.'), contentType: 'text/plain' });
    expect(await result.revalidateSources()).toBe(false);
  });

  it('keeps internal replies staff-only and normalizes display-name addresses', async () => {
    const { state, args } = setup();
    state.binding.triggerId = 'current';
    state.rows.find((row) => row.id === 'current')!.fromAddress = 'Guest <guest@example.invalid>';
    state.rows.find((row) => row.id === 'staff')!.toAddresses = ['internal@example.invalid'];
    const result = await loadReservationistMailboxInput(args);
    expect(result.input.messages.find((row) => row.id === 'current')?.disclosure).toBe('guest');
    expect(result.input.messages.find((row) => row.id === 'staff')?.disclosure).toBe('staff_only');
  });

  it('reconstructs the model source from both alternatives and detects a changed HTML body', async () => {
    const { state, args } = setup();
    const row = state.rows.find((item) => item.id === 'current')!;
    row.textBody = 'Please hold the room.';
    row.htmlBody = '<p>Please do not hold the room.</p>';
    row.receivedAt = new Date(row.arrivedAt.getTime() - 120_000);
    const result = await loadReservationistMailboxInput(args);
    const modelText = result.input.messages.find((item) => item.id === row.id)!.text;
    const sealed = draftSourceMessage(row);
    expect(sealed.at).toBe(row.arrivedAt.toISOString());
    expect(sealed.sourceHash).toBe(createHash('sha256').update(modelText).digest('hex'));
    expect(modelText).toContain('do not hold');
    row.htmlBody = '<p>Please hold the room.</p>';
    expect(draftSourceMessage(row).identityHash).not.toBe(sealed.identityHash);
  });

  it('keeps an unhashed workbook visible for manual handling and verifies its identity', async () => {
    const { state, args, s3 } = setup(), body = Buffer.from('workbook fixture');
    const key = 'attachments/current/rooming.xlsx';
    const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    state.files.push({ id: 'workbook', messageId: 'current', mimeType, sizeBytes: body.length, sha256: null, s3Key: key, isInline: false, contentId: null });
    await s3.putObject({ key, body, contentType: mimeType });
    const result = await loadReservationistMailboxInput(args);
    expect(result.admissions[0]).toMatchObject({ status: 'manual_required', reason: 'spreadsheet_parse_failed',
      metadata: { sourceHash: createHash('sha256').update(body).digest('hex') } });
    expect(result.admissions[0]?.bytes).toBeUndefined();
    expect(await result.revalidateSources()).toBe(true);
    await s3.putObject({ key, body: Buffer.from('changed fixture!'), contentType: mimeType });
    expect(await result.revalidateSources()).toBe(false);
  });

  it('reads an unhashed valid workbook through mailbox admission', async () => {
    const { state, args, s3 } = setup(), workbook = createWorkbook(), sheet = addWorksheet(workbook, 'Rooms');
    setCell(sheet, 1, 1, 'Room'); setCell(sheet, 1, 2, 'Guest');
    setCell(sheet, 2, 1, '1'); setCell(sheet, 2, 2, 'Alex Example');
    const body = await workbookToBytes(workbook), key = 'attachments/current/valid-rooming.xlsx';
    const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    state.files.push({ id: 'sheet', messageId: 'current', mimeType, sizeBytes: body.length, sha256: null, s3Key: key, isInline: false, contentId: null });
    await s3.putObject({ key, body, contentType: mimeType });
    const result = await loadReservationistMailboxInput(args);
    expect(result.admissions[0]).toMatchObject({ status: 'admitted', reason: 'text', metadata: { sourceHash: createHash('sha256').update(body).digest('hex') } });
    expect(result.admissions[0]?.source?.pages?.[0]).toContain('Alex Example');
    expect(await result.revalidateSources()).toBe(true);
  });

  it('refuses a missing grant before reading file bytes and invalidates a revoked grant', async () => {
    const denied = setup();
    denied.state.grant = false;
    const read = vi.spyOn(denied.s3, 'getObjectBounded');
    await expect(loadReservationistMailboxInput(denied.args)).rejects.toThrow('mailbox_input_authority_unavailable');
    expect(read).not.toHaveBeenCalled();
    const allowed = setup(), result = await loadReservationistMailboxInput(allowed.args);
    expect(await result.revalidateSources()).toBe(true);
    allowed.state.grant = false;
    expect(await result.revalidateSources()).toBe(false);
  });

  it('rejects an unhashed file when its grant is revoked during the read', async () => {
    const { state, args, s3 } = setup(), body = Buffer.from('workbook');
    const key = 'attachments/current/rooming.xlsx';
    const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    state.files.push({ id: 'workbook', messageId: 'current', mimeType, sizeBytes: body.length, sha256: null, s3Key: key, isInline: false, contentId: null });
    await s3.putObject({ key, body, contentType: mimeType });
    const get = s3.getObjectBounded.bind(s3);
    vi.spyOn(s3, 'getObjectBounded').mockImplementation(async (...args) => {
      const value = await get(...args);
      state.grant = false;
      return value;
    });
    await expect(loadReservationistMailboxInput(args)).rejects.toThrow('mailbox_input_changed');
  });

  it('invalidates changed context, added thread mail, and caller-mutated input', async () => {
    const changed = setup(), result = await loadReservationistMailboxInput(changed.args);
    changed.state.rows[0]!.textBody = 'changed after capture';
    expect(await result.revalidateSources()).toBe(false);
    const added = setup(), laterResult = await loadReservationistMailboxInput(added.args);
    added.state.rows.push(added.message('later', 0, 'inbound', 'guest@example.invalid'));
    expect(await laterResult.revalidateSources()).toBe(false);
    const mutated = setup(), inputResult = await loadReservationistMailboxInput(mutated.args);
    inputResult.input.messages[0]!.text = 'changed by caller';
    expect(await inputResult.revalidateSources()).toBe(false);
  });
});
