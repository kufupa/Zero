/** Shared metric cell — unavailable/coming_soon never coerce to 0. */
export type MetricAvailability = 'live' | 'unavailable' | 'coming_soon';

export type MetricCell = {
  availability: MetricAvailability;
  value: number | null;
};

export type DashboardMetricAvailability = 'available' | 'unavailable';
export type DashboardTimestampBasis =
  | 'source_event'
  | 'sender_timestamp_estimate'
  | 'first_known'
  | 'availability'
  | 'mixed'
  | 'unknown';

/** Truthful hosted metric contract; unavailable values are always null. */
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
  measurementConfigVersion?: string | null;
  availabilityReason: string | null;
};

export type DashboardCohortId = 'centurion' | 'research';
export type DashboardWindowPreset = '7d' | '28d';

export type AdminDashboardCountDenominatorStatus = 'known' | 'unknown' | 'not_applicable';

export type AdminDashboardCountMetric = MetricResult<number> & {
  /** Distinguishes an absolute count from a count whose population is unknown. */
  denominatorStatus: AdminDashboardCountDenominatorStatus;
};

export type AdminDashboardSelection = {
  cohortId: DashboardCohortId;
  window: DashboardWindowPreset;
  /** Undefined is the server-resolved latest observation; explicit values are normalized ISO instants. */
  observationCutoff?: string;
};

export function normalizeAdminDashboardCutoff(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

export function normalizeAdminDashboardSelection(
  input?: Partial<AdminDashboardSelection> | null,
): AdminDashboardSelection {
  return {
    cohortId: input?.cohortId ?? 'centurion',
    window: input?.window ?? '7d',
    observationCutoff: normalizeAdminDashboardCutoff(input?.observationCutoff),
  };
}

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
  measurementConfigVersion?: string | null;
};

export type AdminDashboardService = {
  firstObservedHumanReply: MetricResult<number>;
  firstUsefulReply: MetricResult<number>;
  counts: AdminDashboardServiceCounts;
  eligibleNewConversationCount: number | null;
  unansweredEligible: number | null;
  unscorable: number | null;
};

export type AdminDashboardDataHealth = {
  availability: 'available' | 'unavailable';
  availabilityReason?:
    | 'missing_evidence'
    | 'invalid_observation_cutoff'
    | 'missing_scope'
    | 'missing_summary_basis'
    | 'unusable_evidence';
  observationCutoff: string;
  directionCounts: { inbound: number | null; outbound: number | null };
  lastObservedAt: { inbound: string | null; outbound: string | null };
  lastObservedBasis: {
    inbound: DashboardTimestampBasis | null;
    outbound: DashboardTimestampBasis | null;
  };
  singleton: { numerator: number | null; denominator: number | null };
  quotedMailboxReplyNoMatchingOutbound: {
    numerator: number | null;
    denominator: number | null;
    availability: 'available' | 'unavailable';
    reason?: 'quote_projection_unavailable' | 'thread_linkage_unavailable';
  };
  unscorable: {
    total: number;
    inbound: number;
    outbound: number;
    missingClock: number;
    invalidClock: number;
    missingThreadLinkage: number;
    missingIdentity: number;
  };
};

export type AdminDashboardShadowAdmissionPopulation = {
  availability: 'available' | 'unavailable';
  reason: 'no_admission_receipts' | 'not_loaded' | null;
  counts: {
    eligible: number | null;
    admitted: number | null;
    skipped: number | null;
    denied: number | null;
    pending: number | null;
  };
  provenance: {
    source: 'private_shadow_store';
    missingIsNotZero: true;
    evaluationMode: 'current_state' | 'historical_replay' | 'future_shadow';
    selectionClock: 'admission_created_at';
    windowStart: string | null;
    windowEnd: string | null;
    observationCutoff: string | null;
  };
};

/** Private U13 evaluation scorecard; unavailable quality remains null. */
export type AdminDashboardShadowScorecard = {
  schemaVersion: 'shadow-scorecard-v1';
  evaluationMode: 'current_state' | 'historical_replay' | 'future_shadow';
  counts: {
    eligible: number;
    admitted: number;
    sealed: number;
    unavailable: number;
    failed: number;
    skipped: number;
    denied: number;
    pending: number;
    matched: number;
    late: number;
    ambiguous: number;
    unmatched: number;
    unobserved: number;
    unknownCoverage: number;
    changedState: number;
    unscorable: number;
    labelled: number;
    scorable: number;
    correct: number;
    partial: number;
    incorrect: number;
  };
  quality: {
    availability: 'available' | 'unavailable';
    denominator: number | null;
    reason: 'label_provenance_unavailable' | 'no_assessments' | null;
    correctRate: number | null;
    usefulRate: number | null;
  };
  /** Admission-clock operational evidence; separate from sealed prediction outcomes. */
  admissionPopulation: AdminDashboardShadowAdmissionPopulation;
  provenance: {
    source: 'private_shadow_store';
    missingIsNotZero: true;
    evaluationMode: 'current_state' | 'historical_replay' | 'future_shadow';
    selectionClock?: 'sealed_at';
    windowStart?: string | null;
    windowEnd?: string | null;
    observationCutoff?: string | null;
  };
};

export type AdminDashboardConversations = {
  awaitingHotel: MetricResult<number>;
  awaitingCustomer: MetricResult<number>;
  hotelActionPending: MetricResult<number>;
  answered: MetricResult<number>;
  noReplyRequired: MetricResult<number>;
  partial: MetricResult<number>;
  unknown: MetricResult<number>;
  unknownEvidence: MetricResult<number>;
  bucketTotals: MetricResult<
    Record<
      | 'awaiting_hotel_reply'
      | 'awaiting_customer_information'
      | 'hotel_action_pending'
      | 'unknown'
      | 'answered'
      | 'no_reply_required',
      number
    >
  >;
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
  dataHealth: AdminDashboardDataHealth | null;
  shadowScorecard?: AdminDashboardShadowScorecard;
};

export type ExecutiveDashboardPayload = AdminDashboardPayload;

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
  unanswered: number | null;
};

/** Hosted metrics payload from adminDashboard.getMetrics */
export type AdminDashboardMetrics = {
  /** New executive payload; optional for legacy demo/hosted consumers during migration. */
  query?: ExecutiveDashboardQuery;
  traffic?: AdminDashboardTraffic;
  activity?: AdminDashboardActivity;
  conversations?: AdminDashboardConversations;
  folders?: AdminDashboardFolders;
  correspondents?: AdminDashboardCorrespondents;
  service?: AdminDashboardService;
  dataHealth?: AdminDashboardPayload['dataHealth'];
  shadowScorecard?: AdminDashboardShadowScorecard;
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
  transports: AdminDashboardTransport[];
  assumptions: string[];
  footnote: string;
  windowStart: string;
  windowEnd: string;
};

export type AdminDashboardExportMetric = MetricResult<number>;

export type AdminDashboardExport = {
  schemaVersion: 'admin-dashboard-export-v1';
  query: ExecutiveDashboardQuery;
  provenance: {
    observationCutoff: string;
    sourceVintage: string;
    measurementConfigVersions: string[];
    captureBases: string[];
  };
  buckets: Record<
    | 'awaiting_hotel_reply'
    | 'awaiting_customer_information'
    | 'hotel_action_pending'
    | 'unknown'
    | 'answered'
    | 'no_reply_required',
    AdminDashboardExportMetric
  >;
  overlays: {
    partially_answered: AdminDashboardExportMetric;
    unknown_evidence: AdminDashboardExportMetric;
  };
  metrics: Pick<
    AdminDashboardMetrics,
    'traffic' | 'activity' | 'service' | 'folders' | 'correspondents' | 'dataHealth'
  >;
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
  unanswered: number | null;
} {
  const latencies = series.flatMap((row) => row.latenciesMinutes).sort((a, b) => a - b);
  const unansweredKnown = series.every((row) => row.unanswered !== null);
  const unanswered = unansweredKnown
    ? series.reduce((total, row) => total + (row.unanswered ?? 0), 0)
    : null;
  const eligible = unanswered === null ? null : latencies.length + unanswered;
  const within3h = latencies.filter((minutes) => minutes <= 180).length;

  const median = (() => {
    if (latencies.length === 0) return null;
    const mid = Math.floor(latencies.length / 2);
    return latencies.length % 2 === 0
      ? (latencies[mid - 1]! + latencies[mid]!) / 2
      : latencies[mid]!;
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
      eligible === null || eligible === 0 ? null : Math.round((within3h / eligible) * 1000) / 10,
    unanswered,
  };
}
