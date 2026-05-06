import { Navigate } from 'react-router';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Check, ChevronDown, Filter } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { SettingsCard } from '@/components/settings/settings-card';
import { useAdminDashboardData } from '@/hooks/use-admin-dashboard';
import type { EmailAddressSeriesItem, TimelinePoint } from '@/lib/admin-dashboard/types';

type InboxOption = {
  id: string;
  hotelId: string;
  hotelName: string;
  inboxName: string;
  isCentralReservations: boolean;
};

type HotelGroupOption = {
  hotelId: string;
  hotelName: string;
  isCentralReservations: boolean;
  inboxes: InboxOption[];
};

type HotelAggregate = {
  hotelId: string;
  hotelName: string;
  isCentralReservations: boolean;
  sent: number;
  automated: number;
  approvals: number;
};

type InboundReservationSplitAggregate = {
  type: 'individual' | 'group' | 'travelAgents';
  inboundEmails: number;
  averageChainSize: number;
  draftedPercent: number;
  bookedPercent: number;
  totalRevenue: number;
};

type InboxTotals = {
  sent: number;
  automated: number;
  approvals: number;
  qualityScore: number;
};

const SPLIT_ORDER: InboundReservationSplitAggregate['type'][] = ['individual', 'group', 'travelAgents'];

const SPLIT_LABELS: Record<InboundReservationSplitAggregate['type'], string> = {
  individual: 'Individual bookings',
  group: 'Group bookings',
  travelAgents: 'Travel agents',
};

const SPLIT_THEME: Record<
  InboundReservationSplitAggregate['type'],
  { border: string; label: string; value: string; bar: string }
> = {
  individual: {
    border: 'border-sky-300 dark:border-sky-400/50',
    label: 'text-sky-700 dark:text-sky-200',
    value: 'text-sky-800 dark:text-sky-100',
    bar: 'bg-sky-500',
  },
  group: {
    border: 'border-amber-300 dark:border-amber-400/50',
    label: 'text-amber-700 dark:text-amber-200',
    value: 'text-amber-800 dark:text-amber-100',
    bar: 'bg-amber-500',
  },
  travelAgents: {
    border: 'border-violet-300 dark:border-violet-400/50',
    label: 'text-violet-700 dark:text-violet-200',
    value: 'text-violet-800 dark:text-violet-100',
    bar: 'bg-violet-500',
  },
};

const ZAR_FORMATTER = new Intl.NumberFormat('en-ZA', {
  style: 'currency',
  currency: 'ZAR',
  maximumFractionDigits: 0,
});

function getHotelId(item: EmailAddressSeriesItem) {
  const explicitHotelId = item.hotelId?.trim();
  const fallbackHotelId = item.hotelName?.trim();

  return explicitHotelId || fallbackHotelId || item.emailAddress;
}

function makeInboxLabel(item: EmailAddressSeriesItem) {
  return item.inboxName?.trim() || item.emailAddress;
}

function getHotelLabel(item: { hotelName?: string }) {
  return item.hotelName?.trim() || 'Unknown hotel';
}

function buildHotelGroups(emails: EmailAddressSeriesItem[]): HotelGroupOption[] {
  const hotelMap = new Map<string, HotelGroupOption>();

  for (const item of emails) {
    const hotelId = getHotelId(item);
    const existing = hotelMap.get(hotelId);
    const inbox: InboxOption = {
      id: item.emailAddress,
      hotelId,
      hotelName: item.hotelName,
      inboxName: makeInboxLabel(item),
      isCentralReservations: item.isCentralReservations ?? false,
    };

    if (!existing) {
      hotelMap.set(hotelId, {
        hotelId,
        hotelName: item.hotelName,
        isCentralReservations: item.isCentralReservations ?? false,
        inboxes: [inbox],
      });
      continue;
    }

    existing.inboxes.push(inbox);
    existing.isCentralReservations = existing.isCentralReservations || (item.isCentralReservations ?? false);
  }

  return Array.from(hotelMap.values());
}

function aggregateEmailsByHotel(emails: EmailAddressSeriesItem[]): HotelAggregate[] {
  const aggregateMap = new Map<string, HotelAggregate>();

  for (const item of emails) {
    const hotelId = getHotelId(item);
    const current = aggregateMap.get(hotelId);

    if (!current) {
      aggregateMap.set(hotelId, {
        hotelId,
        hotelName: item.hotelName,
        isCentralReservations: item.isCentralReservations ?? false,
        sent: item.sent,
        automated: item.automated,
        approvals: item.approvals,
      });
      continue;
    }

    current.sent += item.sent;
    current.automated += item.automated;
    current.approvals += item.approvals;
    current.isCentralReservations = current.isCentralReservations || (item.isCentralReservations ?? false);
  }

  return Array.from(aggregateMap.values());
}

const TREND_LINE_COLORS = ['#0ea5e9', '#16a34a', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#ef4444', '#0f766e'];

function formatCurrency(value: number) {
  return ZAR_FORMATTER.format(value);
}

function KpiMetric({
  label,
  value,
  subtitle,
  subtitlePosition = 'below',
}: {
  label: string;
  value: string;
  subtitle?: string;
  subtitlePosition?: 'below' | 'right';
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">{label}</p>
        {subtitle && subtitlePosition === 'right' ? (
          <p className="text-xs text-muted-foreground text-right">{subtitle}</p>
        ) : null}
      </div>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {subtitle && subtitlePosition === 'below' ? <p className="mt-2 text-xs text-muted-foreground">{subtitle}</p> : null}
    </div>
  );
}

function KpiBlock({
  label,
  value,
  subtitle,
  subtitlePosition,
}: {
  label: string;
  value: string;
  subtitle?: string;
  subtitlePosition?: 'below' | 'right';
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <KpiMetric label={label} value={value} subtitle={subtitle} subtitlePosition={subtitlePosition} />
      </CardContent>
    </Card>
  );
}

function KpiPairBlock({
  firstLabel,
  firstValue,
  firstSubtitle,
  secondLabel,
  secondValue,
  secondSubtitle,
}: {
  firstLabel: string;
  firstValue: string;
  firstSubtitle?: string;
  secondLabel: string;
  secondValue: string;
  secondSubtitle?: string;
}) {
  return (
    <Card className="xl:col-span-2">
      <CardContent className="p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <KpiMetric label={firstLabel} value={firstValue} subtitle={firstSubtitle} subtitlePosition="right" />
          <KpiMetric
            label={secondLabel}
            value={secondValue}
            subtitle={secondSubtitle}
            subtitlePosition="right"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function createTotals(emails: EmailAddressSeriesItem[]): InboxTotals {
  if (emails.length === 0) {
    return {
      sent: 0,
      automated: 0,
      approvals: 0,
      qualityScore: 0,
    };
  }

  const sums = emails.reduce(
    (acc, item) => {
      acc.sent += item.sent;
      acc.automated += item.automated;
      acc.approvals += item.approvals;
      acc.qualityScore += item.qualityScore;
      return acc;
    },
    { sent: 0, automated: 0, approvals: 0, qualityScore: 0 },
  );

  return {
    sent: sums.sent,
    automated: sums.automated,
    approvals: sums.approvals,
    qualityScore: Math.round(sums.qualityScore / emails.length),
  };
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  }

  return sorted[midpoint];
}

function computeMedianResponseTime(items: EmailAddressSeriesItem[]): number {
  const samples = items.flatMap((item) => item.performance?.responseTimeMinutes ?? []);
  return median(samples);
}

function computeAverageDraftCreationTime(items: EmailAddressSeriesItem[]): number {
  const samples = items.flatMap((item) => item.performance?.draftCreationMinutes ?? []);
  if (samples.length === 0) {
    return 0;
  }

  return samples.reduce((total, value) => total + value, 0) / samples.length;
}

function computeReservationSplitAggregates(items: EmailAddressSeriesItem[]): InboundReservationSplitAggregate[] {
  const initial = new Map<InboundReservationSplitAggregate['type'], InboundReservationSplitAggregate>([
    ['individual', { type: 'individual', inboundEmails: 0, averageChainSize: 0, draftedPercent: 0, bookedPercent: 0, totalRevenue: 0 }],
    ['group', { type: 'group', inboundEmails: 0, averageChainSize: 0, draftedPercent: 0, bookedPercent: 0, totalRevenue: 0 }],
    [
      'travelAgents',
      { type: 'travelAgents', inboundEmails: 0, averageChainSize: 0, draftedPercent: 0, bookedPercent: 0, totalRevenue: 0 },
    ],
  ]);
  const weightedChainWeight = new Map<InboundReservationSplitAggregate['type'], number>([
    ['individual', 0],
    ['group', 0],
    ['travelAgents', 0],
  ]);
  const draftedCounts = new Map<InboundReservationSplitAggregate['type'], number>([
    ['individual', 0],
    ['group', 0],
    ['travelAgents', 0],
  ]);
  const bookedCounts = new Map<InboundReservationSplitAggregate['type'], number>([
    ['individual', 0],
    ['group', 0],
    ['travelAgents', 0],
  ]);

  for (const item of items) {
    for (const split of item.reservationSplits ?? []) {
      const target = initial.get(split.type);
      if (!target) {
        continue;
      }

      target.inboundEmails += split.inboundEmails;
      target.totalRevenue += split.totalRevenue;

      const previousChainWeight = weightedChainWeight.get(split.type) ?? 0;
      weightedChainWeight.set(split.type, previousChainWeight + split.averageChainSize * split.inboundEmails);

      const previousDrafted = draftedCounts.get(split.type) ?? 0;
      draftedCounts.set(split.type, previousDrafted + split.draftedEmails);

      const previousBooked = bookedCounts.get(split.type) ?? 0;
      bookedCounts.set(split.type, previousBooked + split.bookedEmails);
    }
  }

  return SPLIT_ORDER.map((type) => {
    const aggregate = initial.get(type);
    const inboundEmails = aggregate?.inboundEmails ?? 0;
    const draftedEmails = draftedCounts.get(type) ?? 0;
    const bookedEmails = bookedCounts.get(type) ?? 0;
    const chainWeight = weightedChainWeight.get(type) ?? 0;
    const averageChainSize = inboundEmails > 0 ? Math.round((chainWeight / inboundEmails) * 10) / 10 : 0;
    const draftedPercent = inboundEmails > 0 ? Math.round((draftedEmails / inboundEmails) * 1000) / 10 : 0;
    const bookedPercent = inboundEmails > 0 ? Math.round((bookedEmails / inboundEmails) * 1000) / 10 : 0;

    return {
      type,
      inboundEmails,
      averageChainSize,
      draftedPercent,
      bookedPercent,
      totalRevenue: aggregate?.totalRevenue ?? 0,
    };
  });
}

function ReservationSplitCard({
  split,
  title,
}: {
  split: InboundReservationSplitAggregate;
  title: string;
}) {
  const theme = SPLIT_THEME[split.type];

  return (
    <Card className={`border ${theme.border}`}>
      <CardHeader className="pb-2">
        <CardTitle className={`text-sm font-medium ${theme.label}`}>{title}</CardTitle>
        <p className={`text-lg font-semibold ${theme.value}`}>Inbound: {split.inboundEmails}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className={`flex justify-between ${theme.value}`}>
          <span>Avg chain size</span>
          <span className="font-medium">{split.averageChainSize.toFixed(1)}</span>
        </div>
        <div className={`flex justify-between ${theme.value}`}>
          <span>Drafted</span>
          <span className="font-medium">{split.draftedPercent.toFixed(1)}%</span>
        </div>
        <div className={`flex justify-between ${theme.value}`}>
          <span>Booked</span>
          <span className="font-medium">{split.bookedPercent.toFixed(1)}%</span>
        </div>
        <div className={`flex justify-between ${theme.value}`}>
          <span>Total Revenue</span>
          <span className="font-medium">{formatCurrency(split.totalRevenue)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function scaleTrend(
  trend: TimelinePoint[],
  selectedTotals: InboxTotals,
  overallTotals: InboxTotals,
): TimelinePoint[] {
  if (trend.length === 0 || overallTotals.sent === 0) {
    return trend.map((point) => ({
      ...point,
      drafted: 0,
      approved: 0,
      edited: 0,
    }));
  }

  const scale = selectedTotals.sent / overallTotals.sent;
  return trend.map((point) => ({
    period: point.period,
    drafted: Math.round(point.drafted * scale),
    approved: Math.round(point.approved * scale),
    edited: Math.round(point.edited * scale),
  }));
}

function createTrendLineKey(label: string, index: number) {
  const safeLabel = label.replace(/[^a-zA-Z0-9]+/g, '_');
  return `hotel_${index}_${safeLabel}`;
}

type HotelTrendSeries = {
  key: string;
  label: string;
  share: number;
};

type InboundTrendDataPoint = { period: string } & Record<string, number | string>;

type TooltipPayloadItem = {
  dataKey?: string;
  name?: string;
  value?: string | number | null;
  color?: string;
};

type AdminTooltipProps = {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
};

function formatTooltipValue(value: string | number | null | undefined) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'number') {
    return value.toLocaleString();
  }
  return String(value);
}

type ComparisonTooltipPayloadItem = TooltipPayloadItem & {
  payload?: Record<string, unknown>;
};

type ComparisonEmailSeries = {
  hotelLabel: string;
  inbound: number;
  drafted: number;
  respondedWithinSla: number;
  inboundRaw: number;
  draftedRaw: number;
  respondedWithinSlaRaw: number;
};

type ComparisonChartDataPoint = {
  hotel: string;
  inbound: number;
  drafted: number;
  respondedWithinSla: number;
  raw_inbound: number;
  raw_drafted: number;
  raw_respondedWithinSla: number;
};

function formatComparisonPercentage(value: string | number | null | undefined) {
  if (value == null) {
    return '';
  }
  const numValue = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numValue)) {
    return '';
  }
  return `${numValue.toFixed(1)}%`;
}

function AdminEmailComparisonTooltip({ active, payload, label }: AdminTooltipProps) {
  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm">
      <p className="mb-1 font-medium text-popover-foreground">{label}</p>
      <div className="space-y-1">
        {payload.map((entry, index) => {
          const comparisonEntry = entry as ComparisonTooltipPayloadItem;
          const color = comparisonEntry.color ?? 'currentColor';
          const dataKey = comparisonEntry.dataKey ?? '';
          const percentageValue = formatComparisonPercentage(comparisonEntry.value);
          const rawValueLookup = dataKey ? `raw_${dataKey}` : '';
          const rawValue = comparisonEntry.payload && rawValueLookup ? comparisonEntry.payload[rawValueLookup] : 0;
          const normalizedRawValue = typeof rawValue === 'number' ? rawValue : Number(rawValue);
          const rawDisplay = Number.isFinite(normalizedRawValue) ? normalizedRawValue.toLocaleString() : '0';
          const seriesName = comparisonEntry.name ?? dataKey;

          return (
            <div key={comparisonEntry.dataKey ?? comparisonEntry.name ?? index} className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <span className="font-medium" style={{ color }}>
                  {seriesName}
                </span>
              </span>
              <span className="font-medium tabular-nums" style={{ color }}>
                {rawDisplay} ({percentageValue})
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AdminDashboardTooltip({ active, payload, label }: AdminTooltipProps) {
  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm">
      <p className="mb-1 font-medium text-popover-foreground">{label}</p>
      <div className="space-y-1">
        {payload.map((entry, index) => {
          const color = entry.color ?? 'currentColor';
          return (
            <div key={entry.dataKey ?? entry.name ?? index} className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <span className="font-medium" style={{ color }}>
                  {entry.name}
                </span>
              </span>
              <span className="font-medium tabular-nums" style={{ color }}>
                {formatTooltipValue(entry.value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AdminDashboardPage() {
  const { canAccess, isLoading, data, isError } = useAdminDashboardData();
  const [selectedInboxes, setSelectedInboxes] = useState<string[]>([]);

  const hotelOptions = useMemo<HotelGroupOption[]>(() => {
    return buildHotelGroups(data?.emails ?? []);
  }, [data?.emails]);

  const allInboxes = useMemo<InboxOption[]>(() => hotelOptions.flatMap((hotel) => hotel.inboxes), [hotelOptions]);
  const allInboxIds = useMemo(() => allInboxes.map((item) => item.id), [allInboxes]);
  const areAllInboxesSelected = selectedInboxes.length === allInboxes.length;

  useEffect(() => {
    if (!allInboxIds.length) {
      return;
    }
    setSelectedInboxes((prev) => {
      const valid = prev.filter((id) => allInboxIds.includes(id));
      return valid.length > 0 ? valid : allInboxIds;
    });
  }, [allInboxIds]);

  const selectedSet = useMemo(() => new Set(selectedInboxes), [selectedInboxes]);
  const expandedHotelIds = useMemo(() => {
    if (areAllInboxesSelected) {
      return new Set<string>();
    }

    const expanded = new Set<string>();

    for (const hotel of hotelOptions) {
      if (hotel.inboxes.some((inbox) => selectedSet.has(inbox.id))) {
        expanded.add(hotel.hotelId);
      }
    }

    return expanded;
  }, [areAllInboxesSelected, hotelOptions, selectedSet]);
  const selectedHotelSummary = useMemo(() => {
    return hotelOptions
      .map((hotel) => {
        const selectedInboxesForHotel = hotel.inboxes.filter((inbox) => selectedSet.has(inbox.id));
        if (selectedInboxesForHotel.length === 0) {
          return null;
        }

        return {
          hotel,
          selectedInboxes: selectedInboxesForHotel,
          totalCount: hotel.inboxes.length,
        };
      })
      .filter((entry): entry is { hotel: HotelGroupOption; selectedInboxes: InboxOption[]; totalCount: number } => entry !== null);
  }, [hotelOptions, selectedSet]);
  const selectedInboxesLabel = useMemo(() => {
    if (allInboxes.length === 0) {
      return 'No hotels available';
    }

    if (selectedInboxes.length === allInboxes.length) {
      return 'All Hotels selected';
    }

    if (selectedHotelSummary.length === 1) {
      const hotel = selectedHotelSummary[0].hotel;
      const selectedCount = selectedHotelSummary[0].selectedInboxes.length;
      const totalCount = selectedHotelSummary[0].totalCount;
      const hotelLabel = getHotelLabel(hotel);
      if (selectedCount === totalCount) {
        return hotelLabel;
      }
      if (selectedCount === 1) {
        return `${hotelLabel}: ${selectedHotelSummary[0].selectedInboxes[0]!.inboxName}`;
      }
      return `${hotelLabel} (${selectedCount} of ${totalCount} inboxes)`;
    }

    return `${selectedHotelSummary.length} hotels selected`;
  }, [allInboxes.length, selectedInboxes.length, selectedHotelSummary]);
  const filteredEmails = useMemo(
    () => (data?.emails ?? []).filter((item) => selectedSet.has(item.emailAddress)),
    [data?.emails, selectedSet],
  );
  const selectedHotelSeries = useMemo(() => aggregateEmailsByHotel(filteredEmails), [filteredEmails]);

  const selectedTotals = useMemo(() => createTotals(filteredEmails), [filteredEmails]);
  const overallTotals = useMemo(() => createTotals(data?.emails ?? []), [data?.emails]);
  const medianResponseTimeMinutes = useMemo(() => computeMedianResponseTime(filteredEmails), [filteredEmails]);
  const averageDraftCreationMinutes = useMemo(() => computeAverageDraftCreationTime(filteredEmails), [filteredEmails]);
  const splitMetrics = useMemo(() => computeReservationSplitAggregates(filteredEmails), [filteredEmails]);
  const totalReservationRevenue = useMemo(
    () => splitMetrics.reduce((total, split) => total + split.totalRevenue, 0),
    [splitMetrics],
  );
  const totalReservationEmails = useMemo(
    () => splitMetrics.reduce((total, split) => total + split.inboundEmails, 0),
    [splitMetrics],
  );
  const scaledTrendData = useMemo(
    () => scaleTrend(data?.trend ?? [], selectedTotals, overallTotals),
    [data?.trend, selectedTotals, overallTotals],
  );
  const trendSeries = useMemo<HotelTrendSeries[]>(() => {
    if (selectedHotelSeries.length === 0) {
      return [];
    }

    const hasSentTotal = selectedTotals.sent > 0;
    const baseShare = hasSentTotal ? 0 : 1 / selectedHotelSeries.length;

    return selectedHotelSeries.map((hotel, index) => ({
      key: createTrendLineKey(hotel.hotelId, index),
      label: hotel.hotelName,
      share: hasSentTotal ? hotel.sent / selectedTotals.sent : baseShare,
    }));
  }, [selectedHotelSeries, selectedTotals.sent]);
  const inboundEmailsPerDayData = useMemo<InboundTrendDataPoint[]>(() => {
    if (scaledTrendData.length === 0 || trendSeries.length === 0) {
      return [];
    }

    return scaledTrendData.map((point) => {
      const totalInbound = point.drafted + point.approved + point.edited;
      const pointData: InboundTrendDataPoint = { period: point.period };
      let remaining = totalInbound;

      trendSeries.forEach((series, index) => {
        const isLast = index === trendSeries.length - 1;
        const value = isLast ? remaining : Math.floor(totalInbound * series.share);
        pointData[series.key] = value;
        if (!isLast) {
          remaining -= value;
        }
      });

      return pointData;
    });
  }, [scaledTrendData, trendSeries]);
  const comparisonSeries = useMemo<ComparisonEmailSeries[]>(() => {
    return selectedHotelSeries.map((hotel) => {
      const sent = hotel.sent;
      const inboundPercent = sent > 0 ? 100 : 0;
      const draftedPercent = sent > 0 ? (hotel.automated / sent) * 100 : 0;
      const respondedPercent = sent > 0 ? (hotel.approvals / sent) * 100 : 0;
      const hotelBaseLabel = getHotelLabel(hotel);

      return {
        hotelLabel: hotelBaseLabel,
        inbound: Number(inboundPercent.toFixed(1)),
        drafted: Number(draftedPercent.toFixed(1)),
        respondedWithinSla: Number(respondedPercent.toFixed(1)),
        inboundRaw: sent,
        draftedRaw: hotel.automated,
        respondedWithinSlaRaw: hotel.approvals,
      };
    });
  }, [selectedHotelSeries]);
  const comparisonData = useMemo<ComparisonChartDataPoint[]>(() => {
    return [...comparisonSeries]
      .map((series) => ({
        hotel: series.hotelLabel,
        inbound: series.inbound,
        drafted: series.drafted,
        respondedWithinSla: series.respondedWithinSla,
        raw_inbound: series.inboundRaw,
        raw_drafted: series.draftedRaw,
        raw_respondedWithinSla: series.respondedWithinSlaRaw,
      }))
        .sort((a, b) => b.respondedWithinSla - a.respondedWithinSla);
  }, [comparisonSeries]);

  const handleInboxSelect = (inboxId: string) => {
    setSelectedInboxes((prev) => {
      if (prev.length === allInboxIds.length) {
        return [inboxId];
      }

      if (prev.includes(inboxId)) {
        if (prev.length <= 1) {
          return prev;
        }
        return prev.filter((id) => id !== inboxId);
      }

      return [...prev, inboxId];
    });
  };

  const handleHotelToggle = (hotel: HotelGroupOption) => {
    const hotelInboxIds = hotel.inboxes.map((inbox) => inbox.id);
    if (hotelInboxIds.length === 0) {
      return;
    }

    setSelectedInboxes((prev) => {
      if (prev.length === allInboxIds.length) {
        return hotelInboxIds;
      }

      const allHotelSelected = hotelInboxIds.every((id) => prev.includes(id));
      const selectedSetLocal = new Set(prev);

      if (allHotelSelected) {
        hotelInboxIds.forEach((id) => selectedSetLocal.delete(id));
        const next = Array.from(selectedSetLocal);
        return next.length > 0 ? next : prev;
      }

      hotelInboxIds.forEach((id) => selectedSetLocal.add(id));
      return [...selectedSetLocal];
    });
  };

  const handleClearSelection = () => {
    setSelectedInboxes(allInboxes.map((item) => item.id));
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading Admin dashboard…</div>;
  }

  if (!canAccess || !data) {
    return <Navigate to="/settings/general" replace />;
  }

  if (isError) {
    return <div className="text-sm text-destructive">Failed to load dashboard.</div>;
  }

  return (
    <div className="grid gap-6">
      <SettingsCard title="Admin dashboard">
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-end gap-3 border-b pb-4">

            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Filter className="h-3.5 w-3.5" />
                    {selectedInboxesLabel}
                    <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  {hotelOptions.map((hotel, hotelIndex) => {
                    const selectedHotelCount = hotel.inboxes.filter((inbox) => selectedSet.has(inbox.id)).length;
                    const isHotelChecked = selectedHotelCount === hotel.inboxes.length && hotel.inboxes.length > 0;
                    const hotelLabel = getHotelLabel(hotel);
                    const isHotelExpanded = expandedHotelIds.has(hotel.hotelId);

                    return (
                      <div key={hotel.hotelId} className={hotelIndex === 0 ? '' : 'mt-1'}>
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            handleHotelToggle(hotel);
                          }}
                          className="gap-2 bg-muted/30"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {hotelLabel}
                            {hotel.inboxes.length > 1 ? (
                              <span className="ml-2 text-xs text-muted-foreground">
                                ({selectedHotelCount}/{hotel.inboxes.length})
                              </span>
                            ) : null}
                          </span>
                          <span className={`text-muted-foreground ${isHotelChecked ? 'opacity-100' : 'opacity-0'}`}>
                            <Check className="h-4 w-4" />
                          </span>
                        </DropdownMenuItem>
                        {isHotelExpanded
                          ? hotel.inboxes.map((inbox) => {
                              const isChecked = selectedSet.has(inbox.id);
                              return (
                                <DropdownMenuItem
                                  key={inbox.id}
                                  onSelect={(event) => {
                                    event.preventDefault();
                                    handleInboxSelect(inbox.id);
                                  }}
                                  className="gap-2 pl-7"
                                >
                                  <span className="min-w-0 flex-1 truncate">{inbox.inboxName}</span>
                                  <span className={`text-muted-foreground ${isChecked ? 'opacity-100' : 'opacity-0'}`}>
                                    <Check className="h-4 w-4" />
                                  </span>
                                </DropdownMenuItem>
                              );
                            })
                          : null}
                        {hotelIndex === hotelOptions.length - 1 ? null : <DropdownMenuSeparator />}
                      </div>
                    );
                  })}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleClearSelection} disabled={selectedInboxes.length === allInboxes.length}>
                    {selectedInboxes.length === allInboxes.length ? 'All Hotels selected' : 'Select all'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
          {selectedInboxes.length < allInboxes.length ? (
            <Button variant="ghost" size="sm" onClick={handleClearSelection}>
              Clear
            </Button>
          ) : null}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-4">
            <KpiBlock
              label="Inbound reservation emails"
              value={`${totalReservationEmails}`}
              subtitle="Split by source below"
              subtitlePosition="right"
            />
            <KpiBlock
              label="Total revenue from emails"
              value={formatCurrency(totalReservationRevenue)}
              subtitle="Sum of all inbound splits"
              subtitlePosition="right"
            />
            <KpiPairBlock
              firstLabel="Median response time"
              firstValue={`${medianResponseTimeMinutes.toFixed(0)}m`}
              secondLabel="Average time for draft creation"
              secondValue={`${averageDraftCreationMinutes.toFixed(0)}m`}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Inbound reservation email splits</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-3">
                {splitMetrics.map((split) => (
                  <ReservationSplitCard key={split.type} split={split} title={SPLIT_LABELS[split.type]} />
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Email account comparison</CardTitle>
              </CardHeader>
              <CardContent className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={comparisonData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="hotel" tick={false} interval={0} />
                    <YAxis allowDecimals tickFormatter={(value) => `${value}%`} />
                    <Tooltip content={<AdminEmailComparisonTooltip />} />
                    <Legend />
                    <Bar dataKey="inbound" name="Inbound" fill={TREND_LINE_COLORS[0]} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="drafted" name="Drafted" fill={TREND_LINE_COLORS[1]} radius={[4, 4, 0, 0]} />
                    <Bar
                      dataKey="respondedWithinSla"
                      name="Responded within SLA"
                      fill={TREND_LINE_COLORS[2]}
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
                <p className="mt-2 text-xs text-muted-foreground">Sorted by lowest responded within SLA at the bottom.</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Inbound emails per day</CardTitle>
              </CardHeader>
              <CardContent className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={inboundEmailsPerDayData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="period" />
                    <YAxis allowDecimals={false} />
                    <Tooltip content={<AdminDashboardTooltip />} />
                    <Legend />
                    {trendSeries.map((series, index) => (
                      <Line
                        key={series.key}
                        type="monotone"
                        dataKey={series.key}
                        name={series.label}
                        stroke={TREND_LINE_COLORS[index % TREND_LINE_COLORS.length]}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          <p className="mt-2 text-xs text-muted-foreground">Stats are for the past 7 days.</p>
        </div>
      </SettingsCard>
    </div>
  );
}
