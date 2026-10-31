import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createInstalledReservationistProvider } from '../src/ai/reservationist-installed-provider.js';
import { admitReservationistAttachment } from '../src/ai/reservationist-attachment-input.js';
import { runReservationistRuntime, type ReservationistRuntimeInput } from '../src/ai/reservationist-runtime.js';
import type { ModelInvokeInput } from '../src/ai/bedrock/adapter.js';

const state = vi.hoisted(() => ({ locked: false, quoteReads: 0, originProperty: 'HRCEN', quoteConfigAvailable: true, cancellationCalls: [] as string[] }));
vi.mock('../src/hms/hms-read-target.js', async (original) => ({
  ...await original<typeof import('../src/hms/hms-read-target.js')>(),
  assertHmsReadOriginAllowed: async () => ({ propertyCode: state.originProperty }),
}));
vi.mock('../src/hms/property-read-lock.js', async (original) => ({
  ...await original<typeof import('../src/hms/property-read-lock.js')>(),
  createPostgresPropertyReadLock: () => ({ withLock: async (run: () => Promise<unknown>) => {
    state.locked = true;
    try { return await run(); } finally { state.locked = false; }
  } }),
}));
vi.mock('../src/ai/staff-quote-installation.js', async (original) => ({
  ...await original<typeof import('../src/ai/staff-quote-installation.js')>(),
  readInstalledStaffQuoteConfiguration: () => { if (!state.quoteConfigAvailable) throw new Error('quote_configuration_unavailable'); return { tenantId: 'tenant', owner: { propertyCode: 'HRCEN' } }; },
  getInstalledStaffQuoteServices: (options: { authorizeContext: (ctx: unknown) => Promise<boolean> }) => ({
    resolveQuoteTask: async (ctx: unknown) => {
      if (!state.locked || !await options.authorizeContext(ctx)) throw new Error('quote_not_authorized');
      state.quoteReads++;
      throw new Error('recorded_quote_request_unavailable');
    },
  }),
}));
afterEach(() => { vi.unstubAllEnvs(); state.locked = false; state.quoteReads = 0; state.originProperty = 'HRCEN'; state.quoteConfigAvailable = true; state.cancellationCalls.length = 0; });

function input(text: string, artifacts: unknown[] = []): ReservationistRuntimeInput {
  const at = new Date(Date.now() - 1000).toISOString();
  return { version: 1, requestId: 'message', propertyCode: 'HRCEN',
    authorizationScope: { ownerRef: 'transport', threadId: 'thread' }, trigger: { id: 'message', at },
    messages: [{ id: 'message', at, direction: 'inbound', text }], authorizedArtifacts: artifacts,
    requiredTaskKinds: [], requiredAskSpans: [],
    clock: { causalAt: at, sourceAt: new Date().toISOString(), sourceMode: 'current_read', deadlineAt: Date.now() + 60000 },
    capabilities: { pmsWrite: false, emailSend: false } };
}
const response = (tasks: unknown[] = []) => ({ modelId: 'gpt-6-luna', output: { facts: [], tasks, unresolvedAsks: [] },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, estimatedCostUsd: 0, rateTableVersion: 'test' } });
function context(value: ReservationistRuntimeInput, admissions: unknown[] = []) {
  return { db: {} as never, transportId: 'transport', threadId: 'thread', requestedByUserId: 'staff', generationId: 'generation',
    admissions: admissions as never, input: value, signal: new AbortController().signal, fence: {} as never, revalidateSources: async () => true };
}

it('cancels an in-flight model request when its caller aborts', async () => {
  const value = input('Please quote a room.'), controller = new AbortController();
  let started!: () => void;
  const invoked = new Promise<void>((resolve) => { started = resolve; });
  const invoke = vi.fn((request: ModelInvokeInput) => new Promise<never>((_, reject) => {
    started();
    request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
  }));
  const provider = await createInstalledReservationistProvider({ invoke })({ ...context(value), signal: controller.signal });
  const run = runReservationistRuntime(value, provider.dependencies);
  const stopped = expect(run).rejects.toThrow();
  await invoked;
  controller.abort();
  await stopped;
});

it('refuses unmasked message, subject or attachment text before invoking the model', async () => {
  const body = input('Card 4111 1111 1111 1111, CVV: 123');
  const subject = input('Please help.');
  subject.messages[0]!.subject = 'CVV: 123';
  const attachment = input('Please read the attachment.');
  const unsafeAdmission = { status: 'admitted', metadata: { mimeType: 'text/plain' }, source: { pages: ['CVV: 123'] } };
  for (const [value, admissions] of [[body, []], [subject, []], [attachment, [unsafeAdmission]]] as const) {
    const invoke = vi.fn(async (_request: ModelInvokeInput) => response());
    const provider = await createInstalledReservationistProvider({ invoke })(context(value, [...admissions]));
    await expect(runReservationistRuntime(value, provider.dependencies)).rejects.toThrow('reservationist_text_not_masked');
    expect(invoke).not.toHaveBeenCalled();
  }
});

it('masks PDF text through real admission before model input and leaves visuals for staff', async () => {
  const body = Buffer.from('%PDF-1.4 synthetic private bytes 4111111111111111');
  const hash = createHash('sha256').update(body).digest('hex');
  const value = input('Thank you.', [{ attachmentId: 'pdf', sourceHash: hash }]);
  const metadata = { attachmentId: 'pdf', messageId: 'message', threadId: 'thread', ownerRef: 'transport',
    messageAt: value.trigger.at, mimeType: 'application/pdf', sizeBytes: body.length, sourceHash: hash, disclosure: 'guest' as const };
  const locator = { messageId: 'message', s3Key: 'attachments/message/pdf', mimeType: 'application/pdf', sizeBytes: body.length };
  const admission = await admitReservationistAttachment({ metadata,
    scope: { ownerRef: 'transport', threadId: 'thread', requestAt: value.trigger.at },
    read: { attachmentId: 'pdf', authorizedAttachmentIds: new Set(['pdf']), signal: new AbortController().signal,
      expectedLocator: locator, resolveLocator: async () => locator, revalidate: async () => true,
      s3: { headObject: async () => ({ sizeBytes: body.length, contentType: 'application/pdf' }),
        getObjectBounded: async () => ({ body, contentType: 'application/pdf' }) } as never },
    runner: async (tool) => ({ stdout: Buffer.from(tool === 'pdfinfo' ? 'Pages: 1\nEncrypted: no' : 'Card 4111 1111 1111 1111 CVV: 123\f'),
      stderr: Buffer.alloc(0), exitCode: 0 }),
  });
  expect(admission.status).toBe('admitted');
  const invoke = vi.fn(async (_request: ModelInvokeInput) => response());
  const provider = await createInstalledReservationistProvider({ invoke })(context(value, [admission]));
  const result = await runReservationistRuntime(value, provider.dependencies);
  expect(invoke).toHaveBeenCalledOnce();
  const request = invoke.mock.calls[0]![0] as { userPrompt: string; files?: unknown[]; images?: unknown[] };
  expect(request.userPrompt).toContain('[card ••••1111]');
  expect(request.userPrompt).not.toContain('4111 1111 1111 1111');
  expect(request.userPrompt).not.toContain('CVV: 123');
  expect(request.userPrompt).not.toContain('4111111111111111');
  expect(request.files).toEqual([]);
  expect(request.images).toEqual([]);
  expect(result.readiness).toBe('needs_clarification');
  expect(result.sourceRecoveries).toContainEqual(expect.objectContaining({ sourceRef: 'pdf', reason: 'visual_content_requires_staff_review' }));
});

it('runs the installed quote service only while the property lock and source grant are valid', async () => {
  vi.stubEnv('DATABASE_URL', 'synthetic-only');
  const text = 'Please quote a room.', value = input(text), hash = createHash('sha256').update(text).digest('hex');
  const model = { invoke: vi.fn(async (_request: ModelInvokeInput) => response([{ id: 'quote', kind: 'quote', factIds: [],
    source: { attachmentId: 'message:message', sourceHash: hash, page: 1, quote: text, start: 0, end: text.length } }])) };
  const provider = await createInstalledReservationistProvider(model)(context(value));
  const result = await runReservationistRuntime(value, provider.dependencies);
  expect(state.quoteReads).toBe(1);
  expect(state.locked).toBe(false);
  expect(result.tasks[0]?.status).toBe('needs_clarification');
});

it('prepares cancellation from a locked exact-stay read without quote config, opening or committing cancellation', async () => {
  vi.stubEnv('DATABASE_URL', 'synthetic-only');
  vi.stubEnv('PANE_STAY_TENANT_ID', 'tenant');
  state.quoteConfigAvailable = false;
  const text = 'Please cancel reservation ABC123.';
  const value = input(text), hash = createHash('sha256').update(text).digest('hex');
  const start = text.indexOf('ABC123');
  const referenceSource = { attachmentId: 'message:message', sourceHash: hash, page: 1,
    quote: 'ABC123', start, end: start + 'ABC123'.length };
  const taskSource = { attachmentId: 'message:message', sourceHash: hash, page: 1,
    quote: text, start: 0, end: text.length };
  const model = { invoke: vi.fn(async (_request: ModelInvokeInput) => ({
    ...response(),
    output: { facts: [{ id: 'ref', kind: 'reservation_reference', value: 'ABC123', source: referenceSource, disclosure: 'guest' }],
      tasks: [{ id: 'cancel', kind: 'cancel_request', factIds: ['ref'], source: taskSource }], unresolvedAsks: [] },
  })) };
  const observedAt = new Date().toISOString();
  const provider = await createInstalledReservationistProvider(model, async (operation) => {
    expect(state.locked).toBe(true);
    return operation({ runTool: async (request) => {
      expect(state.locked).toBe(true);
      state.cancellationCalls.push(request.tool);
      if (request.tool === 'read') {
        expect(request.confirmation).toBe('ABC123');
        return { outcome: 'ok' };
      }
      return {
        outcome: 'prepared_for_human_review', observedAt,
        target: { confirmation: 'ABC123', verified: true },
        stay: {
          arrivalDate: { state: 'observed', value: 'Mon 12-Oct-2026' },
          departureDate: { state: 'observed', value: 'Wed 14-Oct-2026' },
        },
        roomScope: { requested: 'unspecified', state: 'unresolved', complete: false },
        policy: { state: 'unknown' }, fee: { state: 'unknown_precommit', amount: null, currency: null },
        action: { actor: 'human', cancellationStarted: false, commitAvailable: false },
      };
    } });
  })(context(value));
  const result = await runReservationistRuntime(value, provider.dependencies);

  expect(result.readiness).toBe('pending_pms_action');
  expect(result.packets[0]).toMatchObject({
    kind: 'cancel_request', saved: false, businessRulesValidated: false,
    current: { arrivalDate: '2026-10-12', departureDate: '2026-10-14' },
    cancellationReview: { fee: { state: 'unknown_precommit', amount: null, currency: null },
      action: { cancellationStarted: false, commitAvailable: false } },
  });
  expect(state.cancellationCalls).toEqual(['read', 'prepareCancellation']);
  expect(state.locked).toBe(false);
});

it('does not start live quote reads for a different mailbox property', async () => {
  vi.stubEnv('DATABASE_URL', 'synthetic-only');
  state.originProperty = 'HRDAV';
  const text = 'Please quote a room.', value = input(text), hash = createHash('sha256').update(text).digest('hex');
  const model = { invoke: vi.fn(async (_request: ModelInvokeInput) => response([{ id: 'quote', kind: 'quote', factIds: [],
    source: { attachmentId: 'message:message', sourceHash: hash, page: 1, quote: text, start: 0, end: text.length } }])) };
  const provider = await createInstalledReservationistProvider(model)(context(value));
  await expect(runReservationistRuntime(value, provider.dependencies)).rejects.toThrow('reservationist_property_origin_invalid');
  expect(state.quoteReads).toBe(0);
});
