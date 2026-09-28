import type {
  AdminDashboardActivity,
  AdminDashboardConversations,
  AdminDashboardDataHealth,
  AdminDashboardDomainRow,
  AdminDashboardFolderRow,
  AdminDashboardMetrics,
  AdminDashboardShadowScorecard,
  AdminDashboardCountDenominatorStatus,
  AdminDashboardSelection,
  DashboardCohortId,
  DashboardWindowPreset,
  MetricCell,
  MetricResult,
} from '@/lib/admin-dashboard/types';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  normalizeAdminDashboardCutoff,
  normalizeAdminDashboardSelection,
} from '@/lib/admin-dashboard/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminDashboardData, useAdminDashboardExport } from '@/hooks/use-admin-dashboard';
import { SettingsCard } from '@/components/settings/settings-card';
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Navigate } from 'react-router';

type Metric<T> = MetricResult<T> | null | undefined;

const FOLDER_COLORS: Record<string, string> = {
  bookings: '#2563eb',
  'groups-events': '#7c3aed',
  'manage-stay': '#0f766e',
  'confirm-reconcile': '#0891b2',
  'money-billing': '#16a34a',
  'documents-delivery': '#4f46e5',
  'exceptions-recovery': '#dc2626',
  'guest-experience': '#c026d3',
  'internal-partner': '#9333ea',
  'automated-channel': '#475569',
  'unknown-review': '#a16207',
};

const CHART_COLORS = {
  inbound: '#2563eb',
  outbound: '#c026d3',
  count: '#0f766e',
  addresses: '#7c3aed',
};

const DATE_FORMATTER = new Intl.DateTimeFormat('en-ZA', {
  timeZone: 'Africa/Johannesburg',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-ZA').format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatMinutes(value: number): string {
  return `${formatNumber(Math.round(value))} calendar minutes`;
}

function displayDate(value: string | null | undefined): string {
  if (!value) return 'Not observed';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMATTER.format(timestamp) : 'Unknown';
}

function metricIsAvailable<T>(metric: Metric<T>): metric is MetricResult<T> & { value: T } {
  return metric?.availability === 'available' && metric.value !== null;
}

function metricReason<T>(metric: Metric<T>): string {
  if (!metric) return 'Metric was not returned for this snapshot.';
  if (metric.availabilityReason) return metric.availabilityReason.replaceAll('_', ' ');
  if (metric.availability !== 'available') return 'Evidence is unavailable for this snapshot.';
  if (metric.value === null) return 'No observed value is available.';
  return 'Observed from the selected window.';
}

function countDenominatorStatus(
  metric: Metric<unknown>,
): AdminDashboardCountDenominatorStatus | null {
  const status = (
    metric as { denominatorStatus?: AdminDashboardCountDenominatorStatus } | null | undefined
  )?.denominatorStatus;
  return status ?? null;
}

function denominatorText(metric: Metric<unknown>): string {
  const status = countDenominatorStatus(metric);
  if (status === 'not_applicable') return 'Not applicable (absolute count)';
  if (metric?.denominator == null) return 'Unknown';
  return formatNumber(metric.denominator);
}

function denominatorStatusText(status: AdminDashboardCountDenominatorStatus): string {
  if (status === 'not_applicable') return 'Not applicable (absolute count)';
  if (status === 'known') return 'Known eligible new conversations';
  return 'Unknown eligible population';
}

function metricFromLegacyCell(
  cell: MetricCell | null | undefined,
  basis: Metric<number> | undefined,
): Metric<number> {
  if (!basis) return null;
  const available = cell?.availability === 'live' && cell.value !== null;
  return {
    ...basis,
    availability: available ? 'available' : 'unavailable',
    value: available ? cell.value : null,
    availabilityReason: available ? null : 'response_evidence_unavailable',
  };
}

function exclusionText(exclusions: Record<string, number> | undefined): string {
  const entries = Object.entries(exclusions ?? {}).filter(([, count]) => count > 0);
  return entries.length === 0
    ? 'None recorded'
    : entries
        .map(([name, count]) => `${name.replaceAll('_', ' ')}: ${formatNumber(count)}`)
        .join(', ');
}

function EvidenceDetails<T>({ metric, label }: { metric: Metric<T>; label: string }) {
  return (
    <details className="text-muted-foreground mt-3 rounded-md border border-dashed p-2 text-xs">
      <summary className="text-foreground flex min-h-[44px] cursor-pointer select-none items-center font-medium">
        Definition &amp; evidence
      </summary>
      <dl className="mt-2 grid gap-1 sm:grid-cols-2" aria-label={`${label} evidence`}>
        <div>
          <dt className="text-foreground font-medium">Unit</dt>
          <dd>{metric?.unit ?? 'Not returned'}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Denominator</dt>
          <dd>{denominatorText(metric)}</dd>
        </div>
        {countDenominatorStatus(metric) ? (
          <div>
            <dt className="text-foreground font-medium">Denominator status</dt>
            <dd>{denominatorStatusText(countDenominatorStatus(metric)!)}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-foreground font-medium">Exclusions</dt>
          <dd>{exclusionText(metric?.exclusions)}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Timestamp basis</dt>
          <dd>{metric?.timestampBasis ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Capture basis</dt>
          <dd>{metric?.captureBasis ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Source vintage</dt>
          <dd>{displayDate(metric?.sourceVintage)}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Measurement config version</dt>
          <dd>{metric?.measurementConfigVersion ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">classificationAsOf</dt>
          <dd>{displayDate(metric?.classificationAsOf)}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Snapshot basis</dt>
          <dd>{metric?.snapshotBasis ?? 'Not applicable'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-foreground font-medium">Availability</dt>
          <dd>{metricReason(metric)}</dd>
        </div>
      </dl>
    </details>
  );
}

function MetricCard<T>({
  label,
  metric,
  formatter,
  description,
}: {
  label: string;
  metric: Metric<T>;
  formatter: (value: T) => string;
  description: ReactNode;
}) {
  const available = metricIsAvailable(metric);

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{label}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums" aria-live="polite">
          {available ? formatter(metric.value) : '—'}
        </p>
        {!available ? (
          <p className="text-muted-foreground mt-1 text-xs">Unavailable: {metricReason(metric)}</p>
        ) : null}
        <EvidenceDetails label={label} metric={metric} />
      </CardContent>
    </Card>
  );
}

function DataTable({
  caption,
  headers,
  rows,
}: {
  caption: string;
  headers: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <details className="mt-3 rounded-md border p-2 text-xs">
      <summary className="flex min-h-[44px] cursor-pointer select-none items-center font-medium">
        View data table
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="min-w-full border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header} className="border-b px-2 py-1 font-medium" scope="col">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="text-muted-foreground px-2 py-2" colSpan={headers.length}>
                  No observations in the selected window.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={`${caption}-${row.map(String).join('\u001f')}`}>
                  {headers.map((header, column) => (
                    <td key={header} className="border-b px-2 py-1 tabular-nums">
                      {row[column]}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ChartFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ChartUnavailable({ metric, label }: { metric: Metric<unknown>; label: string }) {
  return (
    <div className="text-muted-foreground flex min-h-48 items-center justify-center rounded-md border border-dashed p-4 text-center text-sm">
      <div>
        <p>{label} unavailable</p>
        <p className="mt-1 text-xs">{metricReason(metric)}</p>
        <EvidenceDetails metric={metric} label={label} />
      </div>
    </div>
  );
}

function DashboardControls({
  cohortId,
  windowPreset,
  observationCutoff,
  onCohortChange,
  onWindowChange,
  onCutoffChange,
  onExport,
  exporting,
}: {
  cohortId: DashboardCohortId;
  windowPreset: DashboardWindowPreset;
  observationCutoff: string;
  onCohortChange: (value: DashboardCohortId) => void;
  onWindowChange: (value: DashboardWindowPreset) => void;
  onCutoffChange: (value: string) => void;
  onExport: () => void;
  exporting: boolean;
}) {
  return (
    <div className="bg-muted/20 grid gap-3 rounded-lg border p-3 lg:grid-cols-[minmax(12rem,1fr)_minmax(10rem,0.8fr)_minmax(12rem,1fr)_auto_auto] lg:items-end">
      <div className="grid gap-1.5">
        <Label htmlFor="dashboard-cohort">Cohort</Label>
        <Select
          value={cohortId}
          onValueChange={(value) => onCohortChange(value as DashboardCohortId)}
        >
          <SelectTrigger
            id="dashboard-cohort"
            className="min-h-[44px]"
            aria-describedby="dashboard-cohort-help"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem className="min-h-[44px] py-2" value="centurion">
              Centurion
            </SelectItem>
            <SelectItem className="min-h-[44px] py-2" value="research">
              Research
            </SelectItem>
          </SelectContent>
        </Select>
        <p id="dashboard-cohort-help" className="text-muted-foreground text-xs">
          Configured pilot users share the same bounded dashboard and export access.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="dashboard-window">Window</Label>
        <Select
          value={windowPreset}
          onValueChange={(value) => onWindowChange(value as DashboardWindowPreset)}
        >
          <SelectTrigger id="dashboard-window" className="min-h-[44px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem className="min-h-[44px] py-2" value="7d">
              7 days
            </SelectItem>
            <SelectItem className="min-h-[44px] py-2" value="28d">
              28 days
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="dashboard-cutoff">Observation cutoff</Label>
        <input
          id="dashboard-cutoff"
          type="date"
          value={observationCutoff}
          onChange={(event) => onCutoffChange(event.currentTarget.value)}
          className="border-input bg-background focus:outline-hidden focus:ring-ring min-h-[44px] rounded-md border px-3 py-2 text-sm focus:ring-2"
          aria-describedby="dashboard-cutoff-help"
        />
        <p id="dashboard-cutoff-help" className="text-muted-foreground text-xs">
          End of day in Africa/Johannesburg. Latest observed when blank.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        className="min-h-[44px]"
        onClick={() => onCutoffChange('')}
        disabled={!observationCutoff}
      >
        Latest observed
      </Button>
      <Button
        type="button"
        variant="outline"
        className="min-h-[44px]"
        onClick={onExport}
        disabled={exporting}
      >
        {exporting ? 'Preparing export…' : 'Export bounded snapshot'}
      </Button>
    </div>
  );
}

function SnapshotNote({ metrics }: { metrics: AdminDashboardMetrics }) {
  const query = metrics.query;
  const traffic = metrics.traffic?.inbound;
  return (
    <div className="bg-muted/20 text-muted-foreground rounded-lg border p-3 text-xs">
      <p className="text-foreground font-medium">Data note</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-foreground font-medium">Cohort</dt>
          <dd>{query?.cohortId ?? 'Not returned'}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Window</dt>
          <dd>{query?.window ?? 'Not returned'}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Observation cutoff</dt>
          <dd>{displayDate(query?.observationCutoff)}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Source vintage</dt>
          <dd>{displayDate(query?.sourceVintage ?? traffic?.sourceVintage)}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Capture basis</dt>
          <dd>{traffic?.captureBasis ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Measurement config version</dt>
          <dd>
            {metrics.service?.counts.measurementConfigVersion ??
              traffic?.measurementConfigVersion ??
              'Unknown'}
          </dd>
        </div>
        <div>
          <dt className="text-foreground font-medium">Timezone</dt>
          <dd>Africa/Johannesburg</dd>
        </div>
      </dl>
    </div>
  );
}

function TrafficSection({ metrics }: { metrics: AdminDashboardMetrics }) {
  const traffic = metrics.traffic;
  const daily = metricIsAvailable(traffic?.daily) ? traffic.daily.value : [];
  const rows = daily.map((day) => [day.period, day.inbound, day.outbound]);

  return (
    <section aria-labelledby="traffic-heading" className="grid gap-4">
      <div>
        <h2 id="traffic-heading" className="text-lg font-semibold">
          Communication demand
        </h2>
        <p className="text-muted-foreground text-sm">
          Messages, not bookings or staff effort. Event dates are used.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Incoming messages"
          metric={traffic?.inbound}
          formatter={formatNumber}
          description="Raw observed inbound transport messages."
        />
        <MetricCard
          label="Outgoing messages"
          metric={traffic?.outbound}
          formatter={formatNumber}
          description="Raw observed outbound transport messages."
        />
        <MetricCard
          label="Comparable window change"
          metric={traffic?.comparableWindowChangePercent}
          formatter={formatPercent}
          description="Inbound change versus the bounded previous window."
        />
        <MetricCard
          label="Daily trend coverage"
          metric={traffic?.daily}
          formatter={(value) => `${formatNumber(value.length)} observed days`}
          description="Known daily inbound and outbound event totals."
        />
      </div>
      <ChartFrame
        title="Incoming and outgoing messages by day"
        description="Arrival trend; no staffing-utilization claim."
      >
        {metricIsAvailable(traffic?.daily) ? (
          <>
            <div className="h-64 min-w-0" aria-label="Incoming and outgoing messages line chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={daily} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="inbound"
                    name="Incoming"
                    stroke={CHART_COLORS.inbound}
                    strokeWidth={2}
                  />
                  <Line
                    type="monotone"
                    dataKey="outbound"
                    name="Outgoing"
                    stroke={CHART_COLORS.outbound}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <DataTable
              caption="Incoming and outgoing messages by day"
              headers={['Day', 'Incoming', 'Outgoing']}
              rows={rows}
            />
          </>
        ) : (
          <ChartUnavailable metric={traffic?.daily} label="Message trend" />
        )}
      </ChartFrame>
      <p className="text-muted-foreground text-xs">
        {traffic?.inbound?.captureBasis ?? 'Unknown capture basis'}. Unknown and excluded event
        clocks are not counted as zero.
      </p>
    </section>
  );
}

function ActivitySection({ activity }: { activity: AdminDashboardActivity | undefined }) {
  const weekday = metricIsAvailable(activity?.weekdayArrivals)
    ? activity.weekdayArrivals.value
    : null;
  const hours = metricIsAvailable(activity?.hourArrivals) ? activity.hourArrivals.value : null;
  const weekdayRows: Array<Array<string | number>> = weekday
    ? Object.entries(weekday).map(([day, count]) => [day, count])
    : [];
  const hourRows: Array<Array<string | number>> = hours
    ? Object.entries(hours)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([hour, count]) => [hour, count])
    : [];

  return (
    <section aria-labelledby="activity-heading" className="grid gap-4">
      <div>
        <h2 id="activity-heading" className="text-lg font-semibold">
          Conversation activity
        </h2>
        <p className="text-muted-foreground text-sm">
          Observed starts and addresses; an address is not a person.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Active conversations"
          metric={activity?.activeConversations}
          formatter={formatNumber}
          description="Unique business conversations in the selected snapshot."
        />
        <MetricCard
          label="Newly observed"
          metric={activity?.newlyObservedConversations}
          formatter={formatNumber}
          description="Observed starts with retained pre-window evidence."
        />
        <MetricCard
          label="Continuing conversations"
          metric={activity?.continuingConversations}
          formatter={formatNumber}
          description="Active conversations with bounded pre-window evidence."
        />
        <MetricCard
          label="External sender addresses"
          metric={activity?.distinctExternalSenderAddresses}
          formatter={formatNumber}
          description="Distinct external email addresses, not customers."
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartFrame
          title="Arrivals by day of week"
          description="Arrival pattern in Africa/Johannesburg."
        >
          {metricIsAvailable(activity?.weekdayArrivals) ? (
            <>
              <div className="h-56 min-w-0" aria-label="Arrivals by weekday bar chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={weekdayRows.map(([day, count]) => ({ day, count }))}
                    margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" name="Arrivals" fill={CHART_COLORS.count} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <DataTable
                caption="Arrivals by day of week"
                headers={['Day', 'Arrivals']}
                rows={weekdayRows}
              />
            </>
          ) : (
            <ChartUnavailable metric={activity?.weekdayArrivals} label="Weekday arrivals" />
          )}
        </ChartFrame>
        <ChartFrame
          title="Arrivals by hour"
          description="Calendar arrival pattern, not staffing utilization."
        >
          {metricIsAvailable(activity?.hourArrivals) ? (
            <>
              <div className="h-56 min-w-0" aria-label="Arrivals by hour bar chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={hourRows.map(([hour, count]) => ({ hour, count }))}
                    margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" name="Arrivals" fill={CHART_COLORS.count} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <DataTable
                caption="Arrivals by hour"
                headers={['Hour', 'Arrivals']}
                rows={hourRows}
              />
            </>
          ) : (
            <ChartUnavailable metric={activity?.hourArrivals} label="Hourly arrivals" />
          )}
        </ChartFrame>
      </div>
    </section>
  );
}

function FolderSection({ metrics }: { metrics: AdminDashboardMetrics }) {
  const folderMetric = metrics.folders?.mix;
  const folders: AdminDashboardFolderRow[] = metricIsAvailable(folderMetric)
    ? folderMetric.value
    : [];
  const rows: Array<Array<string | number>> = folders.map((folder) => [
    folder.label,
    folder.count,
    folder.urgentCount,
    folder.classification,
  ]);

  return (
    <section aria-labelledby="folders-heading" className="grid gap-4">
      <div>
        <h2 id="folders-heading" className="text-lg font-semibold">
          Business breakdown
        </h2>
        <p className="text-muted-foreground text-sm">
          Unique active conversations grouped by the currently observed primary folder. Urgent is an
          overlay.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(14rem,1fr)]">
        <ChartFrame
          title="Business work by folder"
          description="Current eleven-folder workflow taxonomy; ambiguous and legacy labels remain explicit."
        >
          {metricIsAvailable(folderMetric) ? (
            <>
              <div
                className="h-[28rem] min-w-0"
                aria-label="Business work by folder horizontal bar chart"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={folders}
                    layout="vertical"
                    margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" allowDecimals={false} />
                    <YAxis type="category" dataKey="label" width={150} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar
                      dataKey="count"
                      name="Conversations"
                      fill={CHART_COLORS.count}
                      radius={[0, 4, 4, 0]}
                    >
                      {folders.map((folder) => (
                        <Cell
                          key={folder.folder}
                          fill={FOLDER_COLORS[folder.folder] ?? CHART_COLORS.count}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <DataTable
                caption="Business work by folder"
                headers={['Folder', 'Conversations', 'Urgent overlay', 'Classification']}
                rows={rows}
              />
              <p className="text-muted-foreground mt-2 text-xs">
                classificationAsOf: {displayDate(folderMetric.classificationAsOf)}. Excluded from
                this chart: {exclusionText(metrics.folders?.exclusions)}.
              </p>
            </>
          ) : (
            <ChartUnavailable metric={folderMetric} label="Folder classification" />
          )}
        </ChartFrame>
        <div className="grid content-start gap-4">
          <MetricCard
            label="Urgent conversations"
            metric={metrics.folders?.urgent}
            formatter={formatNumber}
            description="Overlay on the exclusive folder mix."
          />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Classification exclusions</CardTitle>
              <CardDescription>
                Mutable spam/trash membership is only applied from a matching retained snapshot.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{exclusionText(metrics.folders?.exclusions)}</p>
              <p className="text-muted-foreground mt-2 text-xs">
                No historical folder state is fabricated when the snapshot is unavailable.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

function CorrespondentSection({ metrics }: { metrics: AdminDashboardMetrics }) {
  const domainMetric = metrics.correspondents?.externalDomains;
  const domains: AdminDashboardDomainRow[] = metricIsAvailable(domainMetric)
    ? domainMetric.value
    : [];
  const rows: Array<Array<string | number>> = domains.map((domain) => [
    domain.domain,
    domain.count,
    domain.addresses,
  ]);

  return (
    <section aria-labelledby="correspondents-heading" className="grid gap-4">
      <div>
        <h2 id="correspondents-heading" className="text-lg font-semibold">
          External correspondents
        </h2>
        <p className="text-muted-foreground text-sm">
          Domain is not verified company identity or commercial value.
        </p>
      </div>
      <ChartFrame
        title="Top external domains"
        description="Public email providers are grouped; aggregate access shows no raw messages."
      >
        {metricIsAvailable(domainMetric) ? (
          <>
            <div className="h-64 min-w-0" aria-label="External domains bar chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={domains}
                  layout="vertical"
                  margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" allowDecimals={false} />
                  <YAxis type="category" dataKey="domain" width={120} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar
                    dataKey="count"
                    name="Messages"
                    fill={CHART_COLORS.addresses}
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <DataTable
              caption="External domains"
              headers={['Domain', 'Messages', 'Addresses']}
              rows={rows}
            />
          </>
        ) : (
          <ChartUnavailable metric={domainMetric} label="External domains" />
        )}
      </ChartFrame>
    </section>
  );
}

function ServiceSection({ metrics }: { metrics: AdminDashboardMetrics }) {
  const service = metrics.service;
  const serviceCounts = service?.counts;
  const conversations: AdminDashboardConversations | undefined = metrics.conversations;
  const firstReply = service?.firstObservedHumanReply;
  const firstUseful = service?.firstUsefulReply;
  const p90Reply = metricFromLegacyCell(metrics.p90FirstResponseMinutes, firstReply);
  const responseUnavailable = !metricIsAvailable(firstReply);

  return (
    <section aria-labelledby="service-heading" className="grid gap-4">
      <div>
        <h2 id="service-heading" className="text-lg font-semibold">
          Response and attention signals
        </h2>
        <p className="text-muted-foreground text-sm">
          First observed human reply is a narrow calendar-time measure, not proof that every ask or
          hotel task was completed.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="First observed human reply"
          metric={firstReply}
          formatter={formatMinutes}
          description={
            responseUnavailable
              ? 'Response metrics temporarily unavailable.'
              : 'Median among valid eligible new conversations.'
          }
        />
        <MetricCard
          label="P90 first observed human reply"
          metric={p90Reply}
          formatter={formatMinutes}
          description="Answered-only tail latency; not a service-level target."
        />
        <MetricCard
          label="First useful reply"
          metric={firstUseful}
          formatter={formatMinutes}
          description="Median calendar time to the first supported answer to an eligible ask."
        />
        <MetricCard
          label="Eligible new conversations"
          metric={serviceCounts?.eligibleNewConversations}
          formatter={formatNumber}
          description="T0-scoped denominator; strict service evidence only."
        />
        <MetricCard
          label="Unanswered eligible"
          metric={serviceCounts?.unansweredEligible}
          formatter={formatNumber}
          description="Known eligible requests without a qualifying reply."
        />
        <MetricCard
          label="Unscorable / unknown"
          metric={serviceCounts?.unscorable}
          formatter={formatNumber}
          description="Invalid clocks, confirmed gaps, or unknown reply evidence."
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Measurement start (T0): {displayDate(serviceCounts?.measurementStartAt)}. Config version:{' '}
        {serviceCounts?.measurementConfigVersion ?? 'Unknown'}. Legacy count fields are not rendered
        without strict evidence.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          label="Awaiting hotel reply"
          metric={conversations?.awaitingHotel}
          formatter={formatNumber}
          description="Request-state projection."
        />
        <MetricCard
          label="Awaiting customer information"
          metric={conversations?.awaitingCustomer}
          formatter={formatNumber}
          description="Request-state projection."
        />
        <MetricCard
          label="Hotel action pending"
          metric={conversations?.hotelActionPending}
          formatter={formatNumber}
          description="Completion is not inferred from email absence."
        />
        <MetricCard
          label="Unknown request state"
          metric={conversations?.unknown}
          formatter={formatNumber}
          description="Unknown evidence remains explicit."
        />
        <MetricCard
          label="Answered"
          metric={conversations?.answered}
          formatter={formatNumber}
          description="Exclusive primary request-state bucket."
        />
        <MetricCard
          label="No reply required"
          metric={conversations?.noReplyRequired}
          formatter={formatNumber}
          description="Exclusive primary request-state bucket."
        />
        <MetricCard
          label="Partially answered"
          metric={conversations?.partial}
          formatter={formatNumber}
          description="Overlay on primary buckets; not additive."
        />
        <MetricCard
          label="Unknown evidence"
          metric={conversations?.unknownEvidence}
          formatter={formatNumber}
          description="Evidence-quality overlay; not additive."
        />
        <MetricCard
          label="Conversation age bands"
          metric={conversations?.ageBands}
          formatter={(value) => `${formatNumber(Object.keys(value).length)} bands`}
          description="Calendar age diagnostics only."
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Primary request-state buckets are mutually exclusive. Partially answered and unknown
        evidence are overlays and must not be added to the primary totals.
      </p>
      <p className="text-muted-foreground text-sm">
        Response comparison temporarily unavailable unless a comparable bounded prior window is
        returned.
      </p>
    </section>
  );
}

function DataHealthSection({
  dataHealth,
}: {
  dataHealth: AdminDashboardDataHealth | null | undefined;
}) {
  if (!dataHealth) {
    return (
      <section aria-labelledby="health-heading" className="grid gap-3">
        <h2 id="health-heading" className="text-lg font-semibold">
          Data diagnostics
        </h2>
        <div
          role="status"
          className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm"
        >
          Diagnostics unavailable: no health evidence was returned.
        </div>
      </section>
    );
  }

  if (dataHealth.availability !== 'available') {
    return (
      <section aria-labelledby="health-heading" className="grid gap-3">
        <h2 id="health-heading" className="text-lg font-semibold">
          Data diagnostics
        </h2>
        <div
          role="status"
          className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm"
        >
          Diagnostics unavailable:{' '}
          {(dataHealth.availabilityReason ?? 'evidence unavailable').replaceAll('_', ' ')}.
        </div>
        <p className="text-muted-foreground text-xs">
          Health snapshot cutoff: {displayDate(dataHealth.observationCutoff)}.
        </p>
      </section>
    );
  }

  const singleton =
    dataHealth.singleton.numerator == null ||
    dataHealth.singleton.denominator == null ||
    dataHealth.singleton.denominator === 0
      ? 'Unavailable'
      : formatPercent((dataHealth.singleton.numerator / dataHealth.singleton.denominator) * 100);
  const inbound = dataHealth.directionCounts.inbound;
  const outbound = dataHealth.directionCounts.outbound;
  const directionRatio =
    inbound == null || outbound == null
      ? 'Unavailable'
      : `${formatNumber(inbound)}:${formatNumber(outbound)}`;
  const quote = dataHealth.quotedMailboxReplyNoMatchingOutbound;
  const quotedShare =
    quote.availability !== 'available' ||
    quote.numerator == null ||
    quote.denominator == null ||
    quote.denominator === 0
      ? 'Unavailable'
      : `${formatPercent((quote.numerator / quote.denominator) * 100)} (${formatNumber(quote.numerator)}/${formatNumber(quote.denominator)})`;

  return (
    <section aria-labelledby="health-heading" className="grid gap-4">
      <div>
        <h2 id="health-heading" className="text-lg font-semibold">
          Data diagnostics
        </h2>
        <p className="text-muted-foreground text-sm">
          Compact indicators, not a completeness certificate or outage claim.
        </p>
      </div>
      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-muted-foreground text-xs">Last incoming</p>
            <p className="font-medium">{displayDate(dataHealth.lastObservedAt.inbound)}</p>
            <p className="text-muted-foreground text-xs">
              Inbound clock basis: {dataHealth.lastObservedBasis.inbound ?? 'Unknown'}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Last outgoing</p>
            <p className="font-medium">{displayDate(dataHealth.lastObservedAt.outbound)}</p>
            <p className="text-muted-foreground text-xs">
              Outbound clock basis: {dataHealth.lastObservedBasis.outbound ?? 'Unknown'}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Direction counts</p>
            <p className="font-medium">
              {inbound ?? 'Unknown'} in / {outbound ?? 'Unknown'} out
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Direction ratio</p>
            <p className="font-medium">{directionRatio}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Singleton share</p>
            <p className="font-medium">{singleton}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Unscorable events</p>
            <p className="font-medium">{formatNumber(dataHealth.unscorable.total)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Missing clocks</p>
            <p className="font-medium">{formatNumber(dataHealth.unscorable.missingClock)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Invalid clocks</p>
            <p className="font-medium">{formatNumber(dataHealth.unscorable.invalidClock)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Singleton quoted-mailbox-reply share</p>
            <p className="font-medium">{quotedShare}</p>
            <p className="text-muted-foreground text-xs">
              {quote.reason?.replaceAll('_', ' ') ?? 'Retained quote projection'}
            </p>
          </div>
        </CardContent>
      </Card>
      <p className="text-muted-foreground text-xs">
        Health snapshot cutoff: {displayDate(dataHealth.observationCutoff)}. Last-clock bases are
        shown with each observed clock.
      </p>
    </section>
  );
}

function ShadowScorecardSection({
  scorecard,
}: {
  scorecard: AdminDashboardShadowScorecard | undefined;
}) {
  if (!scorecard) {
    return (
      <section aria-labelledby="shadow-scorecard-heading" className="grid gap-3">
        <h2 id="shadow-scorecard-heading" className="text-lg font-semibold">
          Private prediction scorecard
        </h2>
        <div
          role="status"
          className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm"
        >
          Scorecard unavailable: no private shadow-store evidence was returned.
        </div>
      </section>
    );
  }

  const { counts, quality } = scorecard;
  const qualityText =
    quality.availability === 'available' && quality.correctRate !== null
      ? formatPercent(quality.correctRate * 100)
      : 'Unavailable';
  const usefulText =
    quality.availability === 'available' && quality.usefulRate !== null
      ? formatPercent(quality.usefulRate * 100)
      : 'Unavailable';
  const denominatorTextValue =
    quality.denominator === null ? 'Unknown' : formatNumber(quality.denominator);
  const admissionPopulation = scorecard.admissionPopulation;
  const admissionCounts = admissionPopulation?.counts;
  const admissionAvailable =
    admissionPopulation?.availability === 'available' &&
    typeof admissionCounts?.eligible === 'number' &&
    typeof admissionCounts?.admitted === 'number' &&
    typeof admissionCounts?.skipped === 'number' &&
    typeof admissionCounts?.denied === 'number' &&
    typeof admissionCounts?.pending === 'number';
  const admissionNumber = (value: number | null | undefined) =>
    value === null || value === undefined ? 'Unknown' : formatNumber(value);

  return (
    <section aria-labelledby="shadow-scorecard-heading" className="grid gap-4">
      <div>
        <h2 id="shadow-scorecard-heading" className="text-lg font-semibold">
          Private prediction scorecard
        </h2>
        <p className="text-muted-foreground text-sm">
          Internal {scorecard.evaluationMode.replaceAll('_', ' ')} observations. Predictions never
          create drafts, labels, read-state changes, or sends.
        </p>
      </div>
      <section aria-labelledby="shadow-admission-heading" className="grid gap-3">
        <div>
          <h3 id="shadow-admission-heading" className="text-base font-semibold">
            Admission coverage
          </h3>
          <p className="text-muted-foreground text-sm">
            Operational receipts are selected independently from sealed prediction outcomes.
          </p>
        </div>
        {!admissionAvailable ? (
          <div
            role="status"
            className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm"
          >
            Admission coverage unknown:{' '}
            {(admissionPopulation?.reason ?? 'population unavailable').replaceAll('_', ' ')}.
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Eligible admissions</CardTitle>
                  <CardDescription>Receipts eligible at the admission boundary.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">
                    {admissionNumber(admissionCounts?.eligible)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Admitted receipts</CardTitle>
                  <CardDescription>Receipts allowed into the private queue.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">
                    {admissionNumber(admissionCounts?.admitted)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Pending seal</CardTitle>
                  <CardDescription>
                    Admitted receipts without a sealed prediction by cutoff.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">
                    {admissionNumber(admissionCounts?.pending)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Skipped admissions</CardTitle>
                  <CardDescription>Eligible receipts skipped before queue work.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">
                    {admissionNumber(admissionCounts?.skipped)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Denied admissions</CardTitle>
                  <CardDescription>Receipts denied at the admission boundary.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">
                    {admissionNumber(admissionCounts?.denied)}
                  </p>
                </CardContent>
              </Card>
            </div>
            <p className="text-muted-foreground text-xs">
              Admission clock: created at ({admissionPopulation.provenance.selectionClock}). Window:{' '}
              {displayDate(admissionPopulation.provenance.windowStart)} to{' '}
              {displayDate(admissionPopulation.provenance.windowEnd)}. Observation cutoff:{' '}
              {displayDate(admissionPopulation.provenance.observationCutoff)}.{' '}
              {admissionPopulation.reason === 'no_admission_receipts'
                ? 'No admission receipts in this window; this is confirmed absence, not zero-filled unknown evidence.'
                : 'Pending seal is not assessment pending.'}
            </p>
          </>
        )}
      </section>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Admitted predictions</CardTitle>
            <CardDescription>Eligible private prediction jobs.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{formatNumber(counts.admitted)}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Sealed: {formatNumber(counts.sealed)} · unavailable:{' '}
              {formatNumber(counts.unavailable)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Reference outcomes</CardTitle>
            <CardDescription>Verified outbound observations and delays.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{formatNumber(counts.matched)}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Pending: {formatNumber(counts.pending)} · late: {formatNumber(counts.late)} ·
              unobserved: {formatNumber(counts.unobserved)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Label coverage</CardTitle>
            <CardDescription>Bound, unique labels only.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{formatNumber(counts.labelled)}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Scorable denominator: {formatNumber(counts.scorable)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Quality</CardTitle>
            <CardDescription>Gold labels are not inferred from missing evidence.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{qualityText}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Useful: {usefulText} · denominator: {denominatorTextValue}
            </p>
            {quality.availability !== 'available' ? (
              <p className="text-muted-foreground mt-1 text-xs">
                Unavailable: {(quality.reason ?? 'evidence unavailable').replaceAll('_', ' ')}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <p className="text-muted-foreground text-xs">
        Source: private shadow store. Missing is not zero; mode: {scorecard.evaluationMode}.
      </p>
    </section>
  );
}

function HostedAdminDashboardView({
  metrics,
  isStale,
  isError,
  selectedCohort,
  selectedWindow,
  selectedObservationCutoff,
  snapshotSelection,
}: {
  metrics: AdminDashboardMetrics;
  isStale: boolean;
  isError: boolean;
  selectedCohort: DashboardCohortId;
  selectedWindow: DashboardWindowPreset;
  selectedObservationCutoff?: string;
  snapshotSelection?: AdminDashboardSelection | null;
}) {
  const snapshotQuery = metrics.query;
  const selectedQuery = normalizeAdminDashboardSelection({
    cohortId: selectedCohort,
    window: selectedWindow,
    observationCutoff: selectedObservationCutoff,
  });
  const observedCutoff =
    normalizeAdminDashboardCutoff(snapshotQuery?.observationCutoff) ?? 'latest';
  const observedSelection = snapshotSelection ?? {
    cohortId: snapshotQuery?.cohortId ?? selectedQuery.cohortId,
    window: snapshotQuery?.window ?? selectedQuery.window,
    observationCutoff: snapshotQuery?.observationCutoff,
  };
  const selectedCutoff = selectedQuery.observationCutoff ?? 'latest';
  const observedSelectionCutoff = observedSelection.observationCutoff
    ? normalizeAdminDashboardCutoff(observedSelection.observationCutoff)
    : undefined;
  const selectionMismatch = Boolean(
    snapshotQuery &&
      (snapshotQuery.cohortId !== selectedQuery.cohortId ||
        snapshotQuery.window !== selectedQuery.window ||
        selectedQuery.observationCutoff !== observedSelectionCutoff),
  );
  const selectionLabel = `Selected cohort/window/cutoff: ${selectedQuery.cohortId} / ${selectedQuery.window} / ${selectedCutoff}. Observed cohort/window/cutoff: ${snapshotQuery?.cohortId ?? 'unknown'} / ${snapshotQuery?.window ?? 'unknown'} / ${observedCutoff}.`;
  const staleSelectionMessage = selectionMismatch
    ? `${selectionLabel} The selected query is refreshing; showing the observed snapshot.`
    : `${selectionLabel} Refreshing the selected query; the observed snapshot remains visible and is labelled as stale.`;
  const errorSelectionMessage = selectionMismatch
    ? `${selectionLabel} The selected query failed; showing the observed snapshot; no demo data is substituted.`
    : `${selectionLabel} Refresh failed; the observed snapshot remains visible as stale; no demo data is substituted.`;

  return (
    <SettingsCard
      title="Executive email dashboard"
      description="Observed email operations for the selected cohort and bounded window."
    >
      <div className="grid gap-6">
        {isError ? (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 rounded-lg border p-3 text-sm"
          >
            {errorSelectionMessage}
          </div>
        ) : isStale ? (
          <div
            role="status"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          >
            {staleSelectionMessage}
          </div>
        ) : null}
        <SnapshotNote metrics={metrics} />
        <TrafficSection metrics={metrics} />
        <ActivitySection activity={metrics.activity} />
        <FolderSection metrics={metrics} />
        <CorrespondentSection metrics={metrics} />
        <ServiceSection metrics={metrics} />
        <ShadowScorecardSection scorecard={metrics.shadowScorecard} />
        <DataHealthSection dataHealth={metrics.dataHealth} />
        {!metrics.traffic ? (
          <p className="text-muted-foreground text-xs">
            This response contains no executive traffic payload; legacy values are not used as a
            fallback.
          </p>
        ) : null}
      </div>
    </SettingsCard>
  );
}

function EmptyDashboardState({ title, message }: { title: string; message: string }) {
  return (
    <div role="status" className="rounded-lg border border-dashed p-6">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-muted-foreground mt-2 text-sm">{message}</p>
    </div>
  );
}

function cutoffInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(`${value}T23:59:59.999+02:00`).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export default function AdminDashboardPage() {
  const [cohortId, setCohortId] = useState<DashboardCohortId>('centurion');
  const [windowPreset, setWindowPreset] = useState<DashboardWindowPreset>('7d');
  const [observationCutoff, setObservationCutoff] = useState('');
  const queryInput = useMemo(
    () => ({
      cohortId,
      window: windowPreset,
      observationCutoff: cutoffInputToIso(observationCutoff),
    }),
    [cohortId, observationCutoff, windowPreset],
  );
  const { canAccess, isLoading, metrics, isError, isStale, source, snapshotSelection } =
    useAdminDashboardData(queryInput);
  const { isDownloading: isExporting, download: downloadExport } =
    useAdminDashboardExport(queryInput);

  if (isLoading && !metrics) {
    return (
      <EmptyDashboardState
        title="Loading executive dashboard"
        message="Retrieving the selected aggregate snapshot…"
      />
    );
  }

  if (isError && !metrics) {
    return (
      <EmptyDashboardState
        title="Dashboard unavailable"
        message="The selected aggregate snapshot could not be loaded. No demo data is shown."
      />
    );
  }

  if (!canAccess) {
    return <Navigate to="/settings/general" replace />;
  }

  if (source === 'demo') {
    return (
      <EmptyDashboardState
        title="Hosted dashboard required"
        message="Frontend demo data is not used for executive metrics. Connect an authorized hosted mailbox to view observed data."
      />
    );
  }

  if (!metrics) {
    return (
      <EmptyDashboardState
        title="Dashboard snapshot unavailable"
        message="No aggregate snapshot was returned for this selection. Try a different bounded window."
      />
    );
  }

  return (
    <div className="grid gap-4">
      <DashboardControls
        cohortId={cohortId}
        windowPreset={windowPreset}
        observationCutoff={observationCutoff}
        onCohortChange={setCohortId}
        onWindowChange={setWindowPreset}
        onCutoffChange={setObservationCutoff}
        onExport={() => void downloadExport()}
        exporting={isExporting}
      />
      <HostedAdminDashboardView
        metrics={metrics}
        isStale={isStale}
        isError={isError}
        selectedCohort={cohortId}
        selectedWindow={windowPreset}
        selectedObservationCutoff={queryInput.observationCutoff}
        snapshotSelection={snapshotSelection}
      />
    </div>
  );
}
