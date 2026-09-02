import type { NavaHoursStats } from './nava-fte-hours.js';

export const NAVA_FROZEN_LOADED = {
  mailboxes: 2,
  messages: 3268,
  threads: 2403,
  asOf: '2026-08-25T22:24:55.657Z',
} as const;

export const NAVA_FROZEN_INBOUND_ONLY = {
  inboundOnlyThreads: 2102,
  threadCount: 2403,
  sharePercent: '87.5%',
} as const;

export const NAVA_FROZEN_MIX = [
  { className: 'stay-human-other', count: 1069, share: '36.2%' },
  { className: 'stay-human-at-risk', count: 841, share: '28.4%' },
  { className: 'stay-human-groups', count: 446, share: '15.1%' },
  { className: 'stay-human-new-bookings', count: 419, share: '14.2%' },
  { className: 'unknown', count: 99, share: '3.3%' },
  { className: 'file-spam', count: 78, share: '2.6%' },
  { className: 'file-ops', count: 5, share: '0.2%' },
] as const;

export const NAVA_FROZEN_MIX_TOTAL = 2957;

export const NAVA_FROZEN_HITL_LOCKS = [
  'failure',
  'payment',
  'policy',
  'cancellation-fee',
  'complaint',
  'security',
  'VIP/privacy',
  'documents',
  'low-confidence',
  'SLA/unpaid',
] as const;

export const NAVA_FROZEN_LUNA_HUMAN_LOCK = {
  locked: 1134,
  threads: 2403,
} as const;

export const NAVA_FROZEN_TOOLS = [
  {
    rank: 1,
    tool: 'hms_find_reservation',
    evidence: 'confirmation_number 1094 threads',
    live: false,
    shadow: false,
  },
  {
    rank: 2,
    tool: 'hms_list_documents',
    evidence: 'document_delivery 1015 threads',
    live: false,
    shadow: false,
  },
  {
    rank: 3,
    tool: 'hms_find_reservation (status)',
    evidence: 'reservation_status 947 threads',
    live: false,
    shadow: false,
  },
  {
    rank: 4,
    tool: 'hms_read_folio',
    evidence: 'payment_deposit 892 threads',
    live: false,
    shadow: false,
  },
  {
    rank: 5,
    tool: 'hms_quote_stay',
    evidence: 'rate_quote 849 threads; bookable=false',
    live: false,
    shadow: false,
  },
] as const;

/** Harmonized exclusive partition from Hermes source-family batches 001–018 (sum=2403). */
export const NAVA_FROZEN_SOURCE_FAMILIES = [
  { family: 'security_quarantine', threads: 526, share: '21.9%' },
  { family: 'payment_gateway_pop', threads: 506, share: '21.1%' },
  { family: 'confirmation_document', threads: 329, share: '13.7%' },
  { family: 'ota_channel', threads: 309, share: '12.9%' },
  { family: 'synxis_integration', threads: 155, share: '6.5%' },
  { family: 'night_audit_internal', threads: 154, share: '6.4%' },
  { family: 'reservation_pms_notice', threads: 152, share: '6.3%' },
  { family: 'unknown', threads: 88, share: '3.7%' },
  { family: 'vendor_newsletter', threads: 86, share: '3.6%' },
  { family: 'human_external_request', threads: 63, share: '2.6%' },
  { family: 'bounce_delivery', threads: 35, share: '1.5%' },
] as const;

export const NAVA_FROZEN_LUNA_ROUTES = [
  { route: 'ops', threads: 1097, share: '45.7%' },
  { route: 'resolved', threads: 647, share: '26.9%' },
  { route: 'spam', threads: 397, share: '16.5%' },
  { route: 'unknown', threads: 152, share: '6.3%' },
  { route: 'at-risk', threads: 110, share: '4.6%' },
] as const;

export const NAVA_FROZEN_ANALYSIS_META = {
  batches: 18,
  model: 'Azure gpt-5.6-luna',
  inboundMessages: 2957,
  outboundMessages: 311,
  lowConfidenceThreads: 68,
  toolDemandRows: 1409,
} as const;

export type NavaDashboard = {
  loaded: typeof NAVA_FROZEN_LOADED;
  hours: Pick<
    NavaHoursStats,
    | 'nEligibleFirstResponse'
    | 'medianFirstResponseMinutes'
    | 'p90FirstResponseMinutes'
    | 'inboundOnlyThreads'
    | 'caveat'
  >;
  inboundOnlyDisplay: typeof NAVA_FROZEN_INBOUND_ONLY;
  inboundOnlyDrift: boolean;
  mix: typeof NAVA_FROZEN_MIX;
  mixTotal: typeof NAVA_FROZEN_MIX_TOTAL;
  mixCaption: string;
  hitlLocks: typeof NAVA_FROZEN_HITL_LOCKS;
  lunaHumanLock: typeof NAVA_FROZEN_LUNA_HUMAN_LOCK;
  hitlNote: string;
  tools: typeof NAVA_FROZEN_TOOLS;
  sourceFamilies: typeof NAVA_FROZEN_SOURCE_FAMILIES;
  lunaRoutes: typeof NAVA_FROZEN_LUNA_ROUTES;
  analysisMeta: typeof NAVA_FROZEN_ANALYSIS_META;
};

export function mixTotal(rows: readonly { count: number }[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

export function buildDashboard(hours: NavaHoursStats): NavaDashboard {
  const inboundOnlyDrift =
    hours.inboundOnlyThreads !== NAVA_FROZEN_INBOUND_ONLY.inboundOnlyThreads;
  return {
    loaded: NAVA_FROZEN_LOADED,
    hours: {
      nEligibleFirstResponse: hours.nEligibleFirstResponse,
      medianFirstResponseMinutes: hours.medianFirstResponseMinutes,
      p90FirstResponseMinutes: hours.p90FirstResponseMinutes,
      inboundOnlyThreads: hours.inboundOnlyThreads,
      caveat: hours.caveat,
    },
    inboundOnlyDisplay: NAVA_FROZEN_INBOUND_ONLY,
    inboundOnlyDrift,
    mix: NAVA_FROZEN_MIX,
    mixTotal: NAVA_FROZEN_MIX_TOTAL,
    mixCaption:
      'Mix is inbound messages (n=2957). Loaded 3268 is all messages. Unknown 99 is inbound messages, not Luna 152 unknown-route threads.',
    hitlLocks: NAVA_FROZEN_HITL_LOCKS,
    lunaHumanLock: NAVA_FROZEN_LUNA_HUMAN_LOCK,
    hitlNote: 'security quarantine ≠ spam',
    tools: NAVA_FROZEN_TOOLS,
    sourceFamilies: NAVA_FROZEN_SOURCE_FAMILIES,
    lunaRoutes: NAVA_FROZEN_LUNA_ROUTES,
    analysisMeta: NAVA_FROZEN_ANALYSIS_META,
  };
}

function formatMinutes(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

export function renderDashboardMarkdown(dashboard: NavaDashboard): string {
  const mixRows = dashboard.mix
    .map((row) => `| ${row.className} | ${row.count} | ${row.share} |`)
    .join('\n');
  const familyRows = dashboard.sourceFamilies
    .map((row) => `| ${row.family} | ${row.threads} | ${row.share} |`)
    .join('\n');
  const routeRows = dashboard.lunaRoutes
    .map((row) => `| ${row.route} | ${row.threads} | ${row.share} |`)
    .join('\n');
  const toolRows = dashboard.tools
    .map(
      (row) =>
        `| ${row.rank} | \`${row.tool}\` | ${row.evidence} | live=${row.live} shadow=${row.shadow} |`,
    )
    .join('\n');
  const drift = dashboard.inboundOnlyDrift
    ? `\nParser inbound-only threads: ${dashboard.hours.inboundOnlyThreads} (differs from census ${dashboard.inboundOnlyDisplay.inboundOnlyThreads}).\n`
    : '';
  return [
    '# Nava FTE dashboard',
    '',
    '## Loaded',
    '',
    `- Mailboxes: ${dashboard.loaded.mailboxes}`,
    `- Messages: ${dashboard.loaded.messages} (all directions)`,
    `- Threads: ${dashboard.loaded.threads}`,
    `- asOf: ${dashboard.loaded.asOf}`,
    '',
    '## First-response latency',
    '',
    `- nEligibleFirstResponse: ${dashboard.hours.nEligibleFirstResponse}`,
    `- medianFirstResponseMinutes: ${formatMinutes(dashboard.hours.medianFirstResponseMinutes)}`,
    `- p90FirstResponseMinutes: ${formatMinutes(dashboard.hours.p90FirstResponseMinutes)}`,
    `- inbound-only: ${dashboard.inboundOnlyDisplay.inboundOnlyThreads} / ${dashboard.inboundOnlyDisplay.threadCount} (${dashboard.inboundOnlyDisplay.sharePercent})`,
    `- caveat: ${dashboard.hours.caveat}`,
    drift,
    '## Attention mix (inbound messages)',
    '',
    '| Class | Count | Share |',
    '| --- | ---: | ---: |',
    mixRows,
    `| **Total** | **${dashboard.mixTotal}** | **100.0%** |`,
    '',
    dashboard.mixCaption,
    '',
    '## Source family (harmonized exclusive)',
    '',
    '| Family | Threads | Share |',
    '| --- | ---: | ---: |',
    familyRows,
    '',
    '## Luna full-thread routes',
    '',
    '| Route | Threads | Share |',
    '| --- | ---: | ---: |',
    routeRows,
    '',
    '## HITL locks',
    '',
    dashboard.hitlLocks.map((name) => `- ${name}`).join('\n'),
    '',
    `- Luna human-lock: ${dashboard.lunaHumanLock.locked} / ${dashboard.lunaHumanLock.threads}`,
    `- ${dashboard.hitlNote}`,
    '',
    '## Ranked existing reads',
    '',
    '| Rank | Tool | Evidence | Flags |',
    '| --- | --- | --- | --- |',
    toolRows,
    '',
  ].join('\n');
}
