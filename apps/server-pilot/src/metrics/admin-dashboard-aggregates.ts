/**
 * Pure admin-dashboard baseline aggregators.
 * Compute-on-read from message/thread rows — no warehouse, no PII bodies.
 */

import { buildMailDataHealth, type MailDataHealthMessage } from './mail-data-health.js';
import { isWithinConfirmedGap, type MailboxMeasurementConfig } from './mail-measurement-config.js';

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
  availabilityReason: string | null;
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

export type AdminDashboardService = {
  firstObservedHumanReply: MetricResult<number>;
  firstUsefulReply: MetricResult<number>;
  eligibleNewConversationCount: number;
  unansweredEligible: number;
  unscorable: number;
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
  partial: MetricResult<number>;
  unknown: MetricResult<number>;
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
  unanswered: number;
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
  eligibleThreadCount: number;
  unansweredEligible: number;
  inboundPerDay: AdminDashboardInboundDay[];
  comparison: AdminDashboardComparisonRow[];
  perTransport: AdminDashboardTransportSeries[];
  transports: AdminDashboardTransportRow[];
  assumptions: string[];
  footnote: string;
  windowStart: string;
  windowEnd: string;
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
    availabilityReason: reason,
  };
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
      .filter((entry): entry is { message: AdminDashboardMessageRow; at: Date } => entry.at !== null)
      .filter((entry) => inWindow(entry.at, windowStart, windowEnd))
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    if (inbounds.length === 0) continue;

    const anchor = inbounds[0]!.at;
    const outbounds = threadMessages
      .filter((m) => m.direction === 'outbound')
      .map((m) => ({ message: m, at: messageInstant(m, true) }))
      .filter((entry): entry is { message: AdminDashboardMessageRow; at: Date } => entry.at !== null)
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
    const eligible = series.latenciesMinutes.length + series.unanswered;
    const within = series.latenciesMinutes.filter((minutes) => minutes * 60_000 <= THREE_HOURS_MS)
      .length;
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
  const legacyDaily = resultDailyFromLegacy(inboundPerDay, input.messages, input.windowStart, input.windowEnd);
  const legacyUnavailable = unavailableMetric<never>('classification_snapshot_unavailable', {
    unit: 'conversations',
    sourceVintage: legacyQuery.sourceVintage,
  });
  const legacyConversations: AdminDashboardConversations = {
    awaitingHotel: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'conversations',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    awaitingCustomer: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'conversations',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    hotelActionPending: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'conversations',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    partial: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'conversations',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    unknown: unavailableMetric<number>('request_projection_unavailable', {
      unit: 'conversations',
      sourceVintage: legacyQuery.sourceVintage,
    }),
    ageBands: unavailableMetric<Record<string, number>>('request_projection_unavailable', {
      unit: 'conversation age bands',
      sourceVintage: legacyQuery.sourceVintage,
    }),
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
      weekdayArrivals: unavailableMetric<Record<string, number>>('classification_snapshot_unavailable', {
        unit: 'arrivals by weekday',
        sourceVintage: legacyQuery.sourceVintage,
      }),
      hourArrivals: unavailableMetric<Record<string, number>>('classification_snapshot_unavailable', {
        unit: 'arrivals by hour',
        sourceVintage: legacyQuery.sourceVintage,
      }),
    },
    conversations: legacyConversations,
    folders: {
      mix: legacyUnavailable,
      urgent: unavailableMetric<number>('classification_snapshot_unavailable', {
        unit: 'conversations',
        sourceVintage: legacyQuery.sourceVintage,
      }),
      exclusions: { spam: input.threads.filter((thread) => thread.spamAt != null).length, trash: input.threads.filter((thread) => thread.trashedAt != null).length },
    },
    correspondents: {
      externalDomains: unavailableMetric<AdminDashboardDomainRow[]>('classification_snapshot_unavailable', {
        unit: 'domains',
        sourceVintage: legacyQuery.sourceVintage,
      }),
    },
    service: {
      firstObservedHumanReply: unavailableMetric<number>('measurement_start_unavailable', {
        unit: 'minutes',
        sourceVintage: legacyQuery.sourceVintage,
      }),
      firstUsefulReply: unavailableMetric<number>('not_implemented', {
        unit: 'minutes',
        sourceVintage: legacyQuery.sourceVintage,
      }),
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
const NON_OBSERVED_EXECUTIVE_SEND_STATES = new Set([
  'pending',
  'sending',
  'cancelled',
  'failed',
]);

function asValidMillis(value: Date | string | null | undefined): number | null {
  const millis = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(millis) ? millis : null;
}

function asIso(value: Date | string | null | undefined): string | null {
  const millis = asValidMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
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
    sendState: left.sendState ?? right.sendState ?? null,
    authorClass: left.authorClass ?? right.authorClass,
    qualifiesNewConversation: left.qualifiesNewConversation ?? right.qualifiesNewConversation,
    hasScopedReplyLink: left.hasScopedReplyLink ?? right.hasScopedReplyLink,
    isAcknowledgement: left.isAcknowledgement ?? right.isAcknowledgement,
    hasMatchingOutbound: left.hasMatchingOutbound || right.hasMatchingOutbound,
  };
}

function executiveMessageIdentity(message: AdminDashboardMessageRow): string {
  const scope = message.transportId.trim().toLowerCase();
  const canonical = message.canonicalId?.trim().toLowerCase();
  if (canonical) return `${scope}:canonical:${canonical}`;
  const source = message.sourceMessageId?.trim().toLowerCase();
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
  if (message.direction === 'inbound' && message.receivedAt !== undefined && message.receivedAt !== null) {
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
  if (candidates.length === 0 && message.headerDateAt !== undefined && message.headerDateAt !== null) {
    candidates.push({ value: message.headerDateAt, basis: 'sender_timestamp_estimate' });
  }
  if (candidates.some(({ value }) => {
    const millis = asValidMillis(value);
    return millis === null || millis > observationCutoffMillis;
  })) return null;
  const candidate = candidates[0];
  if (!candidate) return null;
  const millis = asValidMillis(candidate.value);
  return millis === null ? null : { at: new Date(millis), basis: candidate.basis };
}

function executiveHasFutureClock(
  message: AdminDashboardMessageRow,
  observationCutoffMillis: number,
): boolean {
  const values = [
    message.sourceEventAt,
    message.eventAt,
    message.direction === 'inbound' ? message.receivedAt : message.sentAt,
    message.direction === 'outbound' && !message.sentAt ? message.receivedAt : null,
  ];
  return values.some((value) => {
    const millis = asValidMillis(value);
    return millis !== null && millis > observationCutoffMillis;
  });
}

function executiveMessageIsObserved(message: AdminDashboardMessageRow): boolean {
  return message.direction !== 'outbound' || !NON_OBSERVED_EXECUTIVE_SEND_STATES.has(message.sendState ?? '');
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
  };
}

function strictLegacyCell<T>(metric: MetricResult<T>): MetricCell {
  return metric.availability === 'available'
    ? { availability: 'live', value: metric.value as number | null }
    : { availability: 'unavailable', value: null };
}

function normalizeExecutiveFolder(
  snapshot: AdminDashboardClassificationThread,
): { folder: string; classification: AdminDashboardFolderRow['classification'] } {
  const folders = [...new Set((snapshot.folderSlugs ?? []).map((folder) => folder.trim().toLowerCase()).filter(Boolean))];
  const raw = snapshot.primaryFolder?.trim().toLowerCase() ?? (folders.length === 1 ? folders[0] : null);
  if (!raw) return { folder: 'unknown-review', classification: 'unclassified' };
  if (folders.length > 1) return { folder: 'unknown-review', classification: 'ambiguous' };
  if (EXECUTIVE_FOLDER_LABELS[raw]) return { folder: raw, classification: 'primary' };
  if (LEGACY_FOLDER_ALIASES[raw]) {
    return { folder: LEGACY_FOLDER_ALIASES[raw]!, classification: 'legacy' };
  }
  return { folder: 'unknown-review', classification: 'unclassified' };
}

function executiveDayRows(
  rows: readonly { message: AdminDashboardMessageRow; event: { at: Date; basis: DashboardTimestampBasis } }[],
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

function aggregateExecutiveDashboardMetrics(input: ExecutiveAggregateInput): AdminDashboardAggregateResult {
  const sourceVintage = input.observationCutoff.toISOString();
  const transports = input.transports.filter((transport) => executiveTransportMatches(transport, input.cohortId));
  const transportIds = new Set(transports.map((transport) => transport.id));
  const cutoffMillis = input.observationCutoff.getTime();
  const cohortInputCount = input.messages.filter((message) => transportIds.has(message.transportId)).length;
  const dedupedCohort = dedupeExecutiveMessages(input.messages).filter((message) => transportIds.has(message.transportId));
  const nonObservedSendState = dedupedCohort.filter((message) => !executiveMessageIsObserved(message)).length;
  const deduped = dedupedCohort.filter(executiveMessageIsObserved);
  const duplicateSourceCopies = Math.max(0, cohortInputCount - dedupedCohort.length);
  const unscorableClockCount = deduped.filter((message) => executiveEvent(message, cutoffMillis) === null).length;
  const futureOrCutoffCount = deduped.filter((message) => executiveHasFutureClock(message, cutoffMillis)).length;
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
    .filter((row): row is { message: AdminDashboardMessageRow; event: { at: Date; basis: DashboardTimestampBasis } } => row !== null);
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
        classificationRows
          .filter((row) => !row.spam && !row.trashed)
          .map((row) => row.threadId),
      )
    : new Set<string>();
  const businessRows = inWindow.filter((row) => businessThreadIds.has(row.message.threadId));
  const exclusionCounts = {
    spam: classificationRows.filter((row) => row.spam).length,
    trash: classificationRows.filter((row) => row.trashed).length,
  };
  const configuredMeasurement = input.measurementConfig;
  const measurementConfig = configuredMeasurement &&
    configuredMeasurement.cohortId === input.cohortId &&
    transports.some((transport) => transport.id === configuredMeasurement.transportId)
    ? configuredMeasurement
    : null;
  const metricBase = executiveMetricOptions(input, basis, measurementConfig);
  const daily = executiveDayRows(inWindow, transports, input.windowStart, input.windowEnd);

  const inboundMetric = legacyMetric(inboundRows.length, {
    ...metricBase,
    unit: 'messages',
    denominator: inboundRows.length,
    exclusions: clockExclusions,
  });
  const outboundMetric = legacyMetric(outboundRows.length, {
    ...metricBase,
    unit: 'messages',
    denominator: outboundRows.length,
    exclusions: clockExclusions,
  });
  const dailyMetric = legacyMetric(daily, {
    ...metricBase,
    unit: 'messages per day',
    denominator: inWindow.length,
    exclusions: clockExclusions,
  });

  let comparisonMetric: MetricResult<number>;
  if (input.previousMessages) {
    const previous = dedupeExecutiveMessages(input.previousMessages)
      .filter((message) => transportIds.has(message.transportId) && executiveMessageIsObserved(message))
      .map((message) => ({ message, event: executiveEvent(message, cutoffMillis) }))
      .filter((row): row is { message: AdminDashboardMessageRow; event: { at: Date; basis: DashboardTimestampBasis } } => row.event !== null)
      .filter((row) => row.message.direction === 'inbound');
    const previousCount = previous.filter(
      (row) => row.event.at >= new Date(input.windowStart.getTime() - (input.windowEnd.getTime() - input.windowStart.getTime())) && row.event.at < input.windowStart,
    ).length;
    const value = previousCount === 0 ? (inboundRows.length === 0 ? 0 : null) : ((inboundRows.length - previousCount) / previousCount) * 100;
    comparisonMetric = value === null
      ? unavailableMetric<number>('previous_window_zero', { ...metricBase, unit: 'percent', denominator: previousCount })
      : legacyMetric(Math.round(value * 10) / 10, { ...metricBase, unit: 'percent', denominator: previousCount });
  } else {
    comparisonMetric = unavailableMetric<number>('previous_window_unavailable', { ...metricBase, unit: 'percent' });
  }

  const snapshotUnavailable = unavailableMetric<never>('classification_snapshot_unavailable', {
    ...metricBase,
    unit: 'conversations',
    exclusions: exclusionCounts,
  });
  const activityThreadIds = new Set(businessRows.map((row) => row.message.threadId));
  const eventsByThread = new Map<string, Date[]>();
  for (const row of rows) {
    if (row.event.at.getTime() > cutoffMillis) continue;
    const events = eventsByThread.get(row.message.threadId) ?? [];
    events.push(row.event.at);
    eventsByThread.set(row.message.threadId, events);
  }
  const newlyObserved = [...activityThreadIds].filter((threadId) => {
    const events = eventsByThread.get(threadId) ?? [];
    return events.length > 0 && Math.min(...events.map((event) => event.getTime())) >= input.windowStart.getTime();
  }).length;
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
        activeConversations: legacyMetric(activityThreadIds.size, { ...metricBase, unit: 'conversations', denominator: activityThreadIds.size, exclusions: exclusionCounts }),
        newlyObservedConversations: legacyMetric(newlyObserved, { ...metricBase, unit: 'conversations', denominator: activityThreadIds.size, exclusions: exclusionCounts }),
        continuingConversations: legacyMetric(Math.max(0, activityThreadIds.size - newlyObserved), { ...metricBase, unit: 'conversations', denominator: activityThreadIds.size, exclusions: exclusionCounts }),
        distinctExternalSenderAddresses: legacyMetric(distinctExternalAddresses, { ...metricBase, unit: 'email addresses', denominator: distinctExternalAddresses, exclusions: exclusionCounts }),
        weekdayArrivals: legacyMetric(weekdayArrivals, { ...metricBase, unit: 'arrivals by weekday', denominator: businessRows.filter((row) => row.message.direction === 'inbound').length, exclusions: exclusionCounts }),
        hourArrivals: legacyMetric(hourArrivals, { ...metricBase, unit: 'arrivals by hour', denominator: businessRows.filter((row) => row.message.direction === 'inbound').length, exclusions: exclusionCounts }),
      }
    : {
        activeConversations: snapshotUnavailable,
        newlyObservedConversations: snapshotUnavailable,
        continuingConversations: snapshotUnavailable,
        distinctExternalSenderAddresses: unavailableMetric<number>('classification_snapshot_unavailable', {
          ...metricBase,
          unit: 'email addresses',
          exclusions: { classification: 1 },
        }),
        weekdayArrivals: unavailableMetric<Record<string, number>>('classification_snapshot_unavailable', {
          ...metricBase,
          unit: 'arrivals by weekday',
          exclusions: { classification: 1 },
        }),
        hourArrivals: unavailableMetric<Record<string, number>>('classification_snapshot_unavailable', {
          ...metricBase,
          unit: 'arrivals by hour',
          exclusions: { classification: 1 },
        }),
      };

  const folderRows = new Map<string, AdminDashboardFolderRow>();
  for (const folder of EXECUTIVE_FOLDER_ORDER) {
    folderRows.set(folder, { folder, label: EXECUTIVE_FOLDER_LABELS[folder]!, count: 0, urgentCount: 0, classification: 'primary' });
  }
  if (classificationMatches) {
    for (const row of classificationRows) {
      if (row.spam || row.trashed) continue;
      const normalized = normalizeExecutiveFolder(row);
      const folder = folderRows.get(normalized.folder)!;
      folder.count += 1;
      folder.urgentCount += row.urgent ? 1 : 0;
      if (normalized.classification !== 'primary') folder.classification = normalized.classification;
    }
  }
  const folderMix = classificationMatches
    ? legacyMetric([...folderRows.values()], { ...metricBase, unit: 'conversations by folder', denominator: businessThreadIds.size, exclusions: exclusionCounts })
    : snapshotUnavailable;
  const urgentMetric = classificationMatches
    ? legacyMetric(classificationRows.filter((row) => !row.spam && !row.trashed && row.urgent).length, { ...metricBase, unit: 'urgent conversations', denominator: businessThreadIds.size, exclusions: exclusionCounts })
    : snapshotUnavailable;

  const domainCounts = new Map<string, { count: number; addresses: Set<string> }>();
  for (const row of businessRows.filter((candidate) => candidate.message.direction === 'inbound')) {
    const address = row.message.fromAddress?.trim().toLowerCase();
    if (!address || address.endsWith('@legacyhotels.co.za')) continue;
    const rawDomain = address.split('@')[1] ?? 'unknown';
    const domain = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'].includes(rawDomain)
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
          .map(([domain, value]) => ({ domain, count: value.count, addresses: value.addresses.size }))
          .sort((left, right) => right.count - left.count || left.domain.localeCompare(right.domain)),
        { ...metricBase, unit: 'external domains', denominator: businessRows.filter((row) => row.message.direction === 'inbound').length, exclusions: exclusionCounts },
      )
    : unavailableMetric<AdminDashboardDomainRow[]>('classification_snapshot_unavailable', { ...metricBase, unit: 'external domains' });

  const measurementStartMillis = asValidMillis(measurementConfig?.measurementStartAt);
  const serviceGroups = new Map<string, { inbound: { at: Date; message: AdminDashboardMessageRow }[]; outbound: { at: Date; message: AdminDashboardMessageRow }[] }>();
  for (const row of rows) {
    if (measurementConfig && row.message.transportId !== measurementConfig.transportId) continue;
    const group = serviceGroups.get(row.message.threadId) ?? { inbound: [], outbound: [] };
    if (row.message.direction === 'inbound') group.inbound.push({ at: row.event.at, message: row.message });
    else group.outbound.push({ at: row.event.at, message: row.message });
    serviceGroups.set(row.message.threadId, group);
  }
  const serviceDurations: number[] = [];
  let serviceEligible = 0;
  let serviceUnanswered = 0;
  let serviceUnscorable = 0;
  if (measurementStartMillis !== null) {
    for (const group of serviceGroups.values()) {
      const inbound = group.inbound
        .filter(({ at, message }) => at.getTime() >= measurementStartMillis && at.getTime() < cutoffMillis && message.qualifiesNewConversation === true && message.authorClass === 'external_human')
        .sort((left, right) => left.at.getTime() - right.at.getTime())[0];
      if (!inbound) continue;
      serviceEligible += 1;
      const inboundInGap = isWithinConfirmedGap(inbound.at.toISOString(), measurementConfig);
      if (inboundInGap) {
        serviceUnscorable += 1;
        continue;
      }
      const outbound = group.outbound
        .filter(({ at, message }) => at.getTime() >= inbound.at.getTime() && at.getTime() < cutoffMillis && message.authorClass === 'internal_human' && message.hasScopedReplyLink === true)
        .sort((left, right) => left.at.getTime() - right.at.getTime())[0];
      if (!outbound) {
        const gapAfterInbound = measurementConfig?.confirmedGapIntervals.some((gap) => {
          const gapStart = asValidMillis(gap.startAt);
          return gapStart !== null && gapStart >= inbound.at.getTime() && gapStart < cutoffMillis;
        });
        if (gapAfterInbound) {
          serviceUnscorable += 1;
          continue;
        }
        serviceUnanswered += 1;
        continue;
      }
      if (
        isWithinConfirmedGap(inbound.at.toISOString(), measurementConfig) ||
        isWithinConfirmedGap(outbound.at.toISOString(), measurementConfig) ||
        measurementConfig?.confirmedGapIntervals.some((gap) => {
          const gapStart = asValidMillis(gap.startAt);
          const gapEnd = asValidMillis(gap.endAt);
          return gapStart !== null && gapEnd !== null && inbound.at.getTime() < gapEnd && outbound.at.getTime() > gapStart;
        })
      ) {
        serviceUnscorable += 1;
        continue;
      }
      serviceDurations.push(outbound.at.getTime() - inbound.at.getTime());
    }
    serviceUnscorable += rows.filter(
      (row) => row.message.qualifiesNewConversation === true && row.message.authorClass === 'unknown',
    ).length;
  }
  const serviceMetric = measurementStartMillis === null
    ? unavailableMetric<number>(
        !configuredMeasurement
          ? 'measurement_config_unavailable'
          : !measurementConfig
            ? 'measurement_config_scope_mismatch'
            : 'measurement_start_unavailable',
        { ...metricBase, unit: 'minutes', denominator: null },
      )
    : legacyMetric(serviceDurations.length === 0 ? null : round1((median(serviceDurations) ?? 0) / 60_000), { ...metricBase, unit: 'calendar minutes', denominator: serviceEligible, exclusions: { unanswered: serviceUnanswered, unscorable: serviceUnscorable } });
  const firstUseful = unavailableMetric<number>('not_implemented', { ...metricBase, unit: 'calendar minutes' });
  const conversations: AdminDashboardConversations = {
    awaitingHotel: unavailableMetric<number>('request_projection_unavailable', { ...metricBase, unit: 'conversations' }),
    awaitingCustomer: unavailableMetric<number>('request_projection_unavailable', { ...metricBase, unit: 'conversations' }),
    hotelActionPending: unavailableMetric<number>('request_projection_unavailable', { ...metricBase, unit: 'conversations' }),
    partial: unavailableMetric<number>('request_projection_unavailable', { ...metricBase, unit: 'conversations' }),
    unknown: unavailableMetric<number>('request_projection_unavailable', { ...metricBase, unit: 'conversations' }),
    ageBands: unavailableMetric<Record<string, number>>('request_projection_unavailable', { ...metricBase, unit: 'conversation age bands' }),
  };
  const dataHealth = input.dataHealth ?? buildExecutiveDataHealth(input, deduped);
  const service: AdminDashboardService = {
    firstObservedHumanReply: serviceMetric,
    firstUsefulReply: firstUseful,
    eligibleNewConversationCount: serviceEligible,
    unansweredEligible: serviceUnanswered,
    unscorable: serviceUnscorable,
  };
  const query: ExecutiveDashboardQuery = {
    cohortId: input.cohortId,
    window: input.windowEnd.getTime() - input.windowStart.getTime() > 7 * 24 * 60 * 60 * 1000 ? '28d' : '7d',
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    observationCutoff: input.observationCutoff.toISOString(),
    sourceVintage,
  };
  const firstReplyCell = strictLegacyCell(serviceMetric);
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
    p90FirstResponseMinutes: firstReplyCell,
    answeredWithin3hPercent: unavailable(),
    draftCreationMinutes: unavailable(),
    aiAssistedSendRate: unavailable(),
    medianEditDistance: unavailable(),
    totalRevenue: unavailable(),
    eligibleThreadCount: serviceEligible,
    unansweredEligible: serviceUnanswered,
    inboundPerDay: daily.map((day) => ({
      period: day.period,
      byTransport: Object.fromEntries(
        Object.entries(day.byTransport).map(([transportId, counts]) => [transportId, counts.inbound]),
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
      latenciesMinutes: [],
      unanswered: 0,
    })),
    transports,
    assumptions: [
      ...ADMIN_DASHBOARD_ASSUMPTIONS,
      'event_clock_not_import_created_at',
      'first_observed_human_reply_only',
      ...(measurementConfig?.captureAssumptionBasis ? [measurementConfig.captureAssumptionBasis] : ['measurement_config_unavailable']),
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
