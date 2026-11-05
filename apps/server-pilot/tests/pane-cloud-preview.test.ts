import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { paneCloudPreviewLoaders } from '../src/ai/pane-cloud-preview.js';
import { readStoredHmsShot } from '../src/ai/hms-shots-store.js';
import { paneStaySaveLoaders } from '../src/ai/pane-stay-save.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { digestCloudCreateRequest } from '../tooling/hms-cloud/create-request-binding.mjs';

// Synthetic rows only; this does not exercise PostgreSQL or HMS.
const h = vi.hoisted(() => ({ row: null as any, guard: true, accessId: 'access-1', db: null as any, tx: null as any }));
vi.mock('../src/db/client.js', async (original) => ({
  ...await original<typeof import('../src/db/client.js')>(), getDb: () => h.db,
}));
vi.mock('../src/ai/pane-create-actor-lock.js', () => ({
  lockCreateActorAccess: async (_tx: unknown, input: { accessId?: string }) => {
    if (!h.guard || (input.accessId && input.accessId !== h.accessId)) throw new Error('create_actor_unavailable');
    return { accessId: h.accessId, mailboxAddress: h.row.mailbox.email };
  },
}));
vi.mock('../src/ai/pane-create-dispatch-fence.js', async (original) => ({
  ...await original<typeof import('../src/ai/pane-create-dispatch-fence.js')>(),
  assertNoCreateDispatchFence: async () => undefined,
}));
vi.mock('../src/ai/pane-create-source-loader.js', () => ({
  withLockedCreateSource: async (_db: unknown, key: any, fn: any) => {
    if (!h.row || key.messageId !== h.row.mail.id || key.threadId !== h.row.mail.threadId ||
        key.cursor.extractionId !== h.row.extraction.id || key.cursor.seq !== h.row.item.revisionSeq) {
      throw new Error('create_source_stale');
    }
    return fn(h.tx, { sourceDigest: 'f'.repeat(64), item: h.row.item, snapshot: {
      source: h.row.mail, extraction: h.row.extraction, historicalCorrections: [],
    } });
  },
}));

const workItemId = '11111111-1111-4111-8111-111111111111';
const stay = {
  firstName: 'Proof', lastName: 'Labtest', arrival: '2027-03-01', departure: '2027-03-03',
  adults: 1, childAges: [], sourceOfBusiness: 'E-Mail', roomType: 'STQN', ratePlan: 'BAR', track: 'BAR',
  guestoptin4: false, guaranteeType: 'NGI', reservationNote: 'Staff reviewed booking',
  cmsMessageId: '03', confirmationSendMail: false, propertyCode: 'HRCEN', workItemId, stayId: 'room_r1_1',
};
const requestProof = {
  propertyCode: 'HRCEN', guest: { nativeId: '123', firstName: 'Proof', lastName: 'Labtest' },
  stay: { arrival: stay.arrival, departure: stay.departure, adults: 1, childAges: [] },
  room: { roomType: 'STQN', ratePlan: 'BAR' }, guaranteeType: 'NGI',
  sourceOfBusiness: { nativeCode: 'EMA', description: 'E-Mail' }, note: stay.reservationNote,
  cmsMessageId: '03', track: { lookupCode: 'BAR', display: 'Best Available' },
  guestOptIn: false, sendHmsConfirmation: { kind: 'never' },
};
function caller() {
  return appRouter.createCaller({ auth: null as never, reqHeaders: new Headers(),
    sessionUser: { id: 'staff-1', email: 'staff@example.invalid', name: 'Staff' },
    activeTransportId: 'transport-centurion', transportEmail: 'hotel@example.invalid', accessRole: 'owner',
  } as never);
}
function request(nativeGuestId?: string) {
  return { ...stay, createSelection: { source: { messageId: 'message-1', threadId: 'thread-1',
    sourceHash: staffQuoteSourceHash(h.row.mail) }, identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 },
    ...(nativeGuestId ? { nativeGuestId } : {}) } };
}

let sourceDir: string, shotRoot: string, proof: Record<string, unknown>, calls: unknown[];
let oldRun: typeof paneCloudPreviewLoaders.run, oldRuntime: typeof paneCloudPreviewLoaders.runtimeReady;
let oldMode: typeof paneStaySaveLoaders.mode;
beforeEach(async () => {
  vi.stubEnv('HITL_LEDGER', 'off');
  oldMode = paneStaySaveLoaders.mode; paneStaySaveLoaders.mode = () => 'off';
  sourceDir = join('/tmp', `hms-cloud-create-${randomUUID()}`);
  shotRoot = await mkdtemp('/tmp/pane-preview-shots-');
  vi.stubEnv('HMS_SHOTS_DIR', shotRoot);
  await mkdir(sourceDir, { mode: 0o700 });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZcAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(sourceDir, 'filled.png'), png);
  h.guard = true; h.accessId = 'access-1';
  h.row = { item: { threadId: 'thread-1', status: 'open', state: {}, revision: 1, revisionHead: 1, revisionSeq: 1 },
    mail: { id: 'message-1', threadId: 'thread-1', direction: 'inbound', historyOnly: false,
      fromAddress: 'guest@example.invalid', toAddresses: ['hotel@example.invalid'], ccAddresses: [],
      ownerHeaderValue: null, subject: 'Please book', textBody: 'One room', htmlBody: null },
    extraction: { id: '22222222-2222-4222-8222-222222222222', status: 'succeeded', payload: {
      contact: { name: null, email: null, phone: null }, agency: null, endClient: null, confirmationNumbers: [], missing: [],
      stays: [{ id: 's1', hotel: null, requested: { arrival: stay.arrival, departure: stay.departure }, booked: null,
        totalRooms: 1, totalAdults: 1, totalChildren: 0,
        rows: [{ id: 'r1', roomType: 'Standard Queen', rooms: 1, adultsPerRoom: 1, childAges: [], board: null }] }],
    } }, mailbox: { email: 'hotel@example.invalid' }, access: { id: 'access-1' } };
  const cursor: any = { from: () => cursor, where: () => cursor, limit: async () => h.row ? [{
    extractionId: h.row.extraction.id, revision: h.row.item.revision,
    revisionHead: h.row.item.revisionHead, seq: h.row.item.revisionSeq }] : [] };
  const thread: any = { from: () => thread, where: () => thread, orderBy: () => thread,
    limit: () => thread, for: async () => h.row ? [h.row.mail] : [] };
  h.db = { select: () => cursor }; h.tx = { select: () => thread };
  oldRun = paneCloudPreviewLoaders.run; oldRuntime = paneCloudPreviewLoaders.runtimeReady;
  paneCloudPreviewLoaders.runtimeReady = () => true;
  proof = structuredClone(requestProof); calls = [];
  paneCloudPreviewLoaders.run = async (input, options) => {
    calls.push({ input, options });
    if (!(input.guest as { profileId?: string }).profileId) return { outcome: 'needs_input', issue: 'guest_choice_required',
      guestCandidates: [{ nativeId: '123', firstName: 'Proof', lastName: 'Labtest', city: 'Pretoria', email: 'private@example.invalid' }] };
    const binding = digestCloudCreateRequest(proof);
    if (binding.outcome !== 'ok') throw new Error('bad proof');
    return { outcome: 'prepared', applied: { guaranteeType: 'Non-Guaranteed Individual' },
      ratePlanAvailability: { averageRate: '1000.00', totalRate: '2000.00', currency: 'ZAR' },
      requestBinding: { request: proof, digest: binding.normalizedRequestDigest }, screenshots: { filled: join(sourceDir, 'filled.png') } };
  };
});
afterEach(async () => {
  paneCloudPreviewLoaders.run = oldRun; paneCloudPreviewLoaders.runtimeReady = oldRuntime;
  paneStaySaveLoaders.mode = oldMode;
  vi.unstubAllEnvs();
  await Promise.all([rm(sourceDir, { recursive: true, force: true }), rm(shotRoot, { recursive: true, force: true })]);
});

describe('mounted read-only Cloud preview', () => {
  it('keeps Cloud dispatch disabled until its explicit cutover flag is on', () => {
    for (const value of ['', 'off', 'true', 'ON', '1']) {
      vi.stubEnv('PANE_CLOUD_CREATE_DISPATCH', value);
      expect(paneCloudPreviewLoaders.authorityReady()).toBe(false);
    }
    vi.stubEnv('PANE_CLOUD_CREATE_DISPATCH', 'on');
    expect(paneCloudPreviewLoaders.authorityReady()).toBe(true);
  });

  it('requires the exact source and explicit guest profile without exposing candidate email', async () => {
    const wrong = request(); wrong.createSelection.source.messageId = 'other-message';
    expect(await caller().quoteWorkflow.previewStay(wrong)).toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(calls).toHaveLength(0);
    h.row.item.state = { 'stays[s1].requested.arrival': '2027-03-02' };
    const stale = request();
    expect(await caller().quoteWorkflow.previewStay({ ...stale, createSelection: { ...stale.createSelection,
      expectedSeq: h.row.item.revisionSeq, expectedExtractionId: h.row.extraction.id } }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(calls).toHaveLength(0);
    h.row.item.state = {};
    const current = request();
    const result = await caller().quoteWorkflow.previewStay({ ...current, createSelection: { ...current.createSelection,
      expectedSeq: h.row.item.revisionSeq, expectedExtractionId: h.row.extraction.id } });
    expect(result).toMatchObject({ status: 'refused', reason: 'guest_choice_required',
      guestCandidates: [{ nativeId: '123', city: 'Pretoria' }] });
    expect((result as { guestCandidates?: unknown[] }).guestCandidates?.[0]).not.toHaveProperty('email');
    const rows = h.row.extraction.payload.stays[0].rows;
    const otherRowId = '12345678-1234-4234-8234-123456789abc';
    rows.push({ ...rows[0], id: otherRowId, roomType: 'Standard King', adultsPerRoom: 2 });
    expect(await caller().quoteWorkflow.previewStay({ ...request(), stayId: 's1_1' }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    const other = request();
    other.stayId = `room_${otherRowId}_1`; other.createSelection.identity.rowId = otherRowId;
    expect(await caller().quoteWorkflow.previewStay(other)).toMatchObject({ reason: 'guest_choice_required' });
  });

  it('shows a private source-bound preview with no approval, and refuses the mounted Save route', async () => {
    const result = await caller().quoteWorkflow.previewStay(request('123'));
    expect(result).toMatchObject({ status: 'ok', outcome: 'preview_only', screenshots: ['filled.png'] });
    expect(result).not.toHaveProperty('previewDigest');
    expect(await readStoredHmsShot({ runId: result.runId!, name: 'filled.png', owner: 'staff-1:transport-centurion' })).not.toBeNull();
    expect(await readStoredHmsShot({ runId: result.runId!, name: 'filled.png', owner: 'other:transport-centurion' })).toBeNull();
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: 'a'.repeat(64) })).toMatchObject({
      status: 'refused', reason: 'pane_save_flag_off',
    });
    expect(calls).toHaveLength(1);
    h.row.item.state = { stays: { s1_1: { status: 'booked', confirmationNumber: '12345-1' } } };
    expect(await caller().quoteWorkflow.previewStay(request('123'))).toMatchObject({ reason: 'pane_stay_already_booked' });
    h.row.item.state = { stays: { room_r1_1: { status: 'booked', confirmationNumber: '12345-1' } } };
    expect(await caller().quoteWorkflow.previewStay({ ...request('123'), stayId: 's1_1' }))
      .toMatchObject({ reason: 'pane_stay_already_booked' });
  });

  it('leaves HRDAV on its existing Save route and its own write-mode guard', async () => {
    const oldMode = paneStaySaveLoaders.mode;
    paneStaySaveLoaders.mode = () => 'off';
    try {
      const davinci = appRouter.createCaller({ auth: null as never, reqHeaders: new Headers(),
        sessionUser: { id: 'staff-1', email: 'staff@example.invalid', name: 'Staff' },
        activeTransportId: 'transport-davinci', transportEmail: 'other@example.invalid', accessRole: 'owner',
      } as never);
      expect(await davinci.quoteWorkflow.commitStay({ ...stay, workItemId: undefined, stayId: undefined,
        propertyCode: 'HRDAV', previewDigest: 'a'.repeat(64) })).toMatchObject({
        status: 'refused', reason: 'pane_save_flag_off',
      });
      expect(calls).toHaveLength(0);
    } finally { paneStaySaveLoaders.mode = oldMode; }
  });

  it('refuses a changed source, an altered native proof, real guests and email sending', async () => {
    const run = paneCloudPreviewLoaders.run;
    paneCloudPreviewLoaders.run = async (...args) => { const result = await run(...args); h.row.item.state = { changed: true }; return result; };
    expect(await caller().quoteWorkflow.previewStay(request('123'))).toMatchObject({ reason: 'cloud_create_scope_changed' });
    h.row.item.state = {}; paneCloudPreviewLoaders.run = run;
    proof = { ...requestProof, guaranteeType: 'GTDAGT' };
    expect(await caller().quoteWorkflow.previewStay(request('123'))).toMatchObject({ reason: 'cloud_create_proof_mismatch' });
    const count = calls.length;
    expect(await caller().quoteWorkflow.previewStay({ ...request('123'), firstName: 'Real' })).toMatchObject({ reason: 'cloud_preview_labtest_only' });
    expect(await caller().quoteWorkflow.previewStay({ ...request('123'), confirmationSendMail: true })).toMatchObject({ reason: 'labtest_send_forbidden' });
    expect(calls).toHaveLength(count);
  });

  it('fails closed when the runtime, mailbox access or pre-stay source is unavailable', async () => {
    paneCloudPreviewLoaders.runtimeReady = () => false;
    expect(await caller().quoteWorkflow.previewStay(request('123'))).toMatchObject({ reason: 'cloud_create_runtime_unavailable' });
    paneCloudPreviewLoaders.runtimeReady = () => true; h.guard = false;
    expect(await caller().quoteWorkflow.previewStay(request('123'))).toMatchObject({ reason: 'cloud_create_scope_changed' });
    h.guard = true;
    h.row.mail.fromAddress = 'hotel@example.invalid';
    h.row.mail.subject = 'Pre Stay: Confirmation No 123456';
    expect(await caller().quoteWorkflow.previewStay(request('123'))).toMatchObject({ reason: 'cloud_create_scope_changed' });
    h.row = null;
    // Use the previously captured source when access disappears.
    expect(await caller().quoteWorkflow.previewStay({ ...stay, createSelection: {
      source: { messageId: 'message-1', threadId: 'thread-1', sourceHash: 'a'.repeat(64) },
      identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 }, nativeGuestId: '123' } })).toMatchObject({ reason: 'cloud_create_scope_changed' });
    expect(calls).toHaveLength(0);
  });

  it('does not return guest choices if staff access changes while HMS is staging', async () => {
    const run = paneCloudPreviewLoaders.run;
    paneCloudPreviewLoaders.run = async (...args) => { const result = await run(...args); h.accessId = 'access-2'; return result; };
    const result = await caller().quoteWorkflow.previewStay(request());
    expect(result).toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(result).not.toHaveProperty('guestCandidates');
  });

  it('does not present a broken screenshot as a reviewed preview', async () => {
    await writeFile(join(sourceDir, 'filled.png'), 'not a PNG');
    expect(await caller().quoteWorkflow.previewStay(request('123')))
      .toMatchObject({ status: 'refused', reason: 'cloud_preview_unavailable' });
  });
});
