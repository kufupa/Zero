import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProductionDraftModelRouteFactory,
  resolveCurrentDraftRouteAuthority,
  type ReservationistProviderContext,
} from '../src/ai/draft-route-factory.js';
import type { ReservationistProviderOptions } from '../src/ai/reservationist-provider.js';
import { runReservationistRuntime } from '../src/ai/reservationist-runtime.js';

const directories: string[] = [];
const bridges: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const key of bridges.splice(0)) delete (globalThis as Record<string, unknown>)[key];
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function fixture() {
  const now = Date.now(), at = new Date(now).toISOString(), deadline = now + 60_000;
  const text = 'Is parking available?';
  const route = { routeId: 'disposable-installed-control', purpose: 'draft' as const, protocol: 'in_process' as const, access: 'current_app' as const, egress: 'none' as const, retention: 'bounded' as const, usage: 'reported' as const, modelId: 'gpt-6-luna' };
  const release = { releaseId: 'synthetic-installed-control', releaseVersion: '1', sourceRevision: 'synthetic-control', fingerprint: 'synthetic-control', purpose: 'draft' as const, capabilityFamilyVersions: { reservationist: 'reservationist-runtime-v1' }, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(deadline).toISOString(), withdrawn: false };
  const context: ReservationistProviderContext = {
    db: {} as ReservationistProviderContext['db'], transportId: 'synthetic-mailbox', threadId: 'synthetic-thread', requestedByUserId: 'synthetic-staff', generationId: 'synthetic-generation', admissions: [], signal: new AbortController().signal,
    fence: { runId: 'synthetic-run', claimOwner: 'synthetic-worker', claimToken: 'synthetic-token', deadlineAt: new Date(deadline) },
    input: { version: 1, requestId: 'synthetic-inbound', propertyCode: 'HRCEN', authorizationScope: { ownerRef: 'synthetic-mailbox', threadId: 'synthetic-thread' }, trigger: { id: 'synthetic-inbound', at }, messages: [{ id: 'synthetic-inbound', at, direction: 'inbound', text }], authorizedArtifacts: [], clock: { causalAt: at, sourceAt: at, sourceMode: 'current_read', deadlineAt: deadline }, capabilities: { pmsWrite: false, emailSend: false } },
  };
  const source = { attachmentId: 'message:synthetic-inbound', sourceHash: createHash('sha256').update(text).digest('hex'), page: 1, quote: text, start: 0, end: text.length };
  // This is a model-only wiring control, not a successful PMS response or business qualification.
  const transport = vi.fn(async () => ({ output: { facts: [], tasks: [{ id: 'parking', kind: 'question', factIds: [], source }], unresolvedAsks: [] }, usage: { inputTokens: 10, outputTokens: 20, latencyMs: 1 } }));
  const artifactStorage = { stage: vi.fn(), read: vi.fn() };
  const resolveTaskAnswer = vi.fn(async () => ({ kind: 'parking' as const, value: true, disclosure: 'guest' as const, evidenceRefs: ['synthetic:parking'], preparedFacts: [{ key: 'parking', label: 'Parking', value: true, source: 'property' as const, authority: 'authorized' as const, status: 'known' as const, evidenceRef: 'synthetic:parking', scopeVerified: true, disclosure: 'guest' as const }] }));
  const authorizeAnswerSource = vi.fn(async () => true);
  const resolveServices = vi.fn(async () => ({ services: { resolveTaskAnswer, authorizeAnswerSource }, header: { attention: '', company: '', clientEmail: '', clientTelephone: '', agency: '', signerName: '', signerEmail: '' }, converter: { url: 'http://disposable-converter.invalid', fetchImpl: vi.fn() as typeof fetch }, artifactStorage }));
  const authorizeContext = vi.fn(async (candidate: ReservationistProviderContext) => candidate.db === context.db && candidate.transportId === 'synthetic-mailbox' && candidate.threadId === 'synthetic-thread' && candidate.requestedByUserId === 'synthetic-staff' && candidate.generationId === 'synthetic-generation' && candidate.fence.claimToken === 'synthetic-token');
  const options: ReservationistProviderOptions = { routeConfig: { route, release, transport }, authorizeContext, resolveCurrentAuthority: resolveCurrentDraftRouteAuthority, resolveServices };
  return { options, context, route, release, transport, resolveServices, authorizeContext, artifactStorage };
}

async function install(f: ReturnType<typeof fixture>) {
  const module = await import('../src/ai/reservationist-installed-configuration.js');
  const directory = await mkdtemp(join(tmpdir(), 'reservationist-installed-control-'));
  directories.push(directory);
  const path = join(directory, 'installed-route.cjs'), key = `reservationistInstalledControl${randomUUID().replaceAll('-', '')}`;
  bridges.push(key);
  // Native require loads the actual zero-argument configuration seam. The bridge
  // lets this synthetic test supply Vitest's imported factory and scoped services.
  (globalThis as Record<string, unknown>)[key] = { create: module.createInstalledReservationistDraftModelRoute, options: f.options };
  await writeFile(path, `exports.createDraftModelRoute = () => { const configuration = globalThis[${JSON.stringify(key)}]; return configuration.create(configuration.options); };`, { mode: 0o600 });
  vi.stubEnv('AI_MODEL_ROUTE', 'approved-local');
  vi.stubEnv('AI_APPROVED_LOCAL_DRAFT_CONFIG', JSON.stringify({ module: path, route: f.route, release: f.release }));
  return { path, factory: createProductionDraftModelRouteFactory() };
}

describe('installed reservationist configuration through the ordinary route loader', () => {
  it('keeps an uninstalled provider explicitly unavailable without service or inference work', () => {
    const f = fixture();
    vi.stubEnv('AI_MODEL_ROUTE', 'approved-local');
    vi.stubEnv('AI_APPROVED_LOCAL_DRAFT_CONFIG', '');
    expect(createProductionDraftModelRouteFactory()()).toBeUndefined();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.resolveServices).not.toHaveBeenCalled();
  });

  it('loads the shared guarded provider with the supplied route, reported usage and artifact storage', async () => {
    const f = fixture(), installed = await install(f), configured = installed.factory();
    expect(configured?.reservationist).toBeTypeOf('function');
    expect(configured?.route).toEqual(f.route);
    expect(configured?.release).toEqual(f.release);
    expect(f.transport).not.toHaveBeenCalled();
    const supplied = await configured!.reservationist!(f.context);
    const result = await runReservationistRuntime(f.context.input, supplied.dependencies);
    expect(result.readiness).toBe('ready_for_staff_review');
    expect(result.textBody).toContain('Parking is available.');
    expect(supplied.artifactStorage).toBe(f.artifactStorage);
    expect(supplied.collectUsage?.()).toMatchObject({ known: true, inputTokens: 10, outputTokens: 20 });
    expect(result.packets).toEqual([]);
    expect(f.artifactStorage.stage).not.toHaveBeenCalled();
    expect(f.authorizeContext.mock.calls.length).toBeGreaterThan(2);
  });

  it.each(['generationId', 'requestedByUserId', 'threadId'] as const)('retains server authorization for a foreign %s', async field => {
    const f = fixture(), installed = await install(f), configured = installed.factory()!;
    f.context[field] = 'foreign';
    await expect(configured.reservationist!(f.context)).rejects.toThrow(/context/);
    expect(f.resolveServices).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('rejects a foreign live generation even when the structural context remains valid', async () => {
    const f = fixture(), installed = await install(f), configured = installed.factory()!;
    f.authorizeContext.mockResolvedValue(false);
    await expect(configured.reservationist!(f.context)).rejects.toThrow('context denied');
    expect(f.resolveServices).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('revalidates release withdrawal immediately before inference', async () => {
    const f = fixture(), installed = await install(f), configured = installed.factory()!;
    const supplied = await configured.reservationist!(f.context);
    vi.stubEnv('AI_APPROVED_LOCAL_DRAFT_CONFIG', JSON.stringify({ module: installed.path, route: f.route, release: { ...f.release, withdrawn: true } }));
    await expect(supplied.dependencies.plan(f.context.input, f.context.signal)).rejects.toThrow(/authority/);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('retains explicit unavailable services instead of installing a successful fallback', async () => {
    const f = fixture(), installed = await install(f), configured = installed.factory()!;
    f.resolveServices.mockRejectedValue(new Error('synthetic_source_unavailable'));
    await expect(configured.reservationist!(f.context)).rejects.toThrow('synthetic_source_unavailable');
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('refuses write-enabled execution context before source resolution', async () => {
    const f = fixture(), installed = await install(f), configured = installed.factory()!;
    (f.context.input.capabilities as { pmsWrite: boolean }).pmsWrite = true;
    await expect(configured.reservationist!(f.context)).rejects.toThrow(/context/);
    expect(f.resolveServices).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('leaves a mismatched configured release unavailable without dispatching', async () => {
    const f = fixture(), installed = await install(f);
    vi.stubEnv('AI_APPROVED_LOCAL_DRAFT_CONFIG', JSON.stringify({ module: installed.path, route: f.route, release: { ...f.release, fingerprint: 'other-authority' } }));
    expect(installed.factory()).toBeUndefined();
    expect(f.resolveServices).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
});
