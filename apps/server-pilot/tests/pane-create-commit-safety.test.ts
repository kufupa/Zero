import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { paneCloudPreviewLoaders } from '../src/ai/pane-cloud-preview.js';
import { paneStaySaveLoaders } from '../src/ai/pane-stay-save.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { digestCloudCreateRequest } from '../tooling/hms-cloud/create-request-binding.mjs';

// No pilot DB or live HMS. Model only the transaction's observable result;
// this does not prove PostgreSQL row/advisory-lock behaviour.
const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  mail: {} as Record<string, unknown>,
  payload: {} as Record<string, unknown>,
  cursor: {} as Record<string, unknown>,
  sourceDigest: 'f'.repeat(64),
  actorAccessId: 'access-1',
  events: [] as unknown[],
  onCreateMutex: null as null | (() => void),
  createMutexCalls: 0,
  failBookedWrite: false,
  sessionActive: true,
  threadActive: true,
  sharedHold: null as null | Record<string, unknown>,
  sharedHoldResolved: false,
  loseAckAfterClaim: false,
  writerCurrent: true,
  tx: {} as any,
  db: {} as any,
}));
vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', async (original) => ({
  ...await original<typeof import('../tooling/playwright-quote/centurion-stay360.mjs')>(),
  centurionWriterCurrent: () => h.writerCurrent,
}));
vi.mock('../src/db/client.js', async (original) => ({
  ...await original<typeof import('../src/db/client.js')>(), getDb: () => h.db,
}));
vi.mock('../src/ai/pane-create-actor-lock.js', () => ({
  lockCreateActorAccess: async (_tx: unknown, input: { accessId?: string }) => {
    if (input.accessId && input.accessId !== h.actorAccessId) throw new Error('access changed');
    return { accessId: h.actorAccessId, mailboxAddress: 'hotel@example.invalid' };
  },
  lockCreateActorSession: async (_tx: unknown, input: { sessionId?: string; sessionProfile?: string }) => {
    if (!h.sessionActive || input.sessionId !== 'session-1' || input.sessionProfile !== 'legacy') {
      throw new Error('create_actor_session_unavailable');
    }
  },
}));
vi.mock('../src/ai/hms-labtest-dispatch.js', () => {
  class HmsLabtestDispatchError extends Error {
    constructor(readonly reason: string) { super(`hms_labtest_dispatch_${reason}`); }
  }
  return { HmsLabtestDispatchError,
    claimHmsLabtestDispatch: async (_db: unknown, input: Record<string, unknown>, authorize: (tx: unknown, input: Record<string, unknown>) => Promise<void>) => {
      h.createMutexCalls += 1; h.onCreateMutex?.();
      if (h.sharedHold && !h.sharedHoldResolved) throw new HmsLabtestDispatchError('occupied');
      await authorize(h.tx, input);
      h.sharedHold = structuredClone(input);
      h.sharedHoldResolved = false;
      if (h.loseAckAfterClaim) throw new Error('synthetic_commit_ack_lost');
      return { holdId: 'hold-1', ownerToken: 'a'.repeat(64) };
    },
    resolveHmsLabtestDispatch: async (_db: unknown, _handle: unknown, evidence: Record<string, unknown>,
      record: (tx: unknown, intent: Record<string, unknown>) => Promise<void>) => {
      if (!h.sharedHold || h.sharedHoldResolved) throw new HmsLabtestDispatchError('owner');
      await record(h.tx, h.sharedHold);
      h.events.push({ value: { kind: 'resolved', ...structuredClone(evidence) } });
      h.sharedHoldResolved = true;
    },
  };
});
vi.mock('../src/ai/pane-create-dispatch-fence.js', async (original) => ({
  ...await original<typeof import('../src/ai/pane-create-dispatch-fence.js')>(),
  assertNoCreateDispatchFence: async () => undefined,
}));
vi.mock('../src/ai/pane-create-source-loader.js', () => ({
  withLockedCreateSource: async (_db: unknown, key: any, fn: any) => {
    if (!h.threadActive || key.messageId !== h.mail.id || key.threadId !== h.mail.threadId ||
        JSON.stringify(key.cursor) !== JSON.stringify(h.cursor)) throw new Error('source changed');
    return fn(h.tx, { sourceDigest: h.sourceDigest, item: { state: h.state }, snapshot: {
      source: h.mail, extraction: { payload: h.payload }, historicalCorrections: [],
    } });
  },
  lockCreateSource: async (tx: unknown, key: any, fn: any) => {
    if (!h.threadActive || key.messageId !== h.mail.id || key.threadId !== h.mail.threadId ||
        JSON.stringify(key.cursor) !== JSON.stringify(h.cursor)) throw new Error('source changed');
    return fn(tx, { sourceDigest: h.sourceDigest, item: { state: h.state }, snapshot: {
      source: h.mail, extraction: { payload: h.payload }, historicalCorrections: [],
    } });
  },
}));

const workItemId = '11111111-1111-4111-8111-111111111111';
const stay = {
  firstName: 'Proof', lastName: 'Labtest', arrival: '2027-03-01', departure: '2027-03-03',
  adults: 1, childAges: [], sourceOfBusiness: 'E-Mail', roomType: 'STQN', ratePlan: 'BAR', track: 'BAR',
  guestoptin4: false, guaranteeType: 'NGI', reservationNote: 'Staff reviewed booking',
  cmsMessageId: '03', confirmationSendMail: false, propertyCode: 'HRCEN', workItemId, stayId: 's1_1',
};
const nativeRequest = {
  propertyCode: 'HRCEN', guest: { nativeId: '123', firstName: 'Proof', lastName: 'Labtest' },
  stay: { arrival: stay.arrival, departure: stay.departure, adults: 1, childAges: [] },
  room: { roomType: 'STQN', ratePlan: 'BAR' }, guaranteeType: 'NGI',
  sourceOfBusiness: { nativeCode: 'EMA', description: 'E-Mail' }, note: stay.reservationNote,
  cmsMessageId: '03', track: { lookupCode: 'BAR', display: 'Best Available' },
  guestOptIn: false, sendHmsConfirmation: { kind: 'never' },
};

function query(columns: Record<string, unknown>) {
  const rows = () => {
    if ('extractionId' in columns) return [h.cursor];
    if ('direction' in columns) return [h.mail];
    if ('state' in columns) return [{ state: h.state }];
    throw new Error('unexpected query');
  };
  const chain = Object.assign(Promise.resolve().then(rows), {
    from: () => chain, where: () => chain, orderBy: () => chain,
    limit: () => chain,
    for: async () => rows(),
  });
  return chain;
}
function caller(sessionId: string | null = 'session-1') {
  return appRouter.createCaller({ auth: null as never, reqHeaders: new Headers(),
    sessionUser: { id: 'staff-1', email: 'staff@example.invalid', name: 'Staff',
      ...(sessionId ? { sessionId, sessionProfile: 'legacy' } : {}) },
    activeTransportId: 'transport-centurion', transportEmail: 'hotel@example.invalid', accessRole: 'owner',
  } as never);
}
function request(nativeGuestId?: string) {
  return { ...stay, createSelection: { source: { messageId: 'message-1', threadId: 'thread-1',
    sourceHash: staffQuoteSourceHash(h.mail as never) }, identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 },
    ...(nativeGuestId ? { nativeGuestId } : {}) } };
}
function lock() {
  let tail = Promise.resolve();
  return { withLock: async <T>(fn: () => Promise<T>) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  } };
}

let dir: string;
let shotRoot: string;
let oldRun: typeof paneCloudPreviewLoaders.run;
let oldRuntime: typeof paneCloudPreviewLoaders.runtimeReady;
let oldAuthority: typeof paneCloudPreviewLoaders.authorityReady;
let calls: Array<{ input: Record<string, unknown>; options: any }>;
let dispatches: number;
let outcome: 'saved' | 'uncertain';
let proof: Record<string, unknown>;

beforeEach(async () => {
  vi.stubEnv('HITL_LEDGER', 'off');
  h.state = {};
  h.mail = { id: 'message-1', threadId: 'thread-1', direction: 'inbound', historyOnly: false,
    fromAddress: 'guest@example.invalid', toAddresses: ['hotel@example.invalid'], ccAddresses: [],
    ownerHeaderValue: null, subject: 'Please book', textBody: 'One room', htmlBody: null };
  h.payload = { contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
    confirmationNumbers: [], missing: [], stays: [{ id: 's1', hotel: null,
      requested: { arrival: stay.arrival, departure: stay.departure }, booked: null, totalRooms: 1,
      totalAdults: 1, totalChildren: 0, rows: [{ id: 'r1', roomType: 'Standard Queen', rooms: 1,
        adultsPerRoom: 1, childAges: [], board: null }] }] };
  h.cursor = { extractionId: '22222222-2222-4222-8222-222222222222', revision: 1, revisionHead: 1, seq: 1 };
  h.sourceDigest = 'f'.repeat(64); h.actorAccessId = 'access-1'; h.events = []; h.failBookedWrite = false;
  h.onCreateMutex = null; h.createMutexCalls = 0; h.sessionActive = true; h.threadActive = true;
  h.sharedHold = null; h.sharedHoldResolved = false; h.loseAckAfterClaim = false;
  h.writerCurrent = true;
  h.tx = { select: query, execute: async () => { h.createMutexCalls += 1; h.onCreateMutex?.(); },
    update: () => ({ set: ({ state }: { state: Record<string, unknown> }) => ({ where: async () => {
    if (h.failBookedWrite && (state.stays as any)?.s1_1?.status === 'booked') throw new Error('storage failed');
    h.state = structuredClone(state);
  } }) }), insert: () => ({ values: async (value: unknown) => { h.events.push(value); } }) };
  h.db = { select: query, transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(h.tx) };
  paneStaySaveLoaders.mode = () => 'lab'; paneStaySaveLoaders.lock = lock();
  shotRoot = await mkdtemp('/tmp/pane-cloud-create-shots-');
  vi.stubEnv('HMS_SHOTS_DIR', shotRoot);
  dir = join('/tmp', `hms-cloud-create-${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZcAAAAASUVORK5CYII=', 'base64');
  await Promise.all(['filled.png', 'before.png', 'after.png'].map((name) => writeFile(join(dir, name), png)));
  oldRun = paneCloudPreviewLoaders.run; oldRuntime = paneCloudPreviewLoaders.runtimeReady;
  oldAuthority = paneCloudPreviewLoaders.authorityReady;
  paneCloudPreviewLoaders.runtimeReady = () => true;
  paneCloudPreviewLoaders.authorityReady = () => true;
  calls = []; dispatches = 0; outcome = 'saved'; proof = structuredClone(nativeRequest);
  paneCloudPreviewLoaders.run = async (input, options) => {
    calls.push({ input, options });
    if (input.mode === 'prepare' && !((input.guest as any).profileId)) {
      return { outcome: 'needs_input', issue: 'guest_choice_required', guestCandidates: [
        { nativeId: '123', firstName: 'Proof', lastName: 'Labtest', city: 'Pretoria', email: 'private@example.invalid' },
      ] };
    }
    if (input.mode === 'prepare') {
      const binding = digestCloudCreateRequest(proof);
      if (binding.outcome !== 'ok') throw new Error('bad fixture');
      return { outcome: 'prepared', applied: { guaranteeType: 'Non-Guaranteed Individual' },
        requestBinding: { request: proof, digest: binding.normalizedRequestDigest }, screenshots: { filled: join(dir, 'filled.png') } };
    }
    const candidate = { method: () => 'POST', url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE',
      headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }), postDataBuffer: () => Buffer.from('synthetic=approved') };
    if (!await options.authorizeCandidate?.(candidate)) throw new Error('no authority');
    await options.dispatchCandidate?.(candidate, async () => { dispatches += 1; return true; }, {
      beforeScreenshot: join(dir, 'before.png'),
      writer: { host: 'a'.repeat(64), bootId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pidNamespace: 'pid:[123]',
        node: { pid: 20, started: '10' }, browser: { pid: 21, started: '11' } },
      guaranteeDisplay: 'Non-Guaranteed Individual',
      preimage: { outcome: 'clear', arrival: stay.arrival, departure: stay.departure,
        searchedDateRange: { from: '2027-02-01', to: '2027-04-01' },
        coverage: { displayed: 0, total: 0, complete: true }, sameArrival: [], preimageId: 'transient-proof',
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
    });
    return outcome === 'saved'
      ? { outcome: 'saved', confirmation: '123456-1', writerSessionClosed: true,
          save: { dispatchCallbacksDrained: true }, readback: { fields: [{ name: 'status', value: 'Reserved' }], mismatches: [] },
          screenshots: { before: join(dir, 'before.png'), after: join(dir, 'after.png') } }
      : { outcome: 'uncertain' };
  };
});
afterEach(async () => {
  paneCloudPreviewLoaders.run = oldRun; paneCloudPreviewLoaders.runtimeReady = oldRuntime;
  paneCloudPreviewLoaders.authorityReady = oldAuthority;
  paneStaySaveLoaders.mode = null; paneStaySaveLoaders.lock = null;
  vi.unstubAllEnvs();
  await Promise.all([dir, shotRoot].map((path) => rm(path, { recursive: true, force: true })));
});

async function prepared() {
  const response = await caller().quoteWorkflow.previewStay(request('123'));
  expect(response).toMatchObject({ status: 'ok', outcome: 'previewed' });
  const digest = (response as { previewDigest?: string }).previewDigest;
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  return digest!;
}

describe('mounted Cloud create route', () => {
  it('does not dispatch when the owned browser or writer identity cannot be verified', async () => {
    const digest = await prepared();
    h.writerCurrent = false;
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused' });
    expect(h.sharedHold).toBeNull();
    expect(dispatches).toBe(0);
  });
  it('allows a saved rowless-group correction through preview and one Go', async () => {
    (h.payload.stays as any[])[0].rows = [];
    h.state['stays[s1].rows[s1_row].count'] = 1;
    const selected = request('123'); selected.createSelection.identity.rowId = 's1';
    const preview = await caller().quoteWorkflow.previewStay(selected);
    expect(preview).toMatchObject({ status: 'ok', outcome: 'previewed' });
    const digest = (preview as { previewDigest: string }).previewDigest;
    const result = await caller().quoteWorkflow.commitStay({ ...selected, previewDigest: digest });
    expect(result).toMatchObject({ status: 'ok', outcome: 'committed', confirmationNumber: '123456-1' });
    expect(dispatches).toBe(1);
  });

  it('refuses Go when the rowless group is removed during the final claim', async () => {
    (h.payload.stays as any[])[0].rows = [];
    h.state['stays[s1].rows[s1_row].count'] = 1;
    const selected = request('123'); selected.createSelection.identity.rowId = 's1';
    const preview = await caller().quoteWorkflow.previewStay(selected);
    expect(preview).toMatchObject({ status: 'ok', outcome: 'previewed' });
    h.onCreateMutex = () => { h.state['stays[s1].rows[s1_row].removed'] = true; };
    expect(await caller().quoteWorkflow.commitStay({ ...selected, previewDigest: (preview as { previewDigest: string }).previewDigest }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(h.sharedHold).toBeNull();
    expect(dispatches).toBe(0);
  });

  it('refuses a wrong or removed room before opening HMS', async () => {
    const wrong = request('123'); wrong.createSelection.identity.rowId = 'other';
    expect(await caller().quoteWorkflow.previewStay(wrong))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    h.state['stays[s1].rows[r1].removed'] = true;
    expect(await caller().quoteWorkflow.previewStay(request('123')))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(calls).toHaveLength(0);
  });

  it('refuses Go if the reviewed row is removed while the claim waits', async () => {
    const digest = await prepared();
    h.onCreateMutex = () => { h.state['stays[s1].rows[r1].removed'] = true; };
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(h.sharedHold).toBeNull();
    expect(dispatches).toBe(0);
  });

  it('refuses Go if the selected thread is trashed before the final claim', async () => {
    const digest = await prepared();
    h.onCreateMutex = () => { h.threadActive = false; };
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(dispatches).toBe(0);
    expect(h.sharedHold).toBeNull();
  });

  it('keeps Go unavailable until shared write and source authority are ready', async () => {
    paneCloudPreviewLoaders.authorityReady = () => false;
    const preview = await caller().quoteWorkflow.previewStay(request('123'));
    expect(preview).toMatchObject({ status: 'ok', outcome: 'preview_only' });
    expect(preview).not.toHaveProperty('previewDigest');
    expect(h.state).not.toHaveProperty('cloudCreatePreviews');
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: 'a'.repeat(64) }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_authority_unavailable' });
    expect(h.state).not.toHaveProperty('stays');
    expect(dispatches).toBe(0);
  });

  it('does not consume a preview if authority becomes unavailable before Go', async () => {
    const digest = await prepared();
    paneCloudPreviewLoaders.authorityReady = () => false;
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_authority_unavailable' });
    expect(h.state).toHaveProperty('cloudCreatePreviews');
    expect(h.state).not.toHaveProperty('stays');
    expect(dispatches).toBe(0);
  });

  it('does not issue Go without an authenticated session binding', async () => {
    const preview = await caller(null).quoteWorkflow.previewStay(request('123'));
    expect(preview).toMatchObject({ status: 'ok', outcome: 'preview_only' });
    expect(preview).not.toHaveProperty('previewDigest');
    expect(h.state).not.toHaveProperty('cloudCreatePreviews');
  });

  it('refuses before dispatch when the approved session is revoked', async () => {
    const digest = await prepared();
    const run = paneCloudPreviewLoaders.run;
    paneCloudPreviewLoaders.run = (input, options) => run(input, {
      ...options, dispatchCandidate: options.dispatchCandidate && (async (candidate, next, evidence) => {
        h.sessionActive = false;
        return options.dispatchCandidate!(candidate, next, evidence);
      }),
    });
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(h.state).toHaveProperty('cloudCreatePreviews');
    expect(h.state).not.toHaveProperty('stays');
    expect(h.sharedHold).toBeNull();
    expect(dispatches).toBe(0);
  });

  it('keeps UNKNOWN and never dispatches if the claim commit acknowledgement is lost', async () => {
    const digest = await prepared();
    h.loseAckAfterClaim = true;
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'pane_save_unconfirmed' });
    expect(h.state).toMatchObject({ stays: { s1_1: { status: 'unknown' } } });
    expect(h.sharedHold).toMatchObject({ operation: 'create' });
    expect(dispatches).toBe(0);
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ reason: 'cloud_create_recovery_required' });
    expect(dispatches).toBe(0);
  });

  it('does not consume Go when authority is lost before the native fence', async () => {
    const digest = await prepared();
    const run = paneCloudPreviewLoaders.run;
    paneCloudPreviewLoaders.run = (input, options) => run(input, {
      ...options,
      dispatchCandidate: options.dispatchCandidate && (async (candidate, next, evidence) => {
        paneCloudPreviewLoaders.authorityReady = () => false;
        return options.dispatchCandidate!(candidate, next, evidence);
      }),
    });
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(h.state).toHaveProperty('cloudCreatePreviews');
    expect(h.state).not.toHaveProperty('stays');
    expect(h.sharedHold).toBeNull();
    expect(dispatches).toBe(0);
  });

  it('allows a fenced preview with the write flag off but issues no Go grant', async () => {
    paneStaySaveLoaders.mode = () => 'off';
    const preview = await caller().quoteWorkflow.previewStay(request('123'));
    expect(preview).toMatchObject({ status: 'ok', outcome: 'preview_only', screenshots: ['filled.png'] });
    expect(preview).not.toHaveProperty('previewDigest');
    expect(h.state).not.toHaveProperty('cloudCreatePreviews');
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: 'a'.repeat(64) }))
      .toMatchObject({ status: 'refused', reason: 'pane_save_flag_off' });
    expect(dispatches).toBe(0);
  });

  it('does not issue a Go grant if the write flag turns off while preview is running', async () => {
    const run = paneCloudPreviewLoaders.run;
    paneCloudPreviewLoaders.run = async (input, options) => {
      const result = await run(input, options);
      paneStaySaveLoaders.mode = () => 'off';
      return result;
    };
    expect(await caller().quoteWorkflow.previewStay(request('123'))).toMatchObject({ status: 'ok', outcome: 'preview_only' });
    expect(h.state).not.toHaveProperty('cloudCreatePreviews');
    expect(dispatches).toBe(0);
  });

  it('requires selected email binding and explicit profile choice', async () => {
    expect(await caller().quoteWorkflow.previewStay(stay)).toMatchObject({ status: 'refused', reason: 'pane_preview_binding_required' });
    expect(calls).toHaveLength(0);
    const response = await caller().quoteWorkflow.previewStay(request());
    expect(response).toMatchObject({ status: 'refused', reason: 'guest_choice_required',
      guestCandidates: [{ nativeId: '123', city: 'Pretoria' }] });
    expect((response as { guestCandidates?: unknown[] }).guestCandidates?.[0]).not.toHaveProperty('email');
    expect(h.state).not.toHaveProperty('cloudCreatePreviews');
  });

  it('connects selected source, reviewed preview, one Go, readback result and durable receipt', async () => {
    const digest = await prepared();
    const result = await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest });
    expect(result).toMatchObject({ status: 'ok', outcome: 'committed', confirmationNumber: '123456-1' });
    expect(dispatches).toBe(1);
    const binding = digestCloudCreateRequest(nativeRequest);
    if (binding.outcome !== 'ok') throw new Error('bad fixture');
    expect(calls[1]?.options.expectedRequestDigest).toBe(binding.normalizedRequestDigest);
    expect(calls[1]?.input).toMatchObject({ mode: 'commit', guest: { profileId: '123' }, cms: { send: false } });
    expect(h.state).toMatchObject({ stays: { s1_1: { status: 'booked', confirmationNumber: '123456-1' } } });
    expect(h.sharedHold).toMatchObject({ operation: 'create',
      stayId: 's1_1', nativeGuestId: '123', approvedDigest: binding.normalizedRequestDigest });
    expect(h.sharedHold?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(h.sharedHold?.recovery).toMatchObject({ request: binding.request,
      previewShot: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      beforeShot: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      preimage: { arrival: stay.arrival, departure: stay.departure,
        coverage: { displayed: 0, total: 0, complete: true } } });
    expect(JSON.stringify(h.sharedHold)).not.toContain('transient-proof');
    expect(h.sharedHoldResolved).toBe(true);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ value: { kind: 'resolved', confirmation: '123456-1' } });
  });

  it('binds the selected agency, company, guarantee and no-send recipient through Go', async () => {
    const selected = { ...request('123'), guaranteeType: 'GTDAGT',
      bookingAgency: { nativeId: '456', name: 'Test Agency' },
      organization: { nativeId: '789', name: 'Test Company' },
      confirmationRecipient: { mode: 'custom' as const, address: 'recipient@example.invalid' } };
    proof = { ...nativeRequest, guaranteeType: 'GTDAGT', cmsRecipient: 'recipient@example.invalid',
      parties: { agency: { nativeId: '456', name: 'Test Agency' }, organization: { nativeId: '789', name: 'Test Company' } } };
    const preview = await caller().quoteWorkflow.previewStay(selected);
    expect(preview).toMatchObject({ status: 'ok', outcome: 'previewed' });
    const digest = preview.previewDigest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await caller().quoteWorkflow.commitStay({ ...selected, previewDigest: digest! }))
      .toMatchObject({ status: 'ok', outcome: 'committed' });
    expect(calls[1]?.input).toMatchObject({ guaranteeType: 'GTDAGT',
      parties: { agencyId: '456', agencyName: 'Test Agency', organizationId: '789', organizationName: 'Test Company' },
      cms: { send: false, recipient: 'recipient@example.invalid' } });
    expect(dispatches).toBe(1);
  });

  it('permits a staff correction while binding the reviewed form through Go', async () => {
    const corrected = { ...request('123'), adults: 2, reservationNote: 'Staff corrected occupancy' };
    proof = { ...nativeRequest, stay: { ...nativeRequest.stay, adults: 2 }, note: corrected.reservationNote };
    const preview = await caller().quoteWorkflow.previewStay(corrected);
    expect(preview).toMatchObject({ status: 'ok', outcome: 'previewed' });
    const digest = preview.previewDigest!;
    expect(await caller().quoteWorkflow.commitStay({ ...corrected, adults: 3, previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'pane_save_preview_required' });
    expect(dispatches).toBe(0);
    expect(await caller().quoteWorkflow.commitStay({ ...corrected, previewDigest: digest }))
      .toMatchObject({ status: 'ok', outcome: 'committed' });
    expect(dispatches).toBe(1);
  });

  it('invalidates Go if sender identity changes even when the visible mail hash is unchanged', async () => {
    const digest = await prepared();
    h.mail.fromAddress = 'other@example.invalid';
    h.sourceDigest = 'e'.repeat(64);
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(dispatches).toBe(0);
    expect(h.sharedHold).toBeNull();
  });

  it('rejects a changed source, changed actor access, or altered native preview before dispatch', async () => {
    const digest = await prepared();
    h.mail.subject = 'Changed source';
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest })).toMatchObject({ status: 'refused' });
    expect(dispatches).toBe(0);
    h.mail.subject = 'Please book'; h.actorAccessId = 'access-2';
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest })).toMatchObject({ status: 'refused' });
    expect(dispatches).toBe(0);
    h.actorAccessId = 'access-1'; proof = { ...nativeRequest, guaranteeType: 'GTDAGT' };
    expect(await caller().quoteWorkflow.previewStay(request('123'))).toMatchObject({ status: 'refused', reason: 'cloud_create_proof_mismatch' });
  });

  it('refuses a changed approved request even if the stored digest is unchanged', async () => {
    const digest = await prepared();
    const grant = (h.state.cloudCreatePreviews as any).s1_1;
    grant.approvedRequest.guest.nativeId = '999';
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'pane_save_preview_required' });
    expect(h.sharedHold).toBeNull();
    expect(dispatches).toBe(0);
  });

  it('refuses before claiming Go if the pre-save census is incomplete', async () => {
    const digest = await prepared();
    const run = paneCloudPreviewLoaders.run;
    paneCloudPreviewLoaders.run = (input, options) => run(input, {
      ...options, dispatchCandidate: options.dispatchCandidate && (async (candidate, next, evidence) => {
        const current = evidence as { beforeScreenshot: string; preimage: Record<string, unknown> };
        return options.dispatchCandidate!(candidate, next, { ...current,
          preimage: { ...current.preimage, coverage: { displayed: 1, total: 2, complete: false } } });
      }),
    });
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_unavailable' });
    expect(h.sharedHold).toBeNull();
    expect(h.state).toHaveProperty('cloudCreatePreviews');
    expect(h.state).not.toHaveProperty('stays');
    expect(dispatches).toBe(0);
  });

  it('refuses Go if the pre-save census expires while the shared claim waits', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const digest = await prepared();
      h.onCreateMutex = () => { clock.mockReturnValue(now + 6 * 60_000); };
      expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
        .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
      expect(h.sharedHold).toBeNull();
      expect(dispatches).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it('retains an unknown marker after uncertain dispatch and refuses two concurrent retries', async () => {
    const digest = await prepared(); outcome = 'uncertain';
    const first = await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest });
    expect(first).toMatchObject({ status: 'refused', reason: 'pane_save_unconfirmed' });
    expect(h.state).toMatchObject({ stays: { s1_1: { status: 'unknown' } } });
    const retries = await Promise.all([1, 2].map(() => caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest })));
    expect(retries).toEqual([expect.objectContaining({ reason: 'cloud_create_recovery_required' }),
      expect.objectContaining({ reason: 'cloud_create_recovery_required' })]);
    expect(dispatches).toBe(1);
  });

  it('keeps an independently read-back booking blocked after the property hold is resolved', async () => {
    const digest = await prepared();
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'ok', outcome: 'committed' });
    expect(h.sharedHoldResolved).toBe(true);
    expect(await caller().quoteWorkflow.previewStay(request('123')))
      .toMatchObject({ status: 'refused', reason: 'pane_stay_already_booked' });
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'pane_stay_already_booked' });
    expect(dispatches).toBe(1);
  });

  it.each(['drain', 'close', 'readback'] as const)('keeps UNKNOWN when %s proof is missing', async (missing) => {
    const digest = await prepared();
    const run = paneCloudPreviewLoaders.run;
    paneCloudPreviewLoaders.run = async (input, options) => {
      const result = await run(input, options);
      if (input.mode !== 'commit') return result;
      if (missing === 'drain') return { ...result, save: { dispatchCallbacksDrained: false } };
      if (missing === 'close') return { ...result, writerSessionClosed: false };
      return { ...result, readback: { mismatches: [] } };
    };
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'pane_save_unconfirmed' });
    expect(h.state).toMatchObject({ stays: { s1_1: { status: 'unknown' } } });
    expect(h.sharedHoldResolved).toBe(false);
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ reason: 'cloud_create_recovery_required' });
    expect(dispatches).toBe(1);
  });

  it('does not consume Go if the write flag turns off before the native fence', async () => {
    const digest = await prepared();
    const run = paneCloudPreviewLoaders.run;
    paneCloudPreviewLoaders.run = (input, options) => run(input, {
      ...options,
      dispatchCandidate: options.dispatchCandidate && (async (candidate, next, evidence) => {
        paneStaySaveLoaders.mode = () => 'off';
        return options.dispatchCandidate!(candidate, next, evidence);
      }),
    });
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'cloud_create_scope_changed' });
    expect(dispatches).toBe(0);
    expect(h.state).toHaveProperty('cloudCreatePreviews');
    expect(h.state).not.toHaveProperty('stays');
    paneStaySaveLoaders.mode = () => 'lab';
    paneCloudPreviewLoaders.run = run;
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'ok', outcome: 'committed' });
    expect(dispatches).toBe(1);
  });

  it('serializes two simultaneous Go requests and does not overwrite uncertainty', async () => {
    const digest = await prepared(); outcome = 'uncertain';
    const results = await Promise.all([1, 2].map(() => caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest })));
    expect(results).toEqual([expect.objectContaining({ reason: 'pane_save_unconfirmed' }),
      expect.objectContaining({ reason: 'cloud_create_recovery_required' })]);
    expect(h.state).toMatchObject({ stays: { s1_1: { status: 'unknown' } } });
    expect(dispatches).toBe(1);
  });

  it('holds a create when another mailbox has an uncertain HRCEN create', async () => {
    const digest = await prepared();
    h.sharedHold = { operation: 'attach_document', workItemId: 'other-item' };
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest })).toMatchObject({ reason: 'cloud_create_recovery_required' });
    expect(dispatches).toBe(0);
  });

  it('checks cross-work-item uncertainty after acquiring the transaction mutex', async () => {
    const digest = await prepared();
    h.onCreateMutex = () => { h.sharedHold = { operation: 'amend', workItemId: 'other-item' }; };
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ reason: 'cloud_create_recovery_required' });
    expect(h.createMutexCalls).toBe(1);
    expect(h.state).toHaveProperty('cloudCreatePreviews');
    expect(h.state).not.toHaveProperty('stays');
    expect(dispatches).toBe(0);
  });

  it('does not report success or allow retry when receipt persistence fails', async () => {
    const digest = await prepared(); h.failBookedWrite = true;
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest })).toMatchObject({
      status: 'refused', reason: 'pane_save_unconfirmed',
    });
    expect(h.state).toMatchObject({ stays: { s1_1: { status: 'unknown' } } });
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest })).toMatchObject({ reason: 'cloud_create_recovery_required' });
    expect(dispatches).toBe(1);
  });

  it('refuses Go if the reviewed screenshot has changed', async () => {
    const digest = await prepared();
    const grant = (h.state.cloudCreatePreviews as any).s1_1;
    await writeFile(join(shotRoot, 'HRCEN', workItemId, grant.previewShot.runId, 'filled.png'), 'changed');
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'pane_save_preview_required' });
    expect(h.state).not.toHaveProperty('stays');
    expect(dispatches).toBe(0);
  });

  it('holds the outcome if screenshots cannot be stored after dispatch', async () => {
    const digest = await prepared();
    const run = paneCloudPreviewLoaders.run;
    paneCloudPreviewLoaders.run = async (input, options) => {
      const result = await run(input, options);
      if (input.mode === 'commit') vi.stubEnv('HMS_SHOTS_DIR', 'not-an-absolute-path');
      return result;
    };
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'pane_save_unconfirmed' });
    expect(h.state).toMatchObject({ stays: { s1_1: { status: 'unknown' } } });
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ reason: 'cloud_create_recovery_required' });
    expect(dispatches).toBe(1);
  });

  it('does not declare success when fresh readback reports a mismatch', async () => {
    const digest = await prepared();
    const run = paneCloudPreviewLoaders.run;
    paneCloudPreviewLoaders.run = async (input, options) => {
      const result = await run(input, options);
      return input.mode === 'commit' ? { ...result, readback: { mismatches: [{ field: 'guaranteeType' }] } } : result;
    };
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest }))
      .toMatchObject({ status: 'refused', reason: 'pane_save_unconfirmed' });
    expect(h.state).toMatchObject({ stays: { s1_1: { status: 'unknown' } } });
    expect(dispatches).toBe(1);
  });

  it('refuses before consuming a grant when the Cloud browser runtime is missing', async () => {
    const digest = await prepared(); paneCloudPreviewLoaders.runtimeReady = () => false;
    expect(await caller().quoteWorkflow.commitStay({ ...request('123'), previewDigest: digest })).toMatchObject({ reason: 'cloud_create_runtime_unavailable' });
    expect(h.state).toHaveProperty('cloudCreatePreviews');
    expect(h.state).not.toHaveProperty('stays');
    expect(dispatches).toBe(0);
  });
});
