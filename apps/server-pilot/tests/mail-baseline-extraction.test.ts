import {
  createProductionMailBaselineExtractionRouteFactory,
  loadConfiguredMailBaselineExtractionRoute,
} from '../src/ai/mail-baseline-route-factory.js';
import {
  extractMailBaselineEvidence,
  resolveMailBaselineExtractionRoute,
} from '../src/ai/mail-baseline-extraction.js';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type InitializationBoundaryProbeState = {
  imports: number;
  factoryCalls: number;
  clientInitializations: number;
  transportCalls: number;
};

type InitializationBoundaryGlobal = typeof globalThis & {
  __u2InitializationBoundaryProbe?: InitializationBoundaryProbeState;
};

const initializationBoundaryProbePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'u2-initialization-boundary-probe.cjs',
);

function initializationBoundaryProbeState(): InitializationBoundaryProbeState {
  return (
    (globalThis as InitializationBoundaryGlobal).__u2InitializationBoundaryProbe ?? {
      imports: 0,
      factoryCalls: 0,
      clientInitializations: 0,
      transportCalls: 0,
    }
  );
}

function expectNoInitializationForBoundaryCase(input: {
  moduleConfigured: boolean;
  config?: string;
}): void {
  const priorRoute = process.env.AI_MODEL_ROUTE;
  const priorModule = process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
  const priorConfig = process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
  (globalThis as InitializationBoundaryGlobal).__u2InitializationBoundaryProbe = {
    imports: 0,
    factoryCalls: 0,
    clientInitializations: 0,
    transportCalls: 0,
  };
  process.env.AI_MODEL_ROUTE = 'approved-local';
  if (input.moduleConfigured) {
    process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE = initializationBoundaryProbePath;
  } else {
    delete process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
  }
  if (input.config === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
  else process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG = input.config;
  try {
    expect(loadConfiguredMailBaselineExtractionRoute()).toBeUndefined();
    expect(createProductionMailBaselineExtractionRouteFactory()()).toBeUndefined();
    expect(initializationBoundaryProbeState()).toEqual({
      imports: 0,
      factoryCalls: 0,
      clientInitializations: 0,
      transportCalls: 0,
    });
  } finally {
    if (priorRoute === undefined) delete process.env.AI_MODEL_ROUTE;
    else process.env.AI_MODEL_ROUTE = priorRoute;
    if (priorModule === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
    else process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE = priorModule;
    if (priorConfig === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
    else process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG = priorConfig;
    delete (globalThis as InitializationBoundaryGlobal).__u2InitializationBoundaryProbe;
  }
}

describe('mail baseline semantic extraction', () => {
  it('uses source event clocks and emits an ask without persisting message bodies', () => {
    const result = extractMailBaselineEvidence({
      sourceVintage: 'v1',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      message: {
        id: 'inbound-1',
        transportId: 'transport-centurion',
        threadId: 'thread-1',
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['centurion@legacyhotels.co.za'],
        subject: 'Please confirm the rate and booking',
        textBody: 'Please confirm the rate and booking for next week.',
        receivedAt: '2026-09-02T09:00:00.000Z',
        createdAt: '2026-09-02T09:05:00.000Z',
        sentAt: null,
        messageIdHeader: '<inbound-1@example.com>',
        inReplyTo: null,
        references: [],
      },
    });

    expect(result).toMatchObject({
      extractionVersion: expect.any(String),
      sourceBasis: 'source_event',
      eventAt: '2026-09-02T09:00:00.000Z',
    });
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'ask',
          askId: expect.any(String),
          requiresHotelResponse: false,
          answerState: 'unknown',
          unknownReason: 'semantic_route_unavailable',
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('Please confirm the rate');
  });

  it('does not emit substantive answer evidence for auto-acks or internal forwards', () => {
    const ack = extractMailBaselineEvidence({
      sourceVintage: 'v1',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      message: {
        id: 'ack-1',
        transportId: 'transport-centurion',
        threadId: 'thread-1',
        direction: 'outbound',
        fromAddress: 'centurion@legacyhotels.co.za',
        toAddresses: ['guest@example.com'],
        subject: 'We received your email',
        textBody: 'Thank you, we received your email.',
        receivedAt: null,
        createdAt: '2026-09-02T10:00:00.000Z',
        sentAt: '2026-09-02T10:00:00.000Z',
        messageIdHeader: '<ack-1@example.com>',
        inReplyTo: '<inbound-1@example.com>',
        references: ['<inbound-1@example.com>'],
        sendEvidence: { status: 'accepted', acceptedAt: '2026-09-02T10:00:01.000Z' },
      },
    });
    const forward = extractMailBaselineEvidence({
      sourceVintage: 'v1',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      message: {
        id: 'forward-1',
        transportId: 'transport-centurion',
        threadId: 'thread-1',
        direction: 'outbound',
        fromAddress: 'staff@legacyhotels.co.za',
        toAddresses: ['other-staff@legacyhotels.co.za'],
        subject: 'Fwd: Please confirm',
        textBody: 'Forwarded for awareness.',
        receivedAt: null,
        createdAt: '2026-09-02T10:05:00.000Z',
        sentAt: '2026-09-02T10:05:00.000Z',
        messageIdHeader: '<forward-1@example.com>',
        inReplyTo: '<inbound-1@example.com>',
        references: ['<inbound-1@example.com>'],
        sendEvidence: { status: 'accepted', acceptedAt: '2026-09-02T10:05:01.000Z' },
      },
    });
    expect(ack.evidence.every((item) => item.substantive !== true)).toBe(true);
    expect(forward.evidence.every((item) => item.substantive !== true)).toBe(true);
  });

  it('emits a compact unknown boundary for a committed inbound with no supported ask', () => {
    const result = extractMailBaselineEvidence({
      sourceVintage: 'v1',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      message: {
        id: 'no-label-1',
        transportId: 'transport-centurion',
        threadId: 'thread-1',
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        subject: 'Hello',
        textBody: 'Hello there',
        receivedAt: '2026-09-02T11:00:00.000Z',
        createdAt: '2026-09-02T11:00:01.000Z',
      },
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      eventType: 'ask',
      answerState: 'unknown',
      unknownReason: 'no_supported_ask',
    });
    expect(JSON.stringify(result)).not.toContain('Hello there');
  });

  it('uses the scoped message header plus ask code for inbound/outbound linking', () => {
    const inbound = extractMailBaselineEvidence({
      sourceVintage: 'v1',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      message: {
        id: 'inbound-link',
        transportId: 'transport-centurion',
        threadId: 'thread-link',
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        subject: 'Please confirm the reservation',
        textBody: 'Please confirm the reservation.',
        receivedAt: '2026-09-02T09:00:00.000Z',
        createdAt: '2026-09-02T09:00:01.000Z',
        messageIdHeader: '<request@example.com>',
      },
    });
    const outbound = extractMailBaselineEvidence({
      sourceVintage: 'v1',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      message: {
        id: 'outbound-link',
        transportId: 'transport-centurion',
        threadId: 'thread-link',
        direction: 'outbound',
        fromAddress: 'staff@legacyhotels.co.za',
        subject: 'Re: reservation',
        textBody: 'The reservation is confirmed.',
        sentAt: '2026-09-02T10:00:00.000Z',
        createdAt: '2026-09-02T10:00:01.000Z',
        inReplyTo: '<request@example.com>',
        sendEvidence: { status: 'accepted', acceptedAt: '2026-09-02T10:00:01.000Z' },
      },
    });
    expect(outbound.evidence[0]?.askId).toBe(inbound.evidence[0]?.askId);
  });

  it('fails closed before client initialization when the approved extraction route is unavailable', () => {
    expect(resolveMailBaselineExtractionRoute({ approvedRoute: undefined })).toMatchObject({
      available: false,
      reason: 'approved_route_unavailable',
    });
    expect(resolveMailBaselineExtractionRoute({ approvedRoute: 'approved-local' })).toMatchObject({
      available: false,
      reason: 'approved_route_unavailable',
    });
    expect(
      resolveMailBaselineExtractionRoute({ approvedRoute: 'approved-local-mail' }),
    ).toMatchObject({
      available: false,
      reason: 'approved_route_unavailable',
    });
  });

  it('normal startup remains unavailable for a marker without a configured lower edge', () => {
    const priorRoute = process.env.AI_MODEL_ROUTE;
    const priorModule = process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
    const priorConfig = process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
    process.env.AI_MODEL_ROUTE = 'approved-local';
    delete process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
    delete process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
    try {
      expect(loadConfiguredMailBaselineExtractionRoute()).toBeUndefined();
      expect(createProductionMailBaselineExtractionRouteFactory()()).toBeUndefined();
    } finally {
      if (priorRoute === undefined) delete process.env.AI_MODEL_ROUTE;
      else process.env.AI_MODEL_ROUTE = priorRoute;
      if (priorModule === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
      else process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE = priorModule;
      if (priorConfig === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
      else process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG = priorConfig;
    }
  });

  it.each([
    { name: 'missing module/configuration', moduleConfigured: false },
    { name: 'unproved module without descriptor', moduleConfigured: true },
    { name: 'malformed descriptor', moduleConfigured: true, config: '{not-json' },
    {
      name: 'incomplete descriptor',
      moduleConfigured: true,
      config: JSON.stringify({
        module: initializationBoundaryProbePath,
        route: { purpose: 'extraction' },
      }),
    },
    {
      name: 'wrong-purpose descriptor',
      moduleConfigured: true,
      config: JSON.stringify({
        module: initializationBoundaryProbePath,
        route: {
          routeId: 'u2-unapproved-draft-route',
          purpose: 'draft',
          protocol: 'in_process',
          access: 'current_app',
          egress: 'none',
          retention: 'bounded',
          usage: 'reported',
          modelId: 'u2-unapproved-draft-model',
        },
      }),
    },
  ])('does not initialize a lower edge for $name', ({ moduleConfigured, config }) => {
    expectNoInitializationForBoundaryCase({ moduleConfigured, config });
  });

  it('loads the explicitly configured in-process lower edge through the startup factory', async () => {
    const priorRoute = process.env.AI_MODEL_ROUTE;
    const priorModule = process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
    const priorConfig = process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
    const configuredModule = join(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'u2-second-approved-local-extraction.cjs',
    );
    process.env.AI_MODEL_ROUTE = 'approved-local';
    delete process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
    process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG = JSON.stringify({
      module: configuredModule,
      route: {
        routeId: 'u2-configured-extraction-route',
        purpose: 'extraction',
        protocol: 'in_process',
        access: 'current_app',
        egress: 'none',
        retention: 'bounded',
        usage: 'reported',
        modelId: 'u2-configured-extraction-model',
      },
    });
    try {
      const configured = loadConfiguredMailBaselineExtractionRoute();
      expect(configured?.route).toMatchObject({
        routeId: 'u2-configured-extraction-route',
        purpose: 'extraction',
      });
      expect(configured?.transport).toBeTypeOf('function');
      expect(createProductionMailBaselineExtractionRouteFactory()()?.route).toMatchObject(
        configured?.route ?? {},
      );
    } finally {
      if (priorRoute === undefined) delete process.env.AI_MODEL_ROUTE;
      else process.env.AI_MODEL_ROUTE = priorRoute;
      if (priorModule === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
      else process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE = priorModule;
      if (priorConfig === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
      else process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG = priorConfig;
    }
  });

  it('recognizes only a purpose-bound local route with a real injected transport', () => {
    let transportCalls = 0;
    const route = {
      routeId: 'u2-synthetic-extraction-route',
      purpose: 'extraction' as const,
      protocol: 'in_process' as const,
      access: 'current_app' as const,
      egress: 'none' as const,
      retention: 'bounded' as const,
      usage: 'reported' as const,
      modelId: 'u2-synthetic-extraction-model',
    };
    const resolved = resolveMailBaselineExtractionRoute({
      approvedRoute: 'approved-local',
      route,
      transport: async () => {
        transportCalls += 1;
        return {
          output: {},
          usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
        };
      },
    });
    expect(resolved).toMatchObject({
      available: true,
      route: route.routeId,
    });
    expect(transportCalls).toBe(0);
  });
});
