/** Shared metric cell — unavailable/coming_soon never coerce to 0. */
export type MetricAvailability = 'live' | 'unavailable' | 'coming_soon';

export type MetricCell = {
  availability: MetricAvailability;
  value: number | null;
};

export type AdminDashboardTransport = {
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

export type AdminDashboardTransportSeries = {
  transportId: string;
  label: string;
  inbound: number;
  latenciesMinutes: number[];
  unanswered: number;
};

/** Hosted metrics payload from adminDashboard.getMetrics */
export type AdminDashboardMetrics = {
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
  transports: AdminDashboardTransport[];
  assumptions: string[];
  footnote: string;
  windowStart: string;
  windowEnd: string;
};

// --- Legacy demo contract (preserved; demo mode only) ---

export type ReservationSplitType = 'individual' | 'group' | 'travelAgents';

export type InboundReservationSplit = {
  type: ReservationSplitType;
  inboundEmails: number;
  averageChainSize: number;
  draftedEmails: number;
  bookedEmails: number;
  totalRevenue: number;
};

export type PerformanceProfile = {
  responseTimeMinutes: number[];
  draftCreationMinutes: number[];
};

export type EmailAddressSeriesItem = {
  hotelId: string;
  emailAddress: string;
  hotelName: string;
  inboxName: string;
  isCentralReservations?: boolean;
  sent: number;
  automated: number;
  approvals: number;
  qualityScore: number;
  performance: PerformanceProfile;
  reservationSplits: InboundReservationSplit[];
};

export type TimelinePoint = {
  period: string;
  drafted: number;
  approved: number;
  edited: number;
};

export type DashboardKpi = {
  label: string;
  value: number;
  trend: 'up' | 'down' | 'flat';
  deltaPct: number;
};

export type InboundReservationSplitAggregate = {
  type: ReservationSplitType;
  inboundEmails: number;
  averageChainSize: number;
  draftedPercent: number;
  bookedPercent: number;
  totalRevenue: number;
};

export type AdminDashboardData = {
  generatedAt: string;
  totals: DashboardKpi[];
  emails: EmailAddressSeriesItem[];
  trend: TimelinePoint[];
};

export function formatMetricCell(
  cell: MetricCell | null | undefined,
  formatter: (value: number) => string = String,
): string {
  if (!cell || cell.availability !== 'live' || cell.value == null) {
    return '—';
  }
  return formatter(cell.value);
}

export function formatLiveNumber(
  value: number | null | undefined,
  formatter: (value: number) => string = String,
): string {
  return value == null ? '—' : formatter(value);
}

/**
 * Recompute LIVE response cells for a mailbox subset from raw per-transport
 * latencies — combining medians of medians would be dishonest.
 */
export function summarizeTransportSeries(series: readonly AdminDashboardTransportSeries[]): {
  inbound: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  answeredWithin3hPercent: number | null;
  unanswered: number;
} {
  const latencies = series.flatMap((row) => row.latenciesMinutes).sort((a, b) => a - b);
  const unanswered = series.reduce((total, row) => total + row.unanswered, 0);
  const eligible = latencies.length + unanswered;
  const within3h = latencies.filter((minutes) => minutes <= 180).length;

  const median = (() => {
    if (latencies.length === 0) return null;
    const mid = Math.floor(latencies.length / 2);
    return latencies.length % 2 === 0 ? (latencies[mid - 1]! + latencies[mid]!) / 2 : latencies[mid]!;
  })();
  const p90 = (() => {
    if (latencies.length === 0) return null;
    const index = Math.ceil(0.9 * latencies.length) - 1;
    return latencies[Math.max(0, index)]!;
  })();

  // Same 1-decimal rounding as the server aggregate, so a full selection
  // reproduces the server's cells exactly.
  const round1 = (value: number | null) => (value == null ? null : Math.round(value * 10) / 10);

  return {
    inbound: series.reduce((total, row) => total + row.inbound, 0),
    medianMinutes: round1(median),
    p90Minutes: round1(p90),
    answeredWithin3hPercent:
      eligible === 0 ? null : Math.round((within3h / eligible) * 1000) / 10,
    unanswered,
  };
}
