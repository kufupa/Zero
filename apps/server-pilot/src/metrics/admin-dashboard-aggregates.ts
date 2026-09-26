/**
 * Pure admin-dashboard baseline aggregators.
 * Compute-on-read from message/thread rows — no warehouse, no PII bodies.
 */

import {
  PRIMARY_BUCKETS,
  type MailBaselinePrimaryBucket,
  type MailBaselineProjection,
} from './mail-baseline.js';
import { isWithinConfirmedGap, type MailboxMeasurementConfig } from './mail-measurement-config.js';
import { buildMailDataHealth, type MailDataHealthMessage } from './mail-data-health.js';
import type { ShadowScorecard } from './shadow-scorecard.js';

export type MetricAvailability = 'live' | 'unavailable' | 'coming_soon';

export type DashboardMetricAvailability = 'available' | 'unavailable';
export type DashboardTimestampBasis =
  | 'source_event'
  | 'sender_timestamp_estimate'
  | 'first_known'
  | 'availability'
  | 'mixed'
  | 'unknown';

export type MetricResult<T> = {
  value: T | null;
  availability: DashboardMetricAvailability;
  unit: string;
  denominator: number | null;
  exclusions: Record<string, number>;
  timestampBasis: DashboardTimestampBasis | null;
  captureBasis: string | null;
  sourceVintage: string;
  classificationAsOf: string | null;
  snapshotBasis: string | null;
  measurementConfigVersion: string | null;
  availabilityReason: string | null;
};

export type AdminDashboardCountDenominatorStatus = 'known' | 'unknown' | 'not_applicable';

export type AdminDashboardCountMetric = MetricResult<number> & {
  /** Distinguishes an absolute count from a count whose population is unknown. */
  denominatorStatus: AdminDashboardCountDenominatorStatus;
};

export type DashboardCohortId = 'centurion' | 'research';
export type DashboardWindowPreset = '7d' | '28d';

export type ExecutiveDashboardQuery = {
  cohortId: DashboardCohortId;
  window: DashboardWindowPreset;
  windowStart: string;
  windowEnd: string;
  observationCutoff: string;
  sourceVintage: string;
};

export type AdminDashboardDailyPoint = {
  period: string;
  inbound: number;
  outbound: number;
  byTransport: Record<string, { inbound: number; outbound: number }>;
};

export type AdminDashboardFolderRow = {
  folder: string;
  label: string;
  count: number;
  urgentCount: number;
  classification: 'primary' | 'ambiguous' | 'legacy' | 'unclassified';
};

export type AdminDashboardDomainRow = {
  domain: string;
  count: number;
  addresses: number;
};

export type AdminDashboardClassificationThread = {
  threadId: string;
  primaryFolder?: string | null;
  folderSlugs?: readonly string[];
  urgent?: boolean;
  spam?: boolean;
  trashed?: boolean;
};

export type AdminDashboardClassificationSnapshot = {
  classificationAsOf: Date | string;
  snapshotBasis: string;
  threads: readonly AdminDashboardClassificationThread[];
};

export type AdminDashboardTraffic = {
  inbound: MetricResult<number>;
  outbound: MetricResult<number>;
  daily: MetricResult<AdminDashboardDailyPoint[]>;
  comparableWindowChangePercent: MetricResult<number>;
};

export type AdminDashboardActivity = {
  activeConversations: MetricResult<number>;
  newlyObservedConversations: MetricResult<number>;
  continuingConversations: MetricResult<number>;
  distinctExternalSenderAddresses: MetricResult<number>;
  weekdayArrivals: MetricResult<Record<string, number>>;
  hourArrivals: MetricResult<Record<string, number>>;
};

export type AdminDashboardFolders = {
  mix: MetricResult<AdminDashboardFolderRow[]>;
  urgent: MetricResult<number>;
  exclusions: Record<string, number>;
};

export type AdminDashboardCorrespondents = {
  externalDomains: MetricResult<AdminDashboardDomainRow[]>;
};

export type AdminDashboardServiceCounts = {
  eligibleNewConversations: AdminDashboardCountMetric;
  unansweredEligible: AdminDashboardCountMetric;
  unscorable: AdminDashboardCountMetric;
  /** Configured prospective measurement start; null means no trusted T0 was returned. */
  measurementStartAt: string | null;
  /** Version of the measurement config used for these counts, if available. */
  measurementConfigVersion: string | null;
};

export type AdminDashboardService = {
  firstObservedHumanReply: MetricResult<number>;
  firstUsefulReply: MetricResult<number>;
  counts: AdminDashboardServiceCounts;
  /** Null when the retained evidence cannot establish the eligible set. */
  eligibleNewConversationCount: number | null;
  unansweredEligible: number | null;
  unscorable: number | null;
};

/**
 * Request-state work is deliberately not inferred from thread/folder rows.
 * U2 owns the retained ask projection; until that evidence exists each state
 * remains an explicit unavailable metric rather than an attractive zero.
 */
export type AdminDashboardConversations = {
  awaitingHotel: MetricResult<number>;
  awaitingCustomer: MetricResult<number>;
  hotelActionPending: MetricResult<number>;
  answered: MetricResult<number>;
  noReplyRequired: MetricResult<number>;
  partial: MetricResult<number>;
  unknown: MetricResult<number>;
  unknownEvidence: MetricResult<number>;
  bucketTotals: MetricResult<Record<MailBaselinePrimaryBucket, number>>;
  ageBands: MetricResult<Record<string, number>>;
};

export type AdminDashboardPayload = {
  query: ExecutiveDashboardQuery;
  traffic: AdminDashboardTraffic;
  activity: AdminDashboardActivity;
  conversations: AdminDashboardConversations;
  folders: AdminDashboardFolders;
  correspondents: AdminDashboardCorrespondents;
  service: AdminDashboardService;
  dataHealth: import('./mail-data-health.js').MailDataHealth | null;
};

export type ExecutiveDashboardPayload = AdminDashboardPayload;

export type MetricCell = {
  availability: MetricAvailability;
  value: number | null;
};

export type AdminDashboardMessageRow = {
  id: string;
  threadId: string;
  transportId: string;
  direction: 'inbound' | 'outbound';
  receivedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  canonicalId?: string | null;
  sourceMessageId?: string | null;
  fromAddress?: string | null;
  sendState?: 'pending' | 'sending' | 'sent' | 'accepted' | 'cancelled' | 'failed' | null;
  /** Optional server-projected source/header clocks used by strict metrics. */
  sourceEventAt?: Date | null;
  eventAt?: Date | null;
  headerDateAt?: Date | null;
  firstKnownAt?: Date | null;
  authorClass?:
    | 'external_human'
    | 'external_automated'
    | 'internal_human'
    | 'internal_automated'
    | 'unknown';
  qualifiesNewConversation?: boolean;
  hasScopedReplyLink?: boolean;
  isAcknowledgement?: boolean;
  hasMatchingOutbound?: boolean;
};

export type AdminDashboardThreadRow = {
  id: string;
  transportId: string;
  spamAt: Date | null;
  trashedAt: Date | null;
  createdAt?: Date | null;
  latestMessageAt?: Date | null;
};

export type AdminDashboardTransportRow = {
  id: string;
  email: string;
  displayName: string | null;
};

export type AdminDashboardInboundDay = {
  period: string;
  byTransport: Record<string, number>;
};

export type AdminDashboardComparisonRow = {
  transportId: string;
  label: string;
  inbound: number;
  answeredWithin3hPercent: number | null;
  drafted: null;
};

/**
 * Per-transport raw inputs so the client can recompute LIVE cells for a
 * mailbox subset without inventing combined medians. Latencies are minutes.
 */
export type AdminDashboardTransportSeries = {
  transportId: string;
  label: string;
  inbound: number;
  latenciesMinutes: number[];
  /** Null when first-reply evidence is not available for this scope. */
  unanswered: number | null;
};

export type AdminDashboardAggregateResult = {
  query: ExecutiveDashboardQuery;
  traffic: AdminDashboardTraffic;
  activity: AdminDashboardActivity;
  conversations: AdminDashboardConversations;
  folders: AdminDashboardFolders;
  correspondents: AdminDashboardCorrespondents;
  service: AdminDashboardService;
  dataHealth: import('./mail-data-health.js').MailDataHealth | null;
  inboundVolume: MetricCell;
  medianFirstResponseMinutes: MetricCell;
  p90FirstResponseMinutes: MetricCell;
  answeredWithin3hPercent: MetricCell;
  draftCreationMinutes: MetricCell;
  aiAssistedSendRate: MetricCell;
  medianEditDistance: MetricCell;
  totalRevenue: MetricCell;
  eligibleThreadCount: number | null;
  unansweredEligible: number | null;
  inboundPerDay: AdminDashboardInboundDay[];
  comparison: AdminDashboardComparisonRow[];
  perTransport: AdminDashboardTransportSeries[];
  transports: AdminDashboardTransportRow[];
  assumptions: string[];
  footnote: string;
  windowStart: string;
  windowEnd: string;
  /** Private U13 scorecard; absent only for legacy aggregate producers. */
  shadowScorecard?: ShadowScorecard;
};

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const NAVA_TRANSPORT_ID = 'transport-nava';
const NAVA_EMAIL = 'navaai@legacyhotels.co.za';

export const ADMIN_DASHBOARD_ASSUMPTIONS = [
  'bcc_outbound_coverage',
  'africa_johannesburg_buckets',
] as const;

export const ADMIN_DASHBOARD_FOOTNOTE =
  'Baseline from Centurion ingest; hotel replies via BCC. Nava drafting not live.';

function live(value: number | null): MetricCell {
  return { availability: 'live', value };
}

function unavailable(): MetricCell {
  return { availability: 'unavailable', value: null };
}

function comingSoon(): MetricCell {
  return { availability: 'coming_soon', value: null };
}

function legacyMetric<T>(
  value: T | null,
  options: {
    unit: string;
    denominator?: number | null;
    exclusions?: Record<string, number>;
    timestampBasis?: DashboardTimestampBasis | null;
    captureBasis?: string | null;
    sourceVintage: string;
    classificationAsOf?: string | null;
    snapshotBasis?: string | null;
    measurementConfigVersion?: string | null;
  },
): MetricResult<T> {
  return {
    value,
    availability: 'available',
    unit: options.unit,
    denominator: options.denominator ?? null,
    exclusions: options.exclusions ?? {},
    timestampBasis: options.timestampBasis ?? null,
    captureBasis: options.captureBasis ?? null,
    sourceVintage: options.sourceVintage,
    classificationAsOf: options.classificationAsOf ?? null,
    snapshotBasis: options.snapshotBasis ?? null,
    measurementConfigVersion: options.measurementConfigVersion ?? null,
    availabilityReason: null,
  };
}

function unavailableMetric<T>(
  reason: string,
  options: {
    unit: string;
    sourceVintage: string;
    denominator?: number | null;
    exclusions?: Record<string, number>;
    timestampBasis?: DashboardTimestampBasis | null;
    captureBasis?: string | null;
    classificationAsOf?: string | null;
    snapshotBasis?: string | null;
    measurementConfigVersion?: string | null;
  },
): MetricResult<T> {
  return {
    value: null,
    availability: 'unavailable',
    unit: options.unit,
    denominator: options.denominator ?? null,
    exclusions: options.exclusions ?? {},
    timestampBasis: options.timestampBasis ?? null,
    captureBasis: options.captureBasis ?? null,
    sourceVintage: options.sourceVintage,
    classificationAsOf: options.classificationAsOf ?? null,
    snapshotBasis: options.snapshotBasis ?? null,
    measurementConfigVersion: options.measurementConfigVersion ?? null,
    availabilityReason: reason,
  };
}

function withCountDenominatorStatus(
  metric: MetricResult<number>,
  denominatorStatus: AdminDashboardCountDenominatorStatus,
): AdminDashboardCountMetric {
  return { ...metric, denominatorStatus };
}

function resultDailyFromLegacy(
  inboundPerDay: readonly AdminDashboardInboundDay[],
  messages: readonly AdminDashboardMessageRow[],
  windowStart: Date,
  windowEnd: Date,
): AdminDashboardDailyPoint[] {
  const outboundByDay = new Map<string, number>();
  for (const message of messages) {
    if (message.direction !== 'outbound') continue;
    const at = messageInstant(message, true);
    if (at && inWindow(at, windowStart, windowEnd)) {
      const period = dayKeyJohannesburg(at);
      outboundByDay.set(period, (outboundByDay.get(period) ?? 0) + 1);
    }
  }
  return inboundPerDay.map((day) => ({
    period: day.period,
    inbound: Object.values(day.byTransport).reduce((sum, value) => sum + value, 0),
    outbound: outboundByDay.get(day.period) ?? 0,
    byTransport: Object.fromEntries(
      Object.entries(day.byTransport).map(([transportId, inbound]) => [
        transportId,
        { inbound, outbound: 0 },
      ]),
    ),
  }));
}

export function isBaselineTransport(transport: AdminDashboardTransportRow): boolean {
  const email = transport.email.trim().toLowerCase();
  if (transport.id === NAVA_TRANSPORT_ID) return false;
  if (email === NAVA_EMAIL) return false;
  if (email.startsWith('navaai@')) return false;
  return true;
}

function messageInstant(message: AdminDashboardMessageRow, preferSent: boolean): Date | null {
  if (preferSent) {
    return message.sentAt ?? message.receivedAt ?? message.createdAt ?? null;
  }
  return message.receivedAt ?? message.createdAt ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function dayKeyJohannesburg(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Every JHB day touched by the window, so empty days plot as 0 instead of vanishing. */
function windowDayKeys(windowStart: Date, windowEnd: Date): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (let cursor = windowStart.getTime(); cursor < windowEnd.getTime(); cursor += DAY_MS) {
    const key = dayKeyJohannesburg(new Date(cursor));
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  const endKey = dayKeyJohannesburg(new Date(windowEnd.getTime() - 1));
  if (!seen.has(endKey)) keys.push(endKey);
  return keys.sort((a, b) => a.localeCompare(b));
}

function inWindow(date: Date, windowStart: Date, windowEnd: Date): boolean {
  return date >= windowStart && date < windowEnd;
}

type ThreadLatency = {
  threadId: string;
  transportId: string;
  latencyMs: number | null;
};

function computeThreadLatencies(
  eligibleThreads: AdminDashboardThreadRow[],
  messages: AdminDashboardMessageRow[],
  windowStart: Date,
  windowEnd: Date,
): ThreadLatency[] {
  const messagesByThread = new Map<string, AdminDashboardMessageRow[]>();
  for (const message of messages) {
    const list = messagesByThread.get(message.threadId) ?? [];
    list.push(message);
    messagesByThread.set(message.threadId, list);
  }

  const results: ThreadLatency[] = [];
  for (const thread of eligibleThreads) {
    const threadMessages = messagesByThread.get(thread.id) ?? [];
    const inbounds = threadMessages
      .filter((m) => m.direction === 'inbound')
      .map((m) => ({ message: m, at: messageInstant(m, false) }))
      .filter(
        (entry): entry is { message: AdminDashboardMessageRow; at: Date } => entry.at !== null,
      )
      .filter((entry) => inWindow(entry.at, windowStart, windowEnd))
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    if (inbounds.length === 0) continue;

    const anchor = inbounds[0]!.at;
    const outbounds = threadMessages
      .filter((m) => m.direction === 'outbound')
      .map((m) => ({ message: m, at: messageInstant(m, true) }))
      .filter(
        (entry): entry is { message: AdminDashboardMessageRow; at: Date } => entry.at !== null,
      )
      .filter((entry) => entry.at.getTime() >= anchor.getTime())
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    const firstOutbound = outbounds[0]?.at ?? null;
    results.push({
      threadId: thread.id,
      transportId: thread.transportId,
      latencyMs: firstOutbound ? firstOutbound.getTime() - anchor.getTime() : null,
    });
  }
  return results;
}

function aggregateLegacyAdminDashboardMetrics(input: {
  threads: readonly AdminDashboardThreadRow[];
  messages: readonly AdminDashboardMessageRow[];
  transports: readonly AdminDashboardTransportRow[];
  windowStart: Date;
  windowEnd: Date;
}): AdminDashboardAggregateResult {
  const baselineTransports = input.transports.filter(isBaselineTransport);
  const baselineTransportIds = new Set(baselineTransports.map((t) => t.id));

  const eligibleThreads = input.threads.filter(
    (thread) =>
      baselineTransportIds.has(thread.transportId) &&
      thread.spamAt == null &&
      thread.trashedAt == null,
  );
  const eligibleThreadIds = new Set(eligibleThreads.map((t) => t.id));

  const eligibleMessages = input.messages.filter(
    (message) =>
      baselineTransportIds.has(message.transportId) && eligibleThreadIds.has(message.threadId),
  );

  const inboundInWindow = eligibleMessages.filter((message) => {
    if (message.direction !== 'inbound') return false;
    const at = messageInstant(message, false);
    return at != null && inWindow(at, input.windowStart, input.windowEnd);
  });

  const latencies = computeThreadLatencies(
    eligibleThreads,
    eligibleMessages,
    input.windowStart,
    input.windowEnd,
  );
  const answeredLatencies = latencies
    .map((row) => row.latencyMs)
    .filter((value): value is number => value != null);
  const unansweredEligible = latencies.filter((row) => row.latencyMs == null).length;
  const within3h = latencies.filter(
    (row) => row.latencyMs != null && row.latencyMs <= THREE_HOURS_MS,
  ).length;
  const answeredWithin3hPercent =
    latencies.length === 0 ? null : round1((within3h / latencies.length) * 100);

  const medianMinutes =
    answeredLatencies.length === 0 ? null : round1((median(answeredLatencies) ?? 0) / 60_000);
  const p90Minutes =
    answeredLatencies.length === 0
      ? null
      : round1((percentile(answeredLatencies, 90) ?? 0) / 60_000);

  const dayMap = new Map<string, Record<string, number>>();
  for (const period of windowDayKeys(input.windowStart, input.windowEnd)) {
    dayMap.set(
      period,
      Object.fromEntries(baselineTransports.map((transport) => [transport.id, 0])),
    );
  }
  for (const message of inboundInWindow) {
    const at = messageInstant(message, false);
    if (!at) continue;
    const period = dayKeyJohannesburg(at);
    const bucket = dayMap.get(period) ?? {};
    bucket[message.transportId] = (bucket[message.transportId] ?? 0) + 1;
    dayMap.set(period, bucket);
  }
  const inboundPerDay: AdminDashboardInboundDay[] = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, byTransport]) => ({ period, byTransport }));

  const perTransport: AdminDashboardTransportSeries[] = baselineTransports.map((transport) => {
    const transportLatencies = latencies.filter((row) => row.transportId === transport.id);
    return {
      transportId: transport.id,
      label: transport.displayName?.trim() || transport.email,
      inbound: inboundInWindow.filter((m) => m.transportId === transport.id).length,
      latenciesMinutes: transportLatencies
        .map((row) => row.latencyMs)
        .filter((value): value is number => value != null)
        .map((value) => value / 60_000),
      unanswered: transportLatencies.filter((row) => row.latencyMs == null).length,
    };
  });

  const comparison: AdminDashboardComparisonRow[] = perTransport.map((series) => {
    const eligible = series.latenciesMinutes.length + (series.unanswered ?? 0);
    const within = series.latenciesMinutes.filter(
      (minutes) => minutes * 60_000 <= THREE_HOURS_MS,
    ).length;
    return {
      transportId: series.transportId,
      label: series.label,
      inbound: series.inbound,
      answeredWithin3hPercent: eligible === 0 ? null : round1((within / eligible) * 100),
      drafted: null,
    };
  });

  const legacyQuery: ExecutiveDashboardQuery = {
    cohortId: 'centurion',
    window: '7d',
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    observationCutoff: input.windowEnd.toISOString(),
    sourceVintage: input.windowEnd.toISOString(),
  };
  const legacyTraffic = legacyMetric<number>(inboundInWindow.length, {
    unit: 'messages',
    denominator: null,
    timestampBasis: 'mixed',
    sourceVintage: legacyQuery.sourceVintage,
  });
  const legacyOutbound = input.messages.filter((message) => {
    if (message.direction !== 'outbound') return false;
    const at = messageInstant(message, true);
    return at != null && inWindow(at, input.windowStart, input.windowEnd);
  }).length;
  const legacyOutboundMetric = legacyMetric<number>(legacyOutbound, {
    unit: 'messages',
    denominator: null,
    timestampBasis: 'mixed',
    sourceVintage: legacyQuery.sourceVintage,
  });
  const legacyDaily = resultDailyFromLegacy(
    inboundPerDay,
    input.messages,
    input.windowStart,
    input.windowEnd,
  );
  const legacyUnavailable = unavailableMetric<never>('classification_snapshot_unavailable', {
    unit: 'conversations',
    sourceVintage: legacyQuery.sourceVintage,
  });
  const legacyConversations: AdminDashboardConversations = {
    awaitingHotel: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'requests',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    awaitingCustomer: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'requests',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    hotelActionPending: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'requests',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    answered: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'requests',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    noReplyRequired: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'requests',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    partial: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'requests',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    unknown: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'requests',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    unknownEvidence: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'requests',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    bucketTotals: unavailableMetric<Record<MailBaselinePrimaryBucket, number>>(
      'request_projection_unavailable',
      {
        unit: 'requests by primary bucket',
        sourceVintage: legacyQuery.sourceVintage,
      },
    ),
    ageBands: unavailableMetric<Record<string, number>>('request_projection_unavailable', {
      unit: 'request age bands',
      sourceVintage: legacyQuery.sourceVintage,
    }),
  };
  const legacyServiceCounts: AdminDashboardServiceCounts = {
    eligibleNewConversations: withCountDenominatorStatus(
      unavailableMetric<number>('measurement_config_unavailable', {
        unit: 'conversations',
        sourceVintage: legacyQuery.sourceVintage,
      }),
      'not_applicable',
    ),
    unansweredEligible: withCountDenominatorStatus(
      unavailableMetric<number>('measurement_config_unavailable', {
        unit: 'conversations',
        sourceVintage: legacyQuery.sourceVintage,
      }),
      'unknown',
    ),
    unscorable: withCountDenominatorStatus(
      unavailableMetric<number>('measurement_config_unavailable', {
        unit: 'conversations',
        sourceVintage: legacyQuery.sourceVintage,
      }),
      'unknown',
    ),
    measurementStartAt: null,
    measurementConfigVersion: null,
  };

  return {
    query: legacyQuery,
    traffic: {
      inbound: legacyTraffic,
      outbound: legacyOutboundMetric,
      daily: legacyMetric(legacyDaily, {
        unit: 'messages per day',
        denominator: legacyTraffic.value,
        timestampBasis: 'mixed',
        sourceVintage: legacyQuery.sourceVintage,
      }),
      comparableWindowChangePercent: unavailableMetric<number>('comparison_unavailable', {
        unit: 'percent',
        sourceVintage: legacyQuery.sourceVintage,
      }),
    },
    activity: {
      activeConversations: legacyUnavailable,
      newlyObservedConversations: legacyUnavailable,
      continuingConversations: legacyUnavailable,
      distinctExternalSenderAddresses: legacyUnavailable,
      weekdayArrivals: unavailableMetric<Record<string, number>>(
        'classification_snapshot_unavailable',
        {
          unit: 'arrivals by weekday',
          sourceVintage: legacyQuery.sourceVintage,
        },
      ),
      hourArrivals: unavailableMetric<Record<string, number>>(
        'classification_snapshot_unavailable',
        {
          unit: 'arrivals by hour',
          sourceVintage: legacyQuery.sourceVintage,
        },
      ),
    },
    conversations: legacyConversations,
    folders: {
      mix: legacyUnavailable,
      urgent: unavailableMetric<number>('classification_snapshot_unavailable', {
        unit: 'conversations',
        sourceVintage: legacyQuery.sourceVintage,
      }),
      exclusions: {
        spam: input.threads.filter((thread) => thread.spamAt != null).length,
        trash: input.threads.filter((thread) => thread.trashedAt != null).length,
      },
    },
    correspondents: {
      externalDomains: unavailableMetric<AdminDashboardDomainRow[]>(
        'classification_snapshot_unavailable',
        {
          unit: 'domains',
          sourceVintage: legacyQuery.sourceVintage,
        },
      ),
    },
    service: {
      firstObservedHumanReply: unavailableMetric<number>('measurement_start_unavailable', {
        unit: 'minutes',
        sourceVintage: legacyQuery.sourceVintage,
      }),
      firstUsefulReply: unavailableMetric<number>('no_useful_reply_evidence', {
        unit: 'minutes',
        sourceVintage: legacyQuery.sourceVintage,
      }),
      counts: legacyServiceCounts,
      eligibleNewConversationCount: 0,
      unansweredEligible: 0,
      unscorable: 0,
    },
    dataHealth: null,
    inboundVolume: live(inboundInWindow.length),
    medianFirstResponseMinutes: live(medianMinutes),
    p90FirstResponseMinutes: live(p90Minutes),
    answeredWithin3hPercent: live(answeredWithin3hPercent),
    draftCreationMinutes: unavailable(),
    aiAssistedSendRate: unavailable(),
    medianEditDistance: unavailable(),
    totalRevenue: comingSoon(),
    eligibleThreadCount: latencies.length,
    unansweredEligible,
    inboundPerDay,
    comparison,
    perTransport,
    transports: baselineTransports.map((t) => ({
      id: t.id,
      email: t.email,
      displayName: t.displayName,
    })),
    assumptions: [...ADMIN_DASHBOARD_ASSUMPTIONS],
    footnote: ADMIN_DASHBOARD_FOOTNOTE,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
  };
}

export type ExecutiveAggregateInput = {
  cohortId: DashboardCohortId;
  observationCutoff: Date;
  classificationSnapshot: AdminDashboardClassificationSnapshot | null;
  measurementConfig?: MailboxMeasurementConfig | null;
  threads: readonly AdminDashboardThreadRow[];
  messages: readonly AdminDashboardMessageRow[];
  transports: readonly AdminDashboardTransportRow[];
  windowStart: Date;
  windowEnd: Date;
  dataHealth?: import('./mail-data-health.js').MailDataHealth | null;
  previousMessages?: readonly AdminDashboardMessageRow[];
  /** Bounded pre-window projection for current-window thread continuity. */
  preWindowThreadIds?: readonly string[];
  /** Threads with retained pre-window rows whose source event clocks are unusable. */
  preWindowUnknownThreadIds?: readonly string[];
  preWindowEvidenceAvailable?: boolean;
  /** One immutable, reduced request projection per scoped thread. */
  requestBaselines?: readonly MailBaselineProjection[];
};

const EXECUTIVE_FOLDER_LABELS: Record<string, string> = {
  bookings: 'Bookings',
  'groups-events': 'Groups & Events',
  'manage-stay': 'Manage Existing Stay',
  'confirm-reconcile': 'Confirm & Reconcile',
  'money-billing': 'Money & Billing',
  'documents-delivery': 'Documents & Delivery',
  'exceptions-recovery': 'Exceptions & Recovery',
  'guest-experience': 'Guest Experience',
  'internal-partner': 'Internal & Partner Ops',
  'automated-channel': 'Automated / Channel',
  'unknown-review': 'Unknown / Needs Review',
};

const EXECUTIVE_FOLDER_ORDER = Object.keys(EXECUTIVE_FOLDER_LABELS);
const LEGACY_FOLDER_ALIASES: Record<string, string> = {
  'new-bookings': 'bookings',
  'at-risk': 'exceptions-recovery',
  ops: 'unknown-review',
};
const NON_OBSERVED_EXECUTIVE_SEND_STATES = new Set(['pending', 'sending', 'cancelled', 'failed']);

const EXECUTIVE_SEND_STATE_RANK: Record<
  NonNullable<AdminDashboardMessageRow['sendState']>,
  number
> = {
  pending: 1,
  sending: 2,
  failed: 3,
  cancelled: 3,
  accepted: 4,
  sent: 5,
};

function asValidMillis(value: Date | string | null | undefined): number | null {
  const millis =
    value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(millis) ? millis : null;
}

function isWithinProjectionCoverageGap(
  atMillis: number,
  coverage: MailBaselineProjection['coverage'],
): boolean {
  return (coverage.confirmedGapIntervals ?? []).some((gap) => {
    const start = asValidMillis(gap.startAt);
    const end = asValidMillis(gap.endAt);
    return start !== null && end !== null && start <= atMillis && atMillis < end;
  });
}

function projectionCoverageWindow(projection: MailBaselineProjection): {
  startMillis: number;
  endMillis: number;
} | null {
  if (!projection.coverage.complete) return null;
  const startMillis = asValidMillis(projection.coverage.startAt);
  const endMillis = asValidMillis(projection.coverage.endAt);
  if (startMillis === null || endMillis === null || endMillis <= startMillis) return null;
  return { startMillis, endMillis };
}

function asIso(value: Date | string | null | undefined): string | null {
  const millis = asValidMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
}

function mergedSendState(
  left: AdminDashboardMessageRow['sendState'],
  right: AdminDashboardMessageRow['sendState'],
): AdminDashboardMessageRow['sendState'] {
  if (!left) return right ?? null;
  if (!right) return left;
  return EXECUTIVE_SEND_STATE_RANK[left] >= EXECUTIVE_SEND_STATE_RANK[right] ? left : right;
}

function mergeExecutiveMessages(
  left: AdminDashboardMessageRow,
  right: AdminDashboardMessageRow,
): AdminDashboardMessageRow {
  const earliest = (a: Date | null | undefined, b: Date | null | undefined): Date | null => {
    const am = asValidMillis(a);
    const bm = asValidMillis(b);
    if (am === null) return bm === null ? null : new Date(bm);
    if (bm === null) return new Date(am);
    return new Date(Math.min(am, bm));
  };
  return {
    ...left,
    canonicalId: left.canonicalId ?? right.canonicalId ?? null,
    sourceMessageId: left.sourceMessageId ?? right.sourceMessageId ?? null,
    fromAddress: left.fromAddress ?? right.fromAddress ?? null,
    receivedAt: earliest(left.receivedAt, right.receivedAt),
    sentAt: earliest(left.sentAt, right.sentAt),
    createdAt: earliest(left.createdAt, right.createdAt) ?? left.createdAt,
    sourceEventAt: earliest(left.sourceEventAt, right.sourceEventAt),
    eventAt: earliest(left.eventAt, right.eventAt),
    headerDateAt: earliest(left.headerDateAt, right.headerDateAt),
    firstKnownAt: earliest(left.firstKnownAt, right.firstKnownAt),
    sendState: mergedSendState(left.sendState, right.sendState),
    authorClass: left.authorClass ?? right.authorClass,
    qualifiesNewConversation: left.qualifiesNewConversation ?? right.qualifiesNewConversation,
    hasScopedReplyLink: left.hasScopedReplyLink ?? right.hasScopedReplyLink,
    isAcknowledgement: left.isAcknowledgement ?? right.isAcknowledgement,
    hasMatchingOutbound: left.hasMatchingOutbound || right.hasMatchingOutbound,
  };
}

/** Normalize source/header identities without treating wrappers as distinct copies. */
function normalizeExecutiveIdentity(value: string): string {
  let normalized = value.trim().toLowerCase();
  for (let pass = 0; pass < 2; pass += 1) {
    const quoted =
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"));
    const bracketed = normalized.startsWith('<') && normalized.endsWith('>');
    if (!quoted && !bracketed) break;
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function executiveMessageIdentity(message: AdminDashboardMessageRow): string {
  const scope = normalizeExecutiveIdentity(message.transportId);
  const canonical = message.canonicalId ? normalizeExecutiveIdentity(message.canonicalId) : null;
  if (canonical) return `${scope}:canonical:${canonical}`;
  const source = message.sourceMessageId
    ? normalizeExecutiveIdentity(message.sourceMessageId)
    : null;
  if (source) return `${scope}:source:${source}`;
  return `${scope}:local:${message.id}`;
}

function dedupeExecutiveMessages(
  messages: readonly AdminDashboardMessageRow[],
): AdminDashboardMessageRow[] {
  const byIdentity = new Map<string, AdminDashboardMessageRow>();
  for (const message of messages) {
    const identity = executiveMessageIdentity(message);
    const existing = byIdentity.get(identity);
    byIdentity.set(identity, existing ? mergeExecutiveMessages(existing, message) : message);
  }
  return [...byIdentity.values()];
}

function executiveTransportMatches(
  transport: AdminDashboardTransportRow,
  cohortId: DashboardCohortId,
): boolean {
  const id = transport.id.trim().toLowerCase();
  const email = transport.email.trim().toLowerCase();
  const research =
    id === 'transport-nava' ||
    id.includes('pmbobo') ||
    id.includes('research') ||
    email.includes('pmbobo') ||
    email.includes('research');
  return cohortId === 'research' ? research : !research;
}

function executiveEvent(
  message: AdminDashboardMessageRow,
  observationCutoffMillis = Number.POSITIVE_INFINITY,
): { at: Date; basis: DashboardTimestampBasis } | null {
  const candidates: Array<{ value: Date | string; basis: DashboardTimestampBasis }> = [];
  if (message.sourceEventAt !== undefined && message.sourceEventAt !== null) {
    candidates.push({ value: message.sourceEventAt, basis: 'source_event' });
  }
  if (message.eventAt !== undefined && message.eventAt !== null) {
    candidates.push({ value: message.eventAt, basis: 'source_event' });
  }
  if (
    message.direction === 'inbound' &&
    message.receivedAt !== undefined &&
    message.receivedAt !== null
  ) {
    candidates.push({ value: message.receivedAt, basis: 'sender_timestamp_estimate' });
  }
  if (message.direction === 'outbound' && message.sentAt !== undefined && message.sentAt !== null) {
    candidates.push({ value: message.sentAt, basis: 'source_event' });
  }
  if (
    message.direction === 'outbound' &&
    (message.sentAt === undefined || message.sentAt === null) &&
    message.receivedAt !== undefined &&
    message.receivedAt !== null
  ) {
    candidates.push({ value: message.receivedAt, basis: 'sender_timestamp_estimate' });
  }
  if (
    candidates.length === 0 &&
    message.headerDateAt !== undefined &&
    message.headerDateAt !== null
  ) {
    candidates.push({ value: message.headerDateAt, basis: 'sender_timestamp_estimate' });
  }
  if (
    candidates.some(({ value }) => {
      const millis = asValidMillis(value);
      return millis === null || millis > observationCutoffMillis;
    })
  )
    return null;
  const candidate = candidates[0];
  if (!candidate) return null;
  const millis = asValidMillis(candidate.value);
  return millis === null ? null : { at: new Date(millis), basis: candidate.basis };
}

function executiveHasFutureClock(
  message: AdminDashboardMessageRow,
  observationCutoffMillis: number,
): boolean {
  const primaryValues = [
    message.sourceEventAt,
    message.eventAt,
    message.direction === 'inbound' ? message.receivedAt : message.sentAt,
    message.direction === 'outbound' && !message.sentAt ? message.receivedAt : null,
  ];
  const values = primaryValues.some((value) => value !== undefined && value !== null)
    ? primaryValues
    : [...primaryValues, message.headerDateAt];
  return values.some((value) => {
    const millis = asValidMillis(value);
    return millis !== null && millis > observationCutoffMillis;
  });
}

function executiveMessageIsObserved(message: AdminDashboardMessageRow): boolean {
  return (
    message.direction !== 'outbound' ||
    !NON_OBSERVED_EXECUTIVE_SEND_STATES.has(message.sendState ?? '')
  );
}

function executiveMetricOptions(
  input: ExecutiveAggregateInput,
  basis: DashboardTimestampBasis | null = null,
  config: MailboxMeasurementConfig | null | undefined = input.measurementConfig,
) {
  return {
    sourceVintage: input.observationCutoff.toISOString(),
    timestampBasis: basis,
    captureBasis: config?.captureAssumptionBasis ?? null,
    classificationAsOf: asIso(input.classificationSnapshot?.classificationAsOf),
    snapshotBasis: input.classificationSnapshot?.snapshotBasis ?? null,
    measurementConfigVersion: config ? String(config.version) : null,
  };
}

type ConversationMetricBase = {
  sourceVintage: string;
  timestampBasis: DashboardTimestampBasis | null;
  captureBasis: string | null;
  classificationAsOf: string | null;
  snapshotBasis: string | null;
  measurementConfigVersion: string | null;
};

function unavailableRequestConversations(
  base: ConversationMetricBase,
  reason = 'request_projection_unavailable',
): AdminDashboardConversations {
  return {
    awaitingHotel: unavailableMetric<number>(reason, { ...base, unit: 'requests' }),
    awaitingCustomer: unavailableMetric<number>(reason, { ...base, unit: 'requests' }),
    hotelActionPending: unavailableMetric<number>(reason, { ...base, unit: 'requests' }),
    answered: unavailableMetric<number>(reason, { ...base, unit: 'requests' }),
    noReplyRequired: unavailableMetric<number>(reason, { ...base, unit: 'requests' }),
    partial: unavailableMetric<number>(reason, { ...base, unit: 'requests' }),
    unknown: unavailableMetric<number>(reason, { ...base, unit: 'requests' }),
    unknownEvidence: unavailableMetric<number>(reason, { ...base, unit: 'requests' }),
    bucketTotals: unavailableMetric<Record<MailBaselinePrimaryBucket, number>>(reason, {
      ...base,
      unit: 'requests by primary bucket',
    }),
    ageBands: unavailableMetric<Record<string, number>>(reason, {
      ...base,
      unit: 'request age bands',
    }),
  };
}

/** Aggregate only immutable request projections; never infer state from folders. */
function aggregateRequestConversations(
  projections: readonly MailBaselineProjection[],
  base: ConversationMetricBase,
  cutoff: Date,
): AdminDashboardConversations {
  if (projections.length === 0) return unavailableRequestConversations(base);

  const bucketTotals = Object.fromEntries(PRIMARY_BUCKETS.map((bucket) => [bucket, 0])) as Record<
    MailBaselinePrimaryBucket,
    number
  >;
  let partial = 0;
  let unknownEvidence = 0;
  const exclusions: Record<string, number> = {};
  const ageBands: Record<string, number> = {
    under_1h: 0,
    one_to_four_hours: 0,
    four_to_twenty_four_hours: 0,
    one_to_three_days: 0,
    over_three_days: 0,
  };
  const sourceVintages = new Set<string>();
  const increment = (key: string, amount = 1) => {
    exclusions[key] = (exclusions[key] ?? 0) + amount;
  };

  for (const projection of projections) {
    bucketTotals[projection.primaryBucket] += 1;
    if (projection.overlays.includes('partially_answered')) partial += 1;
    if (projection.overlays.includes('unknown_evidence')) unknownEvidence += 1;
    sourceVintages.add(projection.sourceVintage);
    for (const [key, value] of Object.entries(projection.exclusions)) increment(key, value);
    const eligible = projection.denominators.eligible;
    if (eligible !== null) increment('eligible_requests', eligible);
    if (projection.denominators.scorable !== null)
      increment('scorable_requests', projection.denominators.scorable);
    if (projection.denominators.unscorable !== null)
      increment('unscorable_requests', projection.denominators.unscorable);

    const ageStart = projection.waitStartedAt ?? projection.firstAskAt;
    const ageMillis = ageStart ? cutoff.getTime() - Date.parse(ageStart) : NaN;
    if (!Number.isFinite(ageMillis) || ageMillis < 0) {
      increment('invalid_age_clock');
      continue;
    }
    if (ageMillis < 60 * 60 * 1000) ageBands.under_1h += 1;
    else if (ageMillis < 4 * 60 * 60 * 1000) ageBands.one_to_four_hours += 1;
    else if (ageMillis < 24 * 60 * 60 * 1000) ageBands.four_to_twenty_four_hours += 1;
    else if (ageMillis < 3 * 24 * 60 * 60 * 1000) ageBands.one_to_three_days += 1;
    else ageBands.over_three_days += 1;
  }

  const sourceVintage = [...sourceVintages].sort().at(-1) ?? base.sourceVintage;
  const coverageConfigVersions = [
    ...new Set(
      projections
        .map((projection) => projection.coverage.configVersion)
        .filter((version): version is string => typeof version === 'string' && version.length > 0),
    ),
  ].sort();
  const shared = {
    ...base,
    sourceVintage,
    denominator: projections.length,
    exclusions,
    timestampBasis: base.timestampBasis ?? 'mixed',
    captureBasis:
      projections
        .map((projection) => projection.coverage.basis)
        .filter(Boolean)
        .filter((basis, index, values) => values.indexOf(basis) === index)
        .join(', ') || base.captureBasis,
    measurementConfigVersion: coverageConfigVersions.join(', ') || base.measurementConfigVersion,
  };
  const count = (value: number): MetricResult<number> =>
    legacyMetric(value, { ...shared, unit: 'requests' });
  return {
    awaitingHotel: count(bucketTotals.awaiting_hotel_reply),
    awaitingCustomer: count(bucketTotals.awaiting_customer_information),
    hotelActionPending: count(bucketTotals.hotel_action_pending),
    answered: count(bucketTotals.answered),
    noReplyRequired: count(bucketTotals.no_reply_required),
    partial: count(partial),
    unknown: count(bucketTotals.unknown),
    unknownEvidence: count(unknownEvidence),
    bucketTotals: legacyMetric(bucketTotals, { ...shared, unit: 'requests by primary bucket' }),
    ageBands: legacyMetric(ageBands, { ...shared, unit: 'request age bands' }),
  };
}

function strictLegacyCell<T>(metric: MetricResult<T>): MetricCell {
  return metric.availability === 'available'
    ? { availability: 'live', value: metric.value as number | null }
    : { availability: 'unavailable', value: null };
}

function normalizeExecutiveFolder(snapshot: AdminDashboardClassificationThread): {
  folder: string;
  classification: AdminDashboardFolderRow['classification'];
} {
  const folders = [
    ...new Set(
      (snapshot.folderSlugs ?? []).map((folder) => folder.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  const raw =
    snapshot.primaryFolder?.trim().toLowerCase() ?? (folders.length === 1 ? folders[0] : null);
  if (!raw) return { folder: 'unknown-review', classification: 'unclassified' };
  if (folders.length > 1) return { folder: 'unknown-review', classification: 'ambiguous' };
  if (EXECUTIVE_FOLDER_LABELS[raw]) return { folder: raw, classification: 'primary' };
  if (LEGACY_FOLDER_ALIASES[raw]) {
    return { folder: LEGACY_FOLDER_ALIASES[raw]!, classification: 'legacy' };
  }
  return { folder: 'unknown-review', classification: 'unclassified' };
}

function executiveDayRows(
  rows: readonly {
    message: AdminDashboardMessageRow;
    event: { at: Date; basis: DashboardTimestampBasis };
  }[],
  transports: readonly AdminDashboardTransportRow[],
  windowStart: Date,
  windowEnd: Date,
): AdminDashboardDailyPoint[] {
  const days = new Map<string, AdminDashboardDailyPoint>();
  for (const period of windowDayKeys(windowStart, windowEnd)) {
    days.set(period, {
      period,
      inbound: 0,
      outbound: 0,
      byTransport: Object.fromEntries(
        transports.map((transport) => [transport.id, { inbound: 0, outbound: 0 }]),
      ),
    });
  }
  for (const row of rows) {
    const period = dayKeyJohannesburg(row.event.at);
    const day = days.get(period);
    if (!day) continue;
    if (row.message.direction === 'inbound') day.inbound += 1;
    else day.outbound += 1;
    const transport = day.byTransport[row.message.transportId] ?? { inbound: 0, outbound: 0 };
    transport[row.message.direction] += 1;
    day.byTransport[row.message.transportId] = transport;
  }
  return [...days.values()].sort((left, right) => left.period.localeCompare(right.period));
}

function buildExecutiveDataHealth(
  input: ExecutiveAggregateInput,
  messages: readonly AdminDashboardMessageRow[],
): import('./mail-data-health.js').MailDataHealth {
  const rows: MailDataHealthMessage[] = messages.map((message) => ({
    id: message.id,
    canonicalId: message.canonicalId,
    sourceMessageId: message.sourceMessageId,
    direction: message.direction,
    threadId: message.threadId,
    sourceEventAt: asIso(message.sourceEventAt),
    eventAt: asIso(message.eventAt),
    headerDateAt: asIso(message.headerDateAt),
    receivedAt: asIso(message.receivedAt),
    sentAt: asIso(message.sentAt),
    firstKnownAt: asIso(message.firstKnownAt),
    createdAt: asIso(message.createdAt),
    sendState: message.sendState,
    hasMatchingOutbound: message.hasMatchingOutbound,
  }));
  return buildMailDataHealth({
    observationCutoff: input.observationCutoff.toISOString(),
    scopeKey: input.cohortId,
    messages: rows,
    quoteProjection: 'unavailable',
  });
}

function aggregateExecutiveDashboardMetrics(
  input: ExecutiveAggregateInput,
): AdminDashboardAggregateResult {
  const sourceVintage = input.observationCutoff.toISOString();
  const transports = input.transports.filter((transport) =>
    executiveTransportMatches(transport, input.cohortId),
  );
  const transportIds = new Set(transports.map((transport) => transport.id));
  const cutoffMillis = input.observationCutoff.getTime();
  const cohortInputCount = input.messages.filter((message) =>
    transportIds.has(message.transportId),
  ).length;
  const dedupedCohort = dedupeExecutiveMessages(input.messages).filter((message) =>
    transportIds.has(message.transportId),
  );
  const nonObservedSendState = dedupedCohort.filter(
    (message) => !executiveMessageIsObserved(message),
  ).length;
  const deduped = dedupedCohort.filter(executiveMessageIsObserved);
  const duplicateSourceCopies = Math.max(0, cohortInputCount - dedupedCohort.length);
  const unscorableClockCount = deduped.filter(
    (message) => executiveEvent(message, cutoffMillis) === null,
  ).length;
  const futureOrCutoffCount = deduped.filter((message) =>
    executiveHasFutureClock(message, cutoffMillis),
  ).length;
  const clockExclusions = {
    duplicate_source_copies: duplicateSourceCopies,
    non_observed_send_state: nonObservedSendState,
    future_or_cutoff: futureOrCutoffCount,
    unscorable_event_clock: Math.max(0, unscorableClockCount - futureOrCutoffCount),
  };
  const rows = deduped
    .map((message) => {
      const event = executiveEvent(message, cutoffMillis);
      return event ? { message, event } : null;
    })
    .filter(
      (
        row,
      ): row is {
        message: AdminDashboardMessageRow;
        event: { at: Date; basis: DashboardTimestampBasis };
      } => row !== null,
    );
  const inWindow = rows.filter(
    (row) =>
      row.event.at.getTime() >= input.windowStart.getTime() &&
      row.event.at.getTime() < input.windowEnd.getTime() &&
      row.event.at.getTime() <= cutoffMillis,
  );
  const inboundRows = inWindow.filter((row) => row.message.direction === 'inbound');
  const outboundRows = inWindow.filter((row) => row.message.direction === 'outbound');
  const allBasis = new Set(inWindow.map((row) => row.event.basis));
  const basis: DashboardTimestampBasis | null =
    allBasis.size === 0 ? null : allBasis.size === 1 ? [...allBasis][0]! : 'mixed';

  const touchedThreadIds = new Set(inWindow.map((row) => row.message.threadId));
  const snapshotAsOf = asValidMillis(input.classificationSnapshot?.classificationAsOf);
  const classificationMatches =
    input.classificationSnapshot !== null && snapshotAsOf !== null && snapshotAsOf === cutoffMillis;
  const snapshotByThread = new Map(
    (input.classificationSnapshot?.threads ?? []).map((thread) => [thread.threadId, thread]),
  );
  const classificationRows = [...touchedThreadIds]
    .map((threadId) => snapshotByThread.get(threadId))
    .filter((row): row is AdminDashboardClassificationThread => row !== undefined);
  const businessThreadIds = classificationMatches
    ? new Set(
        classificationRows.filter((row) => !row.spam && !row.trashed).map((row) => row.threadId),
      )
    : new Set<string>();
  const businessRows = inWindow.filter((row) => businessThreadIds.has(row.message.threadId));
  const exclusionCounts = {
    spam: classificationRows.filter((row) => row.spam).length,
    trash: classificationRows.filter((row) => row.trashed).length,
  };
  const configuredMeasurement = input.measurementConfig;
  const measurementConfig =
    configuredMeasurement &&
    configuredMeasurement.cohortId === input.cohortId &&
    transports.some((transport) => transport.id === configuredMeasurement.transportId)
      ? configuredMeasurement
      : null;
  const metricBase = executiveMetricOptions(input, basis, measurementConfig);
  const trafficMetricBase = {
    ...metricBase,
    captureBasis: 'raw_observed_transport_messages',
  };
  const daily = executiveDayRows(inWindow, transports, input.windowStart, input.windowEnd);

  const inboundMetric = legacyMetric(inboundRows.length, {
    ...trafficMetricBase,
    unit: 'messages',
    denominator: inboundRows.length,
    exclusions: clockExclusions,
  });
  const outboundMetric = legacyMetric(outboundRows.length, {
    ...trafficMetricBase,
    unit: 'messages',
    denominator: outboundRows.length,
    exclusions: clockExclusions,
  });
  const dailyMetric = legacyMetric(daily, {
    ...trafficMetricBase,
    unit: 'messages per day',
    denominator: inWindow.length,
    exclusions: clockExclusions,
  });

  let comparisonMetric: MetricResult<number>;
  if (input.previousMessages) {
    const previousWindowStart = new Date(
      input.windowStart.getTime() - (input.windowEnd.getTime() - input.windowStart.getTime()),
    );
    const previous = dedupeExecutiveMessages(input.previousMessages)
      .filter(
        (message) => transportIds.has(message.transportId) && executiveMessageIsObserved(message),
      )
      .map((message) => ({ message, event: executiveEvent(message, input.windowStart.getTime()) }))
      .filter(
        (
          row,
        ): row is {
          message: AdminDashboardMessageRow;
          event: { at: Date; basis: DashboardTimestampBasis };
        } => row.event !== null,
      )
      .filter((row) => row.message.direction === 'inbound');
    const previousCount = previous.filter(
      (row) => row.event.at >= previousWindowStart && row.event.at < input.windowStart,
    ).length;
    const value =
      previousCount === 0
        ? inboundRows.length === 0
          ? 0
          : null
        : ((inboundRows.length - previousCount) / previousCount) * 100;
    comparisonMetric =
      value === null
        ? unavailableMetric<number>('previous_window_zero', {
            ...trafficMetricBase,
            unit: 'percent',
            denominator: previousCount,
          })
        : legacyMetric(Math.round(value * 10) / 10, {
            ...trafficMetricBase,
            unit: 'percent',
            denominator: previousCount,
          });
  } else {
    comparisonMetric = unavailableMetric<number>('previous_window_unavailable', {
      ...trafficMetricBase,
      unit: 'percent',
    });
  }

  const snapshotUnavailable = unavailableMetric<never>('classification_snapshot_unavailable', {
    ...metricBase,
    unit: 'conversations',
    exclusions: exclusionCounts,
  });
  const activityThreadIds = new Set(businessRows.map((row) => row.message.threadId));
  const preWindowThreadIds = new Set(input.preWindowThreadIds ?? []);
  const preWindowUnknownThreadIds = new Set(input.preWindowUnknownThreadIds ?? []);
  const preWindowEvidenceAvailable = input.preWindowEvidenceAvailable === true;
  const unknownHistoryThreadIds = new Set(
    [...activityThreadIds].filter(
      (threadId) => preWindowUnknownThreadIds.has(threadId) && !preWindowThreadIds.has(threadId),
    ),
  );
  const historyUnavailableReason = !preWindowEvidenceAvailable
    ? 'pre_window_history_unavailable'
    : unknownHistoryThreadIds.size > 0
      ? 'pre_window_history_unknown'
      : null;
  const historyKnown = historyUnavailableReason === null;
  const newlyObserved = historyKnown
    ? [...activityThreadIds].filter((threadId) => !preWindowThreadIds.has(threadId)).length
    : null;
  const continuingObserved = historyKnown
    ? [...activityThreadIds].filter((threadId) => preWindowThreadIds.has(threadId)).length
    : null;
  const distinctExternalAddresses = new Set(
    businessRows
      .filter((row) => row.message.direction === 'inbound')
      .map((row) => row.message.fromAddress?.trim().toLowerCase())
      .filter(
        (address): address is string =>
          typeof address === 'string' && !address.endsWith('@legacyhotels.co.za'),
      ),
  ).size;
  const weekdayArrivals: Record<string, number> = {};
  const hourArrivals: Record<string, number> = {};
  for (const row of businessRows.filter((candidate) => candidate.message.direction === 'inbound')) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Johannesburg',
      weekday: 'long',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(row.event.at);
    const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Unknown';
    const hour = parts.find((part) => part.type === 'hour')?.value ?? 'unknown';
    weekdayArrivals[weekday] = (weekdayArrivals[weekday] ?? 0) + 1;
    hourArrivals[hour] = (hourArrivals[hour] ?? 0) + 1;
  }

  const activity: AdminDashboardActivity = classificationMatches
    ? {
        activeConversations: legacyMetric(activityThreadIds.size, {
          ...metricBase,
          unit: 'conversations',
          denominator: activityThreadIds.size,
          exclusions: exclusionCounts,
        }),
        newlyObservedConversations: historyKnown
          ? legacyMetric(newlyObserved, {
              ...metricBase,
              unit: 'conversations',
              denominator: activityThreadIds.size,
              exclusions: exclusionCounts,
            })
          : unavailableMetric<number>(historyUnavailableReason!, {
              ...metricBase,
              unit: 'conversations',
              denominator: null,
              exclusions: exclusionCounts,
            }),
        continuingConversations: historyKnown
          ? legacyMetric(continuingObserved, {
              ...metricBase,
              unit: 'conversations',
              denominator: activityThreadIds.size,
              exclusions: exclusionCounts,
            })
          : unavailableMetric<number>(historyUnavailableReason!, {
              ...metricBase,
              unit: 'conversations',
              denominator: null,
              exclusions: exclusionCounts,
            }),
        distinctExternalSenderAddresses: legacyMetric(distinctExternalAddresses, {
          ...metricBase,
          unit: 'email addresses',
          denominator: distinctExternalAddresses,
          exclusions: exclusionCounts,
        }),
        weekdayArrivals: legacyMetric(weekdayArrivals, {
          ...metricBase,
          unit: 'arrivals by weekday',
          denominator: businessRows.filter((row) => row.message.direction === 'inbound').length,
          exclusions: exclusionCounts,
        }),
        hourArrivals: legacyMetric(hourArrivals, {
          ...metricBase,
          unit: 'arrivals by hour',
          denominator: businessRows.filter((row) => row.message.direction === 'inbound').length,
          exclusions: exclusionCounts,
        }),
      }
    : {
        activeConversations: snapshotUnavailable,
        newlyObservedConversations: snapshotUnavailable,
        continuingConversations: snapshotUnavailable,
        distinctExternalSenderAddresses: unavailableMetric<number>(
          'classification_snapshot_unavailable',
          {
            ...metricBase,
            unit: 'email addresses',
            exclusions: { classification: 1 },
          },
        ),
        weekdayArrivals: unavailableMetric<Record<string, number>>(
          'classification_snapshot_unavailable',
          {
            ...metricBase,
            unit: 'arrivals by weekday',
            exclusions: { classification: 1 },
          },
        ),
        hourArrivals: unavailableMetric<Record<string, number>>(
          'classification_snapshot_unavailable',
          {
            ...metricBase,
            unit: 'arrivals by hour',
            exclusions: { classification: 1 },
          },
        ),
      };

  const folderRows = new Map<string, AdminDashboardFolderRow>();
  for (const folder of EXECUTIVE_FOLDER_ORDER) {
    folderRows.set(folder, {
      folder,
      label: EXECUTIVE_FOLDER_LABELS[folder]!,
      count: 0,
      urgentCount: 0,
      classification: 'primary',
    });
  }
  if (classificationMatches) {
    for (const row of classificationRows) {
      if (row.spam || row.trashed) continue;
      const normalized = normalizeExecutiveFolder(row);
      const folder = folderRows.get(normalized.folder)!;
      folder.count += 1;
      folder.urgentCount += row.urgent ? 1 : 0;
      if (normalized.classification !== 'primary')
        folder.classification = normalized.classification;
    }
  }
  const folderMix = classificationMatches
    ? legacyMetric([...folderRows.values()], {
        ...metricBase,
        unit: 'conversations by folder',
        denominator: businessThreadIds.size,
        exclusions: exclusionCounts,
      })
    : snapshotUnavailable;
  const urgentMetric = classificationMatches
    ? legacyMetric(
        classificationRows.filter((row) => !row.spam && !row.trashed && row.urgent).length,
        {
          ...metricBase,
          unit: 'urgent conversations',
          denominator: businessThreadIds.size,
          exclusions: exclusionCounts,
        },
      )
    : snapshotUnavailable;

  const domainCounts = new Map<string, { count: number; addresses: Set<string> }>();
  for (const row of businessRows.filter((candidate) => candidate.message.direction === 'inbound')) {
    const address = row.message.fromAddress?.trim().toLowerCase();
    if (!address || address.endsWith('@legacyhotels.co.za')) continue;
    const rawDomain = address.split('@')[1] ?? 'unknown';
    const domain = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'].includes(
      rawDomain,
    )
      ? 'public-email'
      : rawDomain;
    const bucket = domainCounts.get(domain) ?? { count: 0, addresses: new Set<string>() };
    bucket.count += 1;
    bucket.addresses.add(address);
    domainCounts.set(domain, bucket);
  }
  const domainMetric = classificationMatches
    ? legacyMetric(
        [...domainCounts.entries()]
          .map(([domain, value]) => ({
            domain,
            count: value.count,
            addresses: value.addresses.size,
          }))
          .sort(
            (left, right) => right.count - left.count || left.domain.localeCompare(right.domain),
          ),
        {
          ...metricBase,
          unit: 'external domains',
          denominator: businessRows.filter((row) => row.message.direction === 'inbound').length,
          exclusions: exclusionCounts,
        },
      )
    : unavailableMetric<AdminDashboardDomainRow[]>('classification_snapshot_unavailable', {
        ...metricBase,
        unit: 'external domains',
      });

  const measurementStartMillis = asValidMillis(measurementConfig?.measurementStartAt);
  const serviceGroups = new Map<
    string,
    {
      inbound: { at: Date; message: AdminDashboardMessageRow }[];
      outbound: { at: Date; message: AdminDashboardMessageRow }[];
    }
  >();
  for (const row of rows) {
    if (measurementConfig && row.message.transportId !== measurementConfig.transportId) continue;
    const group = serviceGroups.get(row.message.threadId) ?? { inbound: [], outbound: [] };
    if (row.message.direction === 'inbound')
      group.inbound.push({ at: row.event.at, message: row.message });
    else group.outbound.push({ at: row.event.at, message: row.message });
    serviceGroups.set(row.message.threadId, group);
  }
  // First-reply attribution is deliberately strict.  A route projection that
  // carries only clocks and direction cannot establish human authorship,
  // eligibility, or the scoped outbound link, so it must not manufacture a
  // number (including an apparently harmless null on an available metric).
  const serviceEvidenceRows = rows.filter(
    (row) => !measurementConfig || row.message.transportId === measurementConfig.transportId,
  );
  const replyEvidenceAvailable =
    measurementConfig !== null &&
    serviceEvidenceRows.length > 0 &&
    serviceEvidenceRows.every(({ message }) =>
      message.direction === 'inbound'
        ? message.authorClass !== undefined && message.qualifiesNewConversation !== undefined
        : message.authorClass !== undefined && message.hasScopedReplyLink !== undefined,
    );
  const serviceDurations: number[] = [];
  const serviceDurationsByTransport = new Map<string, number[]>();
  const serviceUnansweredByTransport = new Map<string, number>();
  let serviceEligible = 0;
  let serviceUnanswered = 0;
  let serviceUnscorable = 0;
  const unknownAuthorUnscorableCount = rows.filter(
    (row) => row.message.qualifiesNewConversation === true && row.message.authorClass === 'unknown',
  ).length;
  if (replyEvidenceAvailable && measurementStartMillis !== null && measurementConfig !== null) {
    for (const group of serviceGroups.values()) {
      const inbound = group.inbound
        .filter(
          ({ at, message }) =>
            at.getTime() >= measurementStartMillis &&
            at.getTime() >= input.windowStart.getTime() &&
            at.getTime() < input.windowEnd.getTime() &&
            at.getTime() < cutoffMillis &&
            message.qualifiesNewConversation === true &&
            message.authorClass === 'external_human',
        )
        .sort((left, right) => left.at.getTime() - right.at.getTime())[0];
      if (!inbound) continue;
      serviceEligible += 1;
      const inboundInGap = isWithinConfirmedGap(inbound.at.toISOString(), measurementConfig);
      if (inboundInGap) {
        serviceUnscorable += 1;
        continue;
      }
      const outbound = group.outbound
        .filter(
          ({ at, message }) =>
            at.getTime() >= inbound.at.getTime() &&
            at.getTime() < cutoffMillis &&
            message.authorClass === 'internal_human' &&
            message.hasScopedReplyLink === true,
        )
        .sort((left, right) => left.at.getTime() - right.at.getTime())[0];
      if (!outbound) {
        const unknownOutbound = group.outbound.some(
          ({ at, message }) =>
            at.getTime() >= inbound.at.getTime() &&
            at.getTime() < cutoffMillis &&
            message.authorClass === 'unknown',
        );
        if (unknownOutbound) {
          serviceUnscorable += 1;
          continue;
        }
        const gapAfterInbound = measurementConfig?.confirmedGapIntervals.some((gap) => {
          const gapStart = asValidMillis(gap.startAt);
          return gapStart !== null && gapStart >= inbound.at.getTime() && gapStart < cutoffMillis;
        });
        if (gapAfterInbound) {
          serviceUnscorable += 1;
          continue;
        }
        serviceUnanswered += 1;
        const transportId = inbound.message.transportId;
        serviceUnansweredByTransport.set(
          transportId,
          (serviceUnansweredByTransport.get(transportId) ?? 0) + 1,
        );
        continue;
      }
      if (
        isWithinConfirmedGap(inbound.at.toISOString(), measurementConfig) ||
        isWithinConfirmedGap(outbound.at.toISOString(), measurementConfig) ||
        measurementConfig?.confirmedGapIntervals.some((gap) => {
          const gapStart = asValidMillis(gap.startAt);
          const gapEnd = asValidMillis(gap.endAt);
          return (
            gapStart !== null &&
            gapEnd !== null &&
            inbound.at.getTime() < gapEnd &&
            outbound.at.getTime() > gapStart
          );
        })
      ) {
        serviceUnscorable += 1;
        continue;
      }
      const duration = outbound.at.getTime() - inbound.at.getTime();
      serviceDurations.push(duration);
      const transportId = inbound.message.transportId;
      const transportDurations = serviceDurationsByTransport.get(transportId) ?? [];
      transportDurations.push(duration);
      serviceDurationsByTransport.set(transportId, transportDurations);
    }
    serviceUnscorable += unknownAuthorUnscorableCount;
  }
  const serviceCountsKnown = replyEvidenceAvailable && measurementStartMillis !== null;
  const serviceEligibleOutput = serviceCountsKnown ? serviceEligible : null;
  const serviceUnansweredOutput = serviceCountsKnown ? serviceUnanswered : null;
  const serviceUnscorableOutput = serviceCountsKnown ? serviceUnscorable : null;
  const serviceCaptureBasis = measurementConfig?.measurementStartAt
    ? `measurement_start_at:${measurementConfig.measurementStartAt}; ${measurementConfig.captureAssumptionBasis}`
    : metricBase.captureBasis;
  const serviceMetricOptions = {
    ...metricBase,
    unit: 'calendar minutes',
    denominator: serviceEligibleOutput,
    captureBasis: serviceCaptureBasis,
    exclusions: serviceCountsKnown
      ? { unanswered: serviceUnanswered, unscorable: serviceUnscorable }
      : ({} as Record<string, number>),
  };
  const serviceUnavailableReason = !configuredMeasurement
    ? 'measurement_config_unavailable'
    : !measurementConfig
      ? 'measurement_config_scope_mismatch'
      : measurementStartMillis === null
        ? 'measurement_start_unavailable'
        : !replyEvidenceAvailable
          ? 'reply_evidence_unavailable'
          : serviceEligible === 0
            ? 'no_eligible_new_conversations'
            : 'no_answered_conversations';
  const serviceCountMetricOptions = {
    ...metricBase,
    unit: 'conversations',
    denominator: null,
    captureBasis: serviceCaptureBasis,
  };
  const serviceUnscorableDenominatorStatus: AdminDashboardCountDenominatorStatus =
    !serviceCountsKnown || unknownAuthorUnscorableCount > 0 ? 'unknown' : 'known';
  const serviceDependentCountMetricOptions = {
    ...serviceCountMetricOptions,
    denominator: serviceCountsKnown ? serviceEligibleOutput : null,
  };
  const serviceUnscorableCountMetricOptions = {
    ...serviceCountMetricOptions,
    denominator: serviceUnscorableDenominatorStatus === 'known' ? serviceEligibleOutput : null,
  };
  const serviceCounts: AdminDashboardServiceCounts = {
    eligibleNewConversations: withCountDenominatorStatus(
      serviceCountsKnown && serviceEligibleOutput !== null
        ? legacyMetric(serviceEligibleOutput, serviceCountMetricOptions)
        : unavailableMetric<number>(serviceUnavailableReason, serviceCountMetricOptions),
      'not_applicable',
    ),
    unansweredEligible: withCountDenominatorStatus(
      serviceCountsKnown && serviceUnansweredOutput !== null
        ? legacyMetric(serviceUnansweredOutput, serviceDependentCountMetricOptions)
        : unavailableMetric<number>(serviceUnavailableReason, serviceDependentCountMetricOptions),
      serviceCountsKnown ? 'known' : 'unknown',
    ),
    unscorable: withCountDenominatorStatus(
      serviceCountsKnown && serviceUnscorableOutput !== null
        ? legacyMetric(serviceUnscorableOutput, serviceUnscorableCountMetricOptions)
        : unavailableMetric<number>(serviceUnavailableReason, serviceUnscorableCountMetricOptions),
      serviceUnscorableDenominatorStatus,
    ),
    measurementStartAt: measurementConfig?.measurementStartAt ?? null,
    measurementConfigVersion: measurementConfig ? String(measurementConfig.version) : null,
  };
  const serviceMetric =
    serviceCountsKnown && serviceDurations.length > 0
      ? legacyMetric(round1((median(serviceDurations) ?? 0) / 60_000), serviceMetricOptions)
      : unavailableMetric<number>(serviceUnavailableReason, serviceMetricOptions);
  const p90Metric =
    serviceMetric.availability === 'available'
      ? legacyMetric(round1((percentile(serviceDurations, 90) ?? 0) / 60_000), serviceMetricOptions)
      : unavailableMetric<number>(
          serviceMetric.availabilityReason ?? 'reply_evidence_unavailable',
          serviceMetricOptions,
        );
  const conversations = aggregateRequestConversations(
    input.requestBaselines ?? [],
    metricBase,
    input.observationCutoff,
  );
  const usefulReplyDurations: number[] = [];
  const usefulReplyExclusions: Record<string, number> = {};
  const incrementUsefulExclusion = (key: string, amount = 1) => {
    usefulReplyExclusions[key] = (usefulReplyExclusions[key] ?? 0) + amount;
  };
  const projectionConfigVersions = [
    ...new Set(
      (input.requestBaselines ?? [])
        .map((projection) => projection.coverage.configVersion)
        .filter((version): version is string => typeof version === 'string' && version.length > 0),
    ),
  ].sort();
  const projectionCoverageBases = [
    ...new Set(
      (input.requestBaselines ?? []).map((projection) => projection.coverage.basis).filter(Boolean),
    ),
  ].sort();
  const usefulReplyMetricBase = {
    ...metricBase,
    // First-useful metrics are owned by the selected producer snapshot. A
    // later GET config may describe current feed metrics, but cannot restate
    // this historical projection's T0, gaps, or provenance.
    measurementConfigVersion: projectionConfigVersions.join(', ') || null,
    captureBasis: projectionCoverageBases.join(', ') || 'producer_coverage_unavailable',
  };
  const requestBaselines = input.requestBaselines ?? [];
  const coverageWindows = requestBaselines.map((projection) =>
    projectionCoverageWindow(projection),
  );
  const allProjectionCoverageComplete =
    requestBaselines.length > 0 && coverageWindows.every((window) => window !== null);
  if (allProjectionCoverageComplete) {
    for (const [index, projection] of requestBaselines.entries()) {
      const coverageWindow = coverageWindows[index]!;
      for (const ask of projection.asks) {
        const startedAt = asValidMillis(ask.startedAt);
        const usefulAt = asValidMillis(ask.usefulReplyAt);
        if (startedAt === null || usefulAt === null) {
          incrementUsefulExclusion('missing_useful_reply_clock');
          continue;
        }
        if (
          startedAt < coverageWindow.startMillis ||
          startedAt >= coverageWindow.endMillis ||
          usefulAt >= coverageWindow.endMillis ||
          usefulAt > cutoffMillis
        ) {
          incrementUsefulExclusion('outside_measurement_window');
          continue;
        }
        if (
          isWithinProjectionCoverageGap(startedAt, projection.coverage) ||
          isWithinProjectionCoverageGap(usefulAt, projection.coverage)
        ) {
          incrementUsefulExclusion('coverage_gap');
          continue;
        }
        const duration = usefulAt - startedAt;
        if (duration < 0) {
          incrementUsefulExclusion('invalid_useful_reply_clock');
          continue;
        }
        usefulReplyDurations.push(duration);
      }
    }
  } else if (requestBaselines.length > 0) {
    incrementUsefulExclusion(
      'coverage_unavailable',
      coverageWindows.filter((window) => window === null).length,
    );
  }
  const firstUseful =
    requestBaselines.length === 0
      ? unavailableMetric<number>('request_projection_unavailable', {
          ...usefulReplyMetricBase,
          unit: 'calendar minutes',
        })
      : !allProjectionCoverageComplete
        ? unavailableMetric<number>('coverage_unavailable', {
            ...usefulReplyMetricBase,
            unit: 'calendar minutes',
            exclusions: usefulReplyExclusions,
          })
        : usefulReplyDurations.length === 0
          ? unavailableMetric<number>('no_useful_reply_evidence', {
              ...usefulReplyMetricBase,
              unit: 'calendar minutes',
              exclusions: usefulReplyExclusions,
            })
          : legacyMetric(round1((median(usefulReplyDurations) ?? 0) / 60_000), {
              ...usefulReplyMetricBase,
              unit: 'calendar minutes',
              denominator: usefulReplyDurations.length,
              exclusions: usefulReplyExclusions,
            });
  const dataHealth = input.dataHealth ?? buildExecutiveDataHealth(input, deduped);
  const service: AdminDashboardService = {
    firstObservedHumanReply: serviceMetric,
    firstUsefulReply: firstUseful,
    counts: serviceCounts,
    eligibleNewConversationCount: serviceEligibleOutput,
    unansweredEligible: serviceUnansweredOutput,
    unscorable: serviceUnscorableOutput,
  };
  const query: ExecutiveDashboardQuery = {
    cohortId: input.cohortId,
    window:
      input.windowEnd.getTime() - input.windowStart.getTime() > 7 * 24 * 60 * 60 * 1000
        ? '28d'
        : '7d',
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    observationCutoff: input.observationCutoff.toISOString(),
    sourceVintage,
  };
  const firstReplyCell = strictLegacyCell(serviceMetric);
  const p90ReplyCell = strictLegacyCell(p90Metric);
  return {
    query,
    traffic: {
      inbound: inboundMetric,
      outbound: outboundMetric,
      daily: dailyMetric,
      comparableWindowChangePercent: comparisonMetric,
    },
    activity,
    conversations,
    folders: { mix: folderMix, urgent: urgentMetric, exclusions: exclusionCounts },
    correspondents: { externalDomains: domainMetric },
    service,
    dataHealth,
    inboundVolume: strictLegacyCell(inboundMetric),
    medianFirstResponseMinutes: firstReplyCell,
    p90FirstResponseMinutes: p90ReplyCell,
    answeredWithin3hPercent: unavailable(),
    draftCreationMinutes: unavailable(),
    aiAssistedSendRate: unavailable(),
    medianEditDistance: unavailable(),
    totalRevenue: unavailable(),
    eligibleThreadCount: serviceEligibleOutput,
    unansweredEligible: serviceUnansweredOutput,
    inboundPerDay: daily.map((day) => ({
      period: day.period,
      byTransport: Object.fromEntries(
        Object.entries(day.byTransport).map(([transportId, counts]) => [
          transportId,
          counts.inbound,
        ]),
      ),
    })),
    comparison: transports.map((transport) => ({
      transportId: transport.id,
      label: transport.displayName?.trim() || transport.email,
      inbound: inboundRows.filter((row) => row.message.transportId === transport.id).length,
      answeredWithin3hPercent: null,
      drafted: null,
    })),
    perTransport: transports.map((transport) => ({
      transportId: transport.id,
      label: transport.displayName?.trim() || transport.email,
      inbound: inboundRows.filter((row) => row.message.transportId === transport.id).length,
      latenciesMinutes: serviceDurationsByTransport.get(transport.id) ?? [],
      unanswered: serviceCountsKnown ? (serviceUnansweredByTransport.get(transport.id) ?? 0) : null,
    })),
    transports,
    assumptions: [
      ...ADMIN_DASHBOARD_ASSUMPTIONS,
      'event_clock_not_import_created_at',
      'first_observed_human_reply_only',
      ...(measurementConfig?.captureAssumptionBasis
        ? [measurementConfig.captureAssumptionBasis]
        : ['measurement_config_unavailable']),
      'request_projection_immutable_semantic_rows',
    ],
    footnote: ADMIN_DASHBOARD_FOOTNOTE,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
  };
}

export function aggregateAdminDashboardMetrics(
  input:
    | ExecutiveAggregateInput
    | {
        threads: readonly AdminDashboardThreadRow[];
        messages: readonly AdminDashboardMessageRow[];
        transports: readonly AdminDashboardTransportRow[];
        windowStart: Date;
        windowEnd: Date;
      },
): AdminDashboardAggregateResult {
  if ('cohortId' in input) return aggregateExecutiveDashboardMetrics(input);
  return aggregateLegacyAdminDashboardMetrics(input);
}
