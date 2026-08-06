/**
 * Pure admin-dashboard baseline aggregators.
 * Compute-on-read from message/thread rows — no warehouse, no PII bodies.
 */

export type MetricAvailability = 'live' | 'unavailable' | 'coming_soon';

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
};

export type AdminDashboardThreadRow = {
  id: string;
  transportId: string;
  spamAt: Date | null;
  trashedAt: Date | null;
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

export function aggregateAdminDashboardMetrics(input: {
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

  return {
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
