import type {
  AdminDashboardExport,
  AdminDashboardMetrics,
  MetricResult,
} from '@/lib/admin-dashboard/types';
type DashboardInput = {
  cohortId: 'centurion' | 'research';
  window: '7d' | '28d';
  observationCutoff?: string;
  operation?: 'aggregate' | 'drilldown' | 'export';
};

type DashboardInputResult = { ok: true; input: DashboardInput } | { ok: false; reason: string };

declare global {
  interface Window {
    __reservationToolsPilotRequests?: Array<{
      method: string;
      path: string;
      status: number;
      query?: DashboardInput | DocumentQueryAudit | null;
    }>;
    __reservationToolsPilotFetchHandler?: typeof fetch;
  }
}

type DocumentQueryAudit = {
  toolId: 'documents_list_existing' | 'documents_read_existing';
};

const FIXTURE_CUTOFF = '2026-09-07T12:00:00.000Z';
const FIXTURE_ORIGIN = 'http://127.0.0.1:4179';

type FixtureMode = 'default' | 'unauthorized' | 'error';

const INITIAL_FIXTURE_MODE = new URL(window.location.href).searchParams.get('fixture');

function fixtureMode(): FixtureMode {
  const mode = new URL(window.location.href).searchParams.get('fixture');
  if (mode === 'unauthorized' || mode === 'error') return mode;
  if (INITIAL_FIXTURE_MODE === 'unauthorized' || INITIAL_FIXTURE_MODE === 'error') {
    return INITIAL_FIXTURE_MODE;
  }
  return 'default';
}

function metric<T>(
  value: T,
  unit: string,
  denominator: number | null,
  cutoff: string,
  options: Partial<MetricResult<T>> = {},
): MetricResult<T> {
  return {
    value,
    availability: 'available',
    unit,
    denominator,
    exclusions: {},
    timestampBasis: 'source_event',
    captureBasis: 'fixture_fake_transport',
    sourceVintage: cutoff,
    classificationAsOf: cutoff,
    snapshotBasis: 'current_observed_snapshot_at_request',
    availabilityReason: null,
    ...options,
  };
}

function unavailable<T>(unit: string, cutoff: string, reason: string): MetricResult<T> {
  return metric<T>(null as T, unit, null, cutoff, {
    availability: 'unavailable',
    timestampBasis: null,
    classificationAsOf: null,
    snapshotBasis: null,
    availabilityReason: reason,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUndefinedObservationCutoffMeta(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.values)) return false;
  if (Object.keys(value.values).length !== 1) return false;
  const marker = value.values.observationCutoff;
  return Array.isArray(marker) && marker.length === 1 && marker[0] === 'undefined';
}

function parseDashboardInput(body: string | undefined): DashboardInputResult {
  if (!body?.trim()) return { ok: false, reason: 'missing_body' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  const envelope = Array.isArray(parsed)
    ? parsed.length === 1
      ? parsed[0]
      : undefined
    : isRecord(parsed) && Object.keys(parsed).length === 1 && '0' in parsed
      ? parsed['0']
      : undefined;
  if (
    !isRecord(envelope) ||
    !Object.hasOwn(envelope, 'json') ||
    !isRecord(envelope.json) ||
    Object.keys(envelope).some((key) => key !== 'json' && key !== 'meta')
  ) {
    return { ok: false, reason: 'invalid_trpc_envelope' };
  }

  const input = envelope.json;
  const allowedKeys = new Set(['cohortId', 'window', 'observationCutoff', 'operation']);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    return { ok: false, reason: 'unknown_input_field' };
  }
  if (input.cohortId !== 'centurion' && input.cohortId !== 'research') {
    return { ok: false, reason: 'invalid_cohort' };
  }
  if (input.window !== '7d' && input.window !== '28d') {
    return { ok: false, reason: 'invalid_window' };
  }
  if (
    input.operation !== undefined &&
    input.operation !== 'aggregate' &&
    input.operation !== 'drilldown' &&
    input.operation !== 'export'
  ) {
    return { ok: false, reason: 'invalid_operation' };
  }
  const hasObservationCutoff = Object.hasOwn(input, 'observationCutoff');
  const hasMeta = Object.hasOwn(envelope, 'meta');
  if (
    hasMeta &&
    (!isUndefinedObservationCutoffMeta(envelope.meta) || input.observationCutoff !== null)
  ) {
    return { ok: false, reason: 'invalid_trpc_metadata' };
  }
  if (!hasObservationCutoff) return { ok: false, reason: 'missing_observation_cutoff' };
  let observationCutoff: string | undefined;
  if (input.observationCutoff === null) {
    if (!hasMeta || !isUndefinedObservationCutoffMeta(envelope.meta)) {
      return { ok: false, reason: 'invalid_observation_cutoff' };
    }
  } else if (input.observationCutoff !== undefined) {
    if (
      typeof input.observationCutoff !== 'string' ||
      !Number.isFinite(Date.parse(input.observationCutoff)) ||
      new Date(input.observationCutoff).toISOString() !== input.observationCutoff
    ) {
      return { ok: false, reason: 'invalid_observation_cutoff' };
    }
    observationCutoff = input.observationCutoff;
  }

  return {
    ok: true,
    input: {
      cohortId: input.cohortId,
      window: input.window,
      ...(observationCutoff === undefined ? {} : { observationCutoff }),
      ...(input.operation === undefined ? {} : { operation: input.operation }),
    },
  };
}

function isoWithDays(cutoff: string, days: number): string {
  const value = Date.parse(cutoff);
  return Number.isFinite(value)
    ? new Date(value - days * 24 * 60 * 60 * 1000).toISOString()
    : cutoff;
}

function dashboardPayload(input: DashboardInput): AdminDashboardMetrics {
  const cohortId = input.cohortId;
  const preset = input.window;
  const cutoff = input.observationCutoff ?? FIXTURE_CUTOFF;
  const historical = Boolean(input.observationCutoff && input.observationCutoff < FIXTURE_CUTOFF);
  const inbound = cohortId === 'research' ? 2 : preset === '28d' ? 10 : 6;
  const outbound = cohortId === 'research' ? 1 : preset === '28d' ? 7 : 4;
  const conversations = cohortId === 'research' ? 1 : preset === '28d' ? 5 : 3;
  const daily = [
    {
      period: '2026-09-01',
      inbound: cohortId === 'research' ? 1 : 2,
      outbound: 1,
      byTransport: {},
    },
    { period: '2026-09-02', inbound: 0, outbound: 0, byTransport: {} },
    {
      period: '2026-09-03',
      inbound: inbound - (cohortId === 'research' ? 1 : 2),
      outbound: outbound - 1,
      byTransport: {},
    },
  ];
  const unavailableFolders = unavailable<
    NonNullable<AdminDashboardMetrics['folders']>['mix']['value']
  >('conversations by folder', cutoff, 'classification_snapshot_unavailable');
  const unavailableMetric = <T>(unit: string, reason: string) =>
    unavailable<T>(unit, cutoff, reason);
  const folders = historical
    ? {
        mix: unavailableFolders,
        urgent: unavailable<number>(
          'urgent conversations',
          cutoff,
          'classification_snapshot_unavailable',
        ),
        exclusions: {},
      }
    : {
        mix: metric(
          [
            {
              folder: 'bookings',
              label: 'Bookings',
              count: conversations - 1,
              urgentCount: 1,
              classification: 'primary',
            },
            {
              folder: 'groups-events',
              label: 'Groups & Events',
              count: 1,
              urgentCount: 0,
              classification: 'primary',
            },
            {
              folder: 'unknown-review',
              label: 'Unknown / Needs Review',
              count: 0,
              urgentCount: 0,
              classification: 'unclassified',
            },
          ],
          'conversations by folder',
          conversations,
          cutoff,
        ),
        urgent: metric(1, 'urgent conversations', conversations, cutoff),
        exclusions: { spam: 1, trash: 1 },
      };

  return {
    query: {
      cohortId,
      window: preset,
      windowStart: isoWithDays(cutoff, preset === '28d' ? 28 : 7),
      windowEnd: cutoff,
      observationCutoff: cutoff,
      sourceVintage: cutoff,
    },
    traffic: {
      inbound: metric(inbound, 'messages', inbound, cutoff),
      outbound: metric(outbound, 'messages', outbound, cutoff),
      daily: metric(daily, 'messages per day', inbound + outbound, cutoff),
      comparableWindowChangePercent: metric(
        cohortId === 'research' ? 10 : 20,
        'percent',
        inbound,
        cutoff,
      ),
    },
    activity: {
      activeConversations: metric(conversations, 'conversations', conversations, cutoff),
      newlyObservedConversations: metric(
        Math.max(1, conversations - 1),
        'conversations',
        conversations,
        cutoff,
      ),
      continuingConversations: metric(1, 'conversations', conversations, cutoff),
      distinctExternalSenderAddresses: metric(
        cohortId === 'research' ? 2 : 4,
        'email addresses',
        inbound,
        cutoff,
      ),
      weekdayArrivals: metric(
        { Monday: Math.max(1, inbound - 2), Wednesday: 2 },
        'arrivals by weekday',
        inbound,
        cutoff,
      ),
      hourArrivals: metric(
        { '09': Math.max(1, inbound - 3), '14': 3 },
        'arrivals by hour',
        inbound,
        cutoff,
      ),
    },
    folders,
    correspondents: {
      externalDomains: historical
        ? unavailableMetric('external domains', 'classification_snapshot_unavailable')
        : metric(
            [
              { domain: 'public-email', count: inbound - 2, addresses: 2 },
              { domain: 'example.org', count: 2, addresses: 2 },
            ],
            'external domains',
            inbound,
            cutoff,
          ),
    },
    service: {
      firstObservedHumanReply: unavailableMetric('calendar minutes', 'reply_evidence_unavailable'),
      firstUsefulReply: unavailableMetric('calendar minutes', 'no_useful_reply_evidence'),
      counts: {
        eligibleNewConversations: {
          ...unavailableMetric<number>('conversations', 'reply_evidence_unavailable'),
          denominatorStatus: 'not_applicable',
        },
        unansweredEligible: {
          ...unavailableMetric<number>('conversations', 'reply_evidence_unavailable'),
          denominatorStatus: 'unknown',
        },
        unscorable: {
          ...unavailableMetric<number>('conversations', 'reply_evidence_unavailable'),
          denominatorStatus: 'unknown',
        },
        measurementStartAt: null,
        measurementConfigVersion: null,
      },
      eligibleNewConversationCount: null,
      unansweredEligible: null,
      unscorable: null,
    },
    shadowScorecard: {
      schemaVersion: 'shadow-scorecard-v1',
      evaluationMode: 'future_shadow',
      counts: {
        eligible: inbound,
        admitted: inbound,
        sealed: inbound,
        unavailable: 0,
        failed: 0,
        skipped: 0,
        denied: 0,
        pending: Math.max(0, inbound - outbound),
        matched: Math.min(inbound, outbound),
        late: 0,
        ambiguous: 0,
        unmatched: 0,
        unobserved: 0,
        unknownCoverage: 0,
        changedState: 0,
        unscorable: 0,
        labelled: 0,
        scorable: 0,
        correct: 0,
        partial: 0,
        incorrect: 0,
      },
      quality: {
        availability: 'unavailable',
        denominator: null,
        reason: 'label_provenance_unavailable',
        correctRate: null,
        usefulRate: null,
      },
      provenance: {
        source: 'private_shadow_store',
        missingIsNotZero: true,
        evaluationMode: 'future_shadow',
      },
    },
    conversations: {
      awaitingHotel: unavailableMetric('conversations', 'request_projection_unavailable'),
      awaitingCustomer: unavailableMetric('conversations', 'request_projection_unavailable'),
      hotelActionPending: unavailableMetric('conversations', 'request_projection_unavailable'),
      answered: unavailableMetric('conversations', 'request_projection_unavailable'),
      noReplyRequired: unavailableMetric('conversations', 'request_projection_unavailable'),
      partial: unavailableMetric('conversations', 'request_projection_unavailable'),
      unknown: unavailableMetric('conversations', 'request_projection_unavailable'),
      unknownEvidence: unavailableMetric('conversations', 'request_projection_unavailable'),
      bucketTotals: unavailableMetric('conversations', 'request_projection_unavailable'),
      ageBands: unavailableMetric('calendar age bands', 'request_projection_unavailable'),
    },
    dataHealth: historical
      ? {
          availability: 'unavailable',
          availabilityReason: 'missing_evidence',
          observationCutoff: cutoff,
          directionCounts: { inbound: null, outbound: null },
          lastObservedAt: { inbound: null, outbound: null },
          lastObservedBasis: { inbound: null, outbound: null },
          singleton: { numerator: null, denominator: null },
          quotedMailboxReplyNoMatchingOutbound: {
            numerator: null,
            denominator: null,
            availability: 'unavailable',
            reason: 'quote_projection_unavailable',
          },
          unscorable: {
            total: 0,
            inbound: 0,
            outbound: 0,
            missingClock: 0,
            invalidClock: 0,
            missingThreadLinkage: 0,
            missingIdentity: 0,
          },
        }
      : {
          availability: 'available',
          observationCutoff: cutoff,
          directionCounts: { inbound, outbound },
          lastObservedAt: { inbound: cutoff, outbound: cutoff },
          lastObservedBasis: { inbound: 'source_event', outbound: 'source_event' },
          singleton: { numerator: 1, denominator: conversations },
          quotedMailboxReplyNoMatchingOutbound: {
            numerator: 1,
            denominator: inbound,
            availability: 'available',
          },
          unscorable: {
            total: 1,
            inbound: 1,
            outbound: 0,
            missingClock: 1,
            invalidClock: 0,
            missingThreadLinkage: 0,
            missingIdentity: 0,
          },
        },
    inboundVolume: { availability: 'live', value: inbound },
    medianFirstResponseMinutes: { availability: 'unavailable', value: null },
    p90FirstResponseMinutes: { availability: 'unavailable', value: null },
    answeredWithin3hPercent: { availability: 'unavailable', value: null },
    draftCreationMinutes: { availability: 'unavailable', value: null },
    aiAssistedSendRate: { availability: 'unavailable', value: null },
    medianEditDistance: { availability: 'unavailable', value: null },
    totalRevenue: { availability: 'unavailable', value: null },
    eligibleThreadCount: null,
    unansweredEligible: null,
    inboundPerDay: [],
    comparison: [],
    perTransport: [],
    transports: [
      {
        id: cohortId === 'research' ? 'transport-nava' : 'transport-centurion',
        email: cohortId === 'research' ? 'research@example.org' : 'centurion@example.org',
        displayName: cohortId === 'research' ? 'Research fixture' : 'Centurion fixture',
      },
    ],
    assumptions: ['Synthetic public-safe fixture; no live mail or model calls.'],
    footnote: 'Synthetic public-safe dashboard fixture.',
    windowStart: isoWithDays(cutoff, preset === '28d' ? 28 : 7),
    windowEnd: cutoff,
  } as AdminDashboardMetrics;
}

function dashboardExportPayload(input: DashboardInput): AdminDashboardExport {
  const payload = dashboardPayload(input);
  const conversations = payload.conversations!;
  const captureBasis = payload.traffic?.inbound.captureBasis;
  return {
    schemaVersion: 'admin-dashboard-export-v1',
    query: payload.query!,
    provenance: {
      observationCutoff: payload.query!.observationCutoff,
      sourceVintage: payload.query!.sourceVintage,
      measurementConfigVersions: [],
      captureBases: captureBasis ? [captureBasis] : [],
    },
    buckets: {
      awaiting_hotel_reply: conversations.awaitingHotel,
      awaiting_customer_information: conversations.awaitingCustomer,
      hotel_action_pending: conversations.hotelActionPending,
      unknown: conversations.unknown,
      answered: conversations.answered,
      no_reply_required: conversations.noReplyRequired,
    },
    overlays: {
      partially_answered: conversations.partial,
      unknown_evidence: conversations.unknownEvidence,
    },
    metrics: {
      traffic: payload.traffic!,
      activity: payload.activity!,
      service: payload.service!,
      folders: payload.folders!,
      correspondents: payload.correspondents!,
      dataHealth: payload.dataHealth ?? null,
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function trpcResponse(data: unknown): Response {
  return response([{ result: { data: { json: data } } }]);
}

function proxyDocumentRequest(url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (url.origin !== FIXTURE_ORIGIN) {
      reject(new Error(`fixture document bridge refused non-loopback origin ${url.origin}`));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(init.method ?? 'GET', url.href);
    const headers = new Headers(init.headers);
    headers.forEach((value, key) => xhr.setRequestHeader(key, value));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status > 599) {
        reject(new Error(`fixture document bridge network status ${xhr.status}`));
        return;
      }
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          headers: {
            'content-type': xhr.getResponseHeader('content-type') ?? 'application/json',
          },
        }),
      );
    };
    xhr.onerror = () => reject(new Error('fixture document bridge network failure'));
    if (init.body !== undefined && typeof init.body !== 'string') {
      reject(new Error('fixture document bridge only accepts serialized JSON bodies'));
      return;
    }
    xhr.send(typeof init.body === 'string' ? init.body : null);
  });
}

export function installReservationToolsPilotTransport(): void {
  window.__reservationToolsPilotFetchHandler = async (input, init) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(requestUrl, window.location.href);
    const requestLog = (window.__reservationToolsPilotRequests ??= []);
    const method = init?.method ?? 'GET';
    const record = (status: number, query?: DashboardInput | DocumentQueryAudit | null) => {
      requestLog.push({
        method,
        path: url.pathname,
        status,
        ...(query === undefined ? {} : { query }),
      });
    };
    if (url.origin !== FIXTURE_ORIGIN) {
      record(0, null);
      throw new Error(`fixture transport refused non-loopback origin ${url.origin}`);
    }

    if (
      url.pathname.endsWith('/api/auth/get-session') ||
      url.pathname.endsWith('/settings/undefined')
    ) {
      if (method !== 'GET') {
        record(405, null);
        return response({ error: { message: 'fixture route requires GET' } }, 405);
      }
      const unauthorized = fixtureMode() === 'unauthorized';
      record(200);
      return response(
        unauthorized
          ? {
              user: { id: 'fixture-denied', email: 'denied@example.org' },
              session: { id: 'fixture-session' },
            }
          : {
              user: { id: 'fixture-viewer', email: 'navaai@legacyhotels.co.za' },
              session: { id: 'fixture-session' },
            },
      );
    }

    if (url.pathname.endsWith('/adminDashboard.getMetrics')) {
      if (method !== 'POST') {
        record(405, null);
        return response({ error: { message: 'fixture dashboard route requires POST' } }, 405);
      }
      const parsedInput = parseDashboardInput(
        typeof init?.body === 'string' ? init.body : undefined,
      );
      if (!parsedInput.ok) {
        record(400, null);
        return response(
          {
            error: {
              message: 'fixture dashboard request rejected',
              data: { code: 'BAD_REQUEST', reason: parsedInput.reason },
            },
          },
          400,
        );
      }
      const input = parsedInput.input;
      if (fixtureMode() === 'error' && input.window === '28d') {
        record(503, input);
        return response(
          {
            error: {
              json: {
                message: 'fixture dashboard outage',
                code: -32603,
                data: {
                  code: 'INTERNAL_SERVER_ERROR',
                  httpStatus: 503,
                  path: 'adminDashboard.getMetrics',
                },
              },
            },
          },
          503,
        );
      }
      record(200, input);
      return trpcResponse(
        input.operation === 'export' ? dashboardExportPayload(input) : dashboardPayload(input),
      );
    }

    if (
      url.pathname.endsWith('/documents.listExisting') ||
      url.pathname.endsWith('/documents.readExisting')
    ) {
      if (method !== 'POST') {
        record(405, null);
        return response({ error: { message: 'fixture document route requires POST' } }, 405);
      }
      const isList = url.pathname.endsWith('/documents.listExisting');
      const audit: DocumentQueryAudit = isList
        ? { toolId: 'documents_list_existing' }
        : { toolId: 'documents_read_existing' };
      return proxyDocumentRequest(url, { ...init, method }).then((proxiedResponse) => {
        record(proxiedResponse.status, audit);
        return proxiedResponse;
      });
    }

    if (url.pathname.endsWith('/connections.getDefault')) {
      record(200);
      return trpcResponse({
        id: 'transport-centurion',
        email: 'centurion@example.org',
        name: 'Centurion fixture',
        picture: null,
        createdAt: null,
        providerId: 'mailbox',
      });
    }

    record(404, null);
    return response({ error: { message: 'fixture route unavailable' } }, 404);
  };
}
