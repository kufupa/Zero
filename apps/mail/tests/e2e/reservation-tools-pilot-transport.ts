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
      query?: DashboardInput | DocumentQueryAudit | U6RequestAudit | null;
    }>;
    __reservationToolsPilotFetchHandler?: typeof fetch;
    __u6DraftSafetyState?: U6DraftSafetyState;
    __u6RefreshHold?: boolean;
    __u6ReleaseRefresh?: () => void;
  }
}

type DocumentQueryAudit = {
  toolId: 'documents_list_existing' | 'documents_read_existing';
};

type U6RequestAudit = {
  procedure: string;
};

export type U6FixtureMode = 'ai' | 'manual';

export type U6DraftSafetyState = {
  mode: U6FixtureMode;
  aiDraftActive: boolean;
  stale: boolean;
  activeRun?: {
    id: string;
    state: 'queued' | 'claimed' | 'running' | 'retry_wait';
  } | null;
  draftBody: string;
  approvalCalls: number;
  sendCalls: number;
  blockedSends: number;
  smtpAttempts: number;
  acceptedSends: number;
  lastEvent: string;
  lastSentBody: string | null;
};

const FIXTURE_CUTOFF = '2026-09-07T12:00:00.000Z';
const FIXTURE_ORIGIN = 'http://127.0.0.1:4179';

type FixtureMode = 'default' | 'unauthorized' | 'error' | 'missing';

const INITIAL_FIXTURE_MODE = new URL(window.location.href).searchParams.get('fixture');

function fixtureMode(): FixtureMode {
  const mode = new URL(window.location.href).searchParams.get('fixture');
  if (mode === 'unauthorized' || mode === 'error' || mode === 'missing') return mode;
  if (
    INITIAL_FIXTURE_MODE === 'unauthorized' ||
    INITIAL_FIXTURE_MODE === 'error' ||
    INITIAL_FIXTURE_MODE === 'missing'
  ) {
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
  const inbound: number = cohortId === 'research' ? 2 : preset === '28d' ? 10 : 6;
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
      admissionPopulation: {
        availability: 'available',
        reason: inbound === 0 ? 'no_admission_receipts' : null,
        counts: {
          eligible: inbound,
          admitted: Math.max(0, inbound - 1),
          skipped: inbound > 0 ? 1 : 0,
          denied: inbound > 1 ? 1 : 0,
          pending: Math.max(0, inbound - outbound),
        },
        provenance: {
          source: 'private_shadow_store',
          missingIsNotZero: true,
          evaluationMode: 'future_shadow',
          selectionClock: 'admission_created_at',
          windowStart: isoWithDays(cutoff, preset === '28d' ? 28 : 7),
          windowEnd: cutoff,
          observationCutoff: cutoff,
        },
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

function trpcErrorResponse(
  procedure: string,
  message: string,
  code: 'CONFLICT' | 'BAD_REQUEST' = 'CONFLICT',
  status = 409,
): Response {
  return response(
    [
      {
        error: {
          json: {
            message,
            code: -32003,
            data: { code, httpStatus: status, path: procedure },
          },
        },
      },
    ],
    status,
  );
}

function parseProcedureInput(body: string | undefined): Record<string, unknown> {
  if (!body?.trim()) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    const envelope = Array.isArray(parsed)
      ? parsed.length === 1
        ? parsed[0]
        : undefined
      : isRecord(parsed) && Object.keys(parsed).length === 1 && '0' in parsed
        ? parsed['0']
        : undefined;
    if (!isRecord(envelope) || !isRecord(envelope.json)) return {};
    return envelope.json;
  } catch {
    return {};
  }
}

const U6_THREAD_ID = 'u6-thread-1';
const U6_MESSAGE_ID = 'u6-message-1';
const U6_AI_DRAFT_ID = 'u6-ai-draft';
const U6_MANUAL_DRAFT_ID = 'u6-manual-draft';
const U6_HEX = 'a'.repeat(64);
const U6_THREAD_STATE_VERSION = U6_HEX;
const U6_REFRESH_IDEMPOTENCY_KEY = `hms-refresh:transport-centurion:${U6_THREAD_ID}:${U6_THREAD_STATE_VERSION}:1.2.0`;

function u6DraftSafetyState(): U6DraftSafetyState {
  const existing = window.__u6DraftSafetyState;
  if (existing) return existing;
  const created: U6DraftSafetyState = {
    mode: 'ai',
    aiDraftActive: false,
    stale: false,
    activeRun: null,
    draftBody:
      '<p>Hello guest,</p><p>We can confirm the requested synthetic stay details for review.</p>',
    approvalCalls: 0,
    sendCalls: 0,
    blockedSends: 0,
    smtpAttempts: 0,
    acceptedSends: 0,
    lastEvent: 'candidate-ready',
    lastSentBody: null,
  };
  window.__u6DraftSafetyState = created;
  return created;
}

function emitU6DraftSafetyEvent(event: string): void {
  const state = u6DraftSafetyState();
  state.lastEvent = event;
  window.dispatchEvent(
    new CustomEvent('u6-draft-safety-update', {
      detail: {
        event,
        approvalCalls: state.approvalCalls,
        sendCalls: state.sendCalls,
        blockedSends: state.blockedSends,
        smtpAttempts: state.smtpAttempts,
        acceptedSends: state.acceptedSends,
        lastSentBody: state.lastSentBody,
      },
    }),
  );
}

function u6DraftWire(): Record<string, unknown> {
  const state = u6DraftSafetyState();
  const isManual = state.mode === 'manual';
  return {
    id: isManual ? U6_MANUAL_DRAFT_ID : U6_AI_DRAFT_ID,
    threadId: U6_THREAD_ID,
    replyToMessageId: U6_MESSAGE_ID,
    to: ['guest@example.test'],
    cc: [],
    bcc: [],
    subject: 'Re: Synthetic booking request',
    content: isManual ? state.draftBody || '<p>Manual fixture reply.</p>' : state.draftBody,
    updatedAt: '2026-09-09T12:00:00.000Z',
    status: isManual || state.aiDraftActive ? 'active' : 'candidate',
    origin: isManual ? 'manual' : 'ai',
    generationId: isManual ? null : 'u6-generation-1',
    isStale: state.stale,
  };
}

function u6ThreadPayload(): Record<string, unknown> {
  const state = u6DraftSafetyState();
  const latest = {
    id: U6_MESSAGE_ID,
    title: 'Synthetic booking request',
    subject: 'Synthetic booking request',
    tags: [],
    sender: { name: 'Fixture guest', email: 'guest@example.test' },
    to: [{ name: 'Centurion fixture', email: 'centurion@example.org' }],
    cc: null,
    bcc: null,
    tls: true,
    receivedOn: '2026-09-09T10:00:00.000Z',
    unread: false,
    body: 'Please confirm the synthetic stay details.',
    processedHtml: '<p>Please confirm the synthetic stay details.</p>',
    blobUrl: '',
    decodedBody: 'Please confirm the synthetic stay details.',
    references: '<u6-thread-1@example.test>',
    messageId: '<u6-message-1@example.test>',
    threadId: U6_THREAD_ID,
  };
  const draft = u6DraftWire();
  return {
    id: U6_THREAD_ID,
    latest,
    messages: [latest],
    drafts: state.mode === 'manual' || state.aiDraftActive ? [draft] : [draft],
    hasUnread: false,
    hasReplied: false,
    totalReplies: 0,
    labels: [],
    categories: [],
    categoryIds: [],
    conversationId: U6_THREAD_ID,
    linkedThreadIds: [],
    conversationResponded: false,
    conversationMessageCount: 1,
  };
}

function u6ApprovalToken(): Record<string, string> {
  return {
    version: 'draft-approval-v1',
    purpose: 'ai-draft-send',
    draftId: U6_AI_DRAFT_ID,
    generationId: 'u6-generation-1',
    transportId: 'transport-centurion',
    threadId: U6_THREAD_ID,
    revisionId: 'u6-revision-1',
    threadStateVersion: 'u6-thread-version-1',
    policyVersion: 'u6-policy-1',
    approvedByUserId: 'fixture-viewer',
    approvedAt: '2026-09-09T12:00:00.000Z',
    bodyDigest: U6_HEX,
    recipientDigest: U6_HEX,
    attachmentDigest: U6_HEX,
    evidenceDigest: U6_HEX,
    fingerprint: U6_HEX,
    signature: U6_HEX,
  };
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
    const record = (
      status: number,
      query?: DashboardInput | DocumentQueryAudit | U6RequestAudit | null,
    ) => {
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

    if (new URL(window.location.href).searchParams.get('fixture') === 'u6-draft-safety') {
      const procedure = url.pathname.replace(/^\/api\/trpc\//, '');
      const u6Record = (status: number) => record(status, { procedure });
      const input = parseProcedureInput(typeof init?.body === 'string' ? init.body : undefined);
      const state = u6DraftSafetyState();

      if (procedure === 'labels.list') {
        if (method !== 'POST') {
          u6Record(405);
          return trpcErrorResponse(
            procedure,
            'fixture labels.list route requires POST',
            'BAD_REQUEST',
            405,
          );
        }
        u6Record(200);
        return trpcResponse([]);
      }

      if (procedure === 'settings.get') {
        if (method !== 'POST') {
          u6Record(405);
          return trpcErrorResponse(
            procedure,
            'fixture settings route requires POST',
            'BAD_REQUEST',
            405,
          );
        }
        u6Record(200);
        return trpcResponse({
          settings: {
            language: 'en',
            timezone: 'UTC',
            dynamicContent: false,
            colorTheme: 'system',
            externalImages: true,
            trustedSenders: [],
            customPrompt: '',
            defaultEmailAlias: 'centurion@legacyhotels.co.za',
            undoSendEnabled: true,
            imageCompression: 'medium',
            autoRead: true,
            animations: false,
          },
        });
      }

      if (procedure === 'mail.get') {
        if (method !== 'POST') {
          u6Record(405);
          return trpcErrorResponse(
            procedure,
            'fixture mail.get route requires POST',
            'BAD_REQUEST',
            405,
          );
        }
        u6Record(200);
        return trpcResponse(u6ThreadPayload());
      }

      if (procedure === 'drafts.get') {
        if (method !== 'POST') {
          u6Record(405);
          return trpcErrorResponse(
            procedure,
            'fixture drafts.get route requires POST',
            'BAD_REQUEST',
            405,
          );
        }
        u6Record(200);
        return trpcResponse(u6DraftWire());
      }

      if (procedure === 'drafts.ensureEditableForReply') {
        if (method !== 'POST') {
          u6Record(405);
          return trpcErrorResponse(
            procedure,
            'fixture drafts.ensureEditableForReply route requires POST',
            'BAD_REQUEST',
            405,
          );
        }
        state.mode = 'ai';
        state.aiDraftActive = true;
        state.stale = false;
        emitU6DraftSafetyEvent('candidate-adopted');
        u6Record(200);
        return trpcResponse(u6DraftWire());
      }

      if (procedure === 'drafts.create') {
        if (method !== 'POST') {
          u6Record(405);
          return trpcErrorResponse(
            procedure,
            'fixture drafts.create route requires POST',
            'BAD_REQUEST',
            405,
          );
        }
        const html = input.html ?? input.message ?? input.content;
        if (typeof html === 'string' && html.trim()) state.draftBody = html;
        emitU6DraftSafetyEvent('draft-edited');
        u6Record(200);
        return trpcResponse(u6DraftWire());
      }

      if (procedure === 'drafts.approve') {
        if (method !== 'POST') {
          u6Record(405);
          return trpcErrorResponse(
            procedure,
            'fixture drafts.approve route requires POST',
            'BAD_REQUEST',
            405,
          );
        }
        state.approvalCalls += 1;
        emitU6DraftSafetyEvent('draft-approved');
        u6Record(200);
        return trpcResponse(u6ApprovalToken());
      }

      if (procedure === 'ai.hmsCandidateState') {
        if (method !== 'POST') {
          u6Record(405);
          return trpcErrorResponse(
            procedure,
            'fixture candidate state route requires POST',
            'BAD_REQUEST',
            405,
          );
        }
        u6Record(200);
        const hasCandidate = state.mode === 'ai' && !state.aiDraftActive;
        return trpcResponse({
          visibleCandidate: hasCandidate ? { ...u6DraftWire(), isStale: state.stale } : null,
          activeRun: state.activeRun ?? null,
          outcome: hasCandidate ? 'candidate' : null,
          freshness: hasCandidate ? (state.stale ? 'stale_thread' : 'fresh') : 'unknown',
          unresolvedFields: [],
          refreshedAt: hasCandidate ? '2026-09-09T12:01:00.000Z' : null,
        });
      }

      if (procedure === 'ai.refreshHmsCandidate') {
        if (method !== 'POST') {
          u6Record(405);
          return trpcErrorResponse(
            procedure,
            'fixture candidate refresh route requires POST',
            'BAD_REQUEST',
            405,
          );
        }
        state.activeRun = { id: 'u6-refresh-run', state: 'queued' };
        if (window.__u6RefreshHold) {
          await new Promise<void>((resolve) => {
            window.__u6ReleaseRefresh = resolve;
          });
          window.__u6ReleaseRefresh = undefined;
        }
        emitU6DraftSafetyEvent('candidate-refreshed');
        u6Record(200);
        return trpcResponse({
          runId: 'u6-refresh-run',
          runState: 'queued',
          triggerMessageId: U6_MESSAGE_ID,
          threadStateVersion: U6_THREAD_STATE_VERSION,
          idempotencyKey: U6_REFRESH_IDEMPOTENCY_KEY,
        });
      }

      if (procedure === 'mail.send') {
        if (method !== 'POST') {
          u6Record(405);
          return trpcErrorResponse(
            procedure,
            'fixture mail.send route requires POST',
            'BAD_REQUEST',
            405,
          );
        }
        state.sendCalls += 1;
        const approval = input.draftApproval ?? input.approval;
        if (state.mode === 'ai' && (!approval || !isRecord(approval))) {
          state.blockedSends += 1;
          emitU6DraftSafetyEvent('approval-required');
          u6Record(409);
          return trpcErrorResponse(procedure, 'DRAFT_APPROVAL_REQUIRED');
        }
        if (state.mode === 'ai' && state.stale) {
          state.blockedSends += 1;
          emitU6DraftSafetyEvent('approval-blocked');
          u6Record(409);
          return trpcErrorResponse(procedure, 'DRAFT_APPROVAL_INVALID');
        }
        state.smtpAttempts += 1;
        state.acceptedSends += 1;
        const message = input.message ?? input.html;
        state.lastSentBody = typeof message === 'string' ? message : null;
        emitU6DraftSafetyEvent('fake-smtp-accepted');
        u6Record(200);
        return trpcResponse({
          sent: true,
          delivery: 'full',
          messageId: `u6-fake-message-${state.acceptedSends}`,
          accepted: ['guest@example.test'],
        });
      }
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
      const payload = dashboardPayload(input);
      if (fixtureMode() === 'missing' && input.operation !== 'export' && payload.shadowScorecard) {
        payload.shadowScorecard = {
          ...payload.shadowScorecard,
          admissionPopulation: {
            availability: 'unavailable',
            reason: 'not_loaded',
            counts: { eligible: null, admitted: null, skipped: null, denied: null, pending: null },
            provenance: {
              source: 'private_shadow_store',
              missingIsNotZero: true,
              evaluationMode: 'future_shadow',
              selectionClock: 'admission_created_at',
              windowStart: null,
              windowEnd: null,
              observationCutoff: null,
            },
          },
        };
      }
      return trpcResponse(input.operation === 'export' ? dashboardExportPayload(input) : payload);
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
