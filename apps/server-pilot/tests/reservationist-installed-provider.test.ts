import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createInstalledReservationistProvider } from '../src/ai/reservationist-installed-provider.js';
import { admitReservationistAttachment } from '../src/ai/reservationist-attachment-input.js';
import { runReservationistRuntime, type ReservationistRuntimeInput } from '../src/ai/reservationist-runtime.js';
import type { ModelInvokeInput } from '../src/ai/bedrock/adapter.js';

const state = vi.hoisted(() => ({ locked: false, quoteReads: 0 }));
vi.mock('../src/hms/property-read-lock.js', async (original) => ({
  ...await original<typeof import('../src/hms/property-read-lock.js')>(),
  createPostgresPropertyReadLock: () => ({ withLock: async (run: () => Promise<unknown>) => {
    state.locked = true;
    try { return await run(); } finally { state.locked = false; }
  } }),
}));
vi.mock('../src/ai/staff-quote-installation.js', async (original) => ({
  ...await original<typeof import('../src/ai/staff-quote-installation.js')>(),
  readInstalledStaffQuoteConfiguration: () => ({ tenantId: 'tenant', owner: { propertyCode: 'HRCEN' } }),
  getInstalledStaffQuoteServices: (options: { authorizeContext: (ctx: unknown) => Promise<boolean> }) => ({
    resolveQuoteTask: async (ctx: unknown) => {
      if (!state.locked || !await options.authorizeContext(ctx)) throw new Error('quote_not_authorized');
      state.quoteReads++;
      throw new Error('recorded_quote_request_unavailable');
    },
  }),
}));
afterEach(() => { vi.unstubAllEnvs(); state.locked = false; state.quoteReads = 0; });

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
