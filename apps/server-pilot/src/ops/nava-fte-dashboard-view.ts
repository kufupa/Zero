import type { NavaDashboard } from './nava-fte-dashboard.js';

export type NavaDashboardView = {
  header: string;
  meta: string;
  sections: string[];
  footer: string;
};

export const NAVA_BLUE_HEX = '#2F6BFF';
export const NAVA_THINKING_LEVEL = 'medium';

export const NAVA_BLUE_ANSI = '\x1b[38;2;47;107;255m';
export const NAVA_DIM_ANSI = '\x1b[38;2;139;147;167m';
export const NAVA_OK_ANSI = '\x1b[38;2;61;220;151m';
export const ANSI_RESET = '\x1b[0m';

/** 5-row dense block font — must read NAVA, not MAVA. Each glyph is width 7. */
const NAVA_GLYPH: Record<'N' | 'A' | 'V', readonly string[]> = {
  N: ['██   ██', '███  ██', '██ ███ ', '██  ███', '██   ██'],
  A: [' █████ ', '██   ██', '███████', '██   ██', '██   ██'],
  V: ['██   ██', '██   ██', '██   ██', ' ██ ██ ', '  ███  '],
};

export function navaWordmark(): string {
  const letters: Array<'N' | 'A' | 'V'> = ['N', 'A', 'V', 'A'];
  const rows = Array.from({ length: 5 }, () => '');
  for (let i = 0; i < letters.length; i++) {
    const glyph = NAVA_GLYPH[letters[i]!];
    for (let r = 0; r < 5; r++) {
      rows[r] += glyph[r] + (i < letters.length - 1 ? '  ' : '');
    }
  }
  const width = Math.max(...rows.map((line) => line.length));
  const bar = '█'.repeat(width);
  return `${NAVA_BLUE_ANSI}${[...rows, bar].join('\n')}${ANSI_RESET}`;
}

export function bar(share: string): string {
  const percent = Number.parseFloat(share);
  const width = Number.isFinite(percent) ? Math.max(1, Math.round(percent / 6.25)) : 1;
  return '█'.repeat(width).padEnd(16, '░');
}

function formatMinutes(value: number | null): string {
  return value === null ? 'n/a' : `${value}m`;
}

/** Legacy thin board (non-TTY / tests). Prefer `renderDemoStage` for the live TUI. */
export function renderDashboardSections(dashboard: NavaDashboard): NavaDashboardView {
  const asOfDay = dashboard.loaded.asOf.slice(0, 10);
  const mixLines = dashboard.mix
    .map(
      (row) =>
        ` ${bar(row.share)}  ${row.count.toString().padStart(4, ' ')}  ${row.share.padStart(5, ' ')}  ${row.className}`,
    )
    .join('\n');
  const lockLine = dashboard.hitlLocks.join(' · ');
  const toolLines = dashboard.tools
    .map(
      (row) =>
        ` ${row.rank}. ${row.tool}  ${row.evidence}  live=${String(row.live)} shadow=${String(row.shadow)}`,
    )
    .join('\n');
  const familyLines = dashboard.sourceFamilies
    .map(
      (row) =>
        ` ${bar(row.share)}  ${row.threads.toString().padStart(4, ' ')}  ${row.share.padStart(5, ' ')}  ${row.family}`,
    )
    .join('\n');
  const routeLines = dashboard.lunaRoutes
    .map(
      (row) =>
        ` ${row.threads.toString().padStart(4, ' ')}  ${row.share.padStart(5, ' ')}  ${row.route}`,
    )
    .join('\n');
  const drift = dashboard.inboundOnlyDrift
    ? `\n parser inbound-only ${dashboard.hours.inboundOnlyThreads} ≠ census ${dashboard.inboundOnlyDisplay.inboundOnlyThreads}`
    : '';

  return {
    header: [
      navaWordmark(),
      ` NAVA  corpus analysis · local demo`,
    ].join('\n'),
    meta: ` connected mailbox · asOf ${asOfDay} · ${dashboard.loaded.mailboxes} mailboxes · ${dashboard.loaded.messages} msgs · ${dashboard.loaded.threads} threads`,
    sections: [
      [
        ' Corpus',
        ` inbound ${dashboard.analysisMeta.inboundMessages}   outbound ${dashboard.analysisMeta.outboundMessages}   batches ${dashboard.analysisMeta.batches}   review ${dashboard.analysisMeta.model}`,
      ].join('\n'),
      [
        ' First-response',
        ` nEligible ${dashboard.hours.nEligibleFirstResponse}   median ${formatMinutes(dashboard.hours.medianFirstResponseMinutes)}   p90 ${formatMinutes(dashboard.hours.p90FirstResponseMinutes)}   inbound-only ${dashboard.inboundOnlyDisplay.inboundOnlyThreads}/${dashboard.inboundOnlyDisplay.threadCount} (${dashboard.inboundOnlyDisplay.sharePercent})`,
        ` ${dashboard.hours.caveat}${drift}`,
      ].join('\n'),
      [
        ' Attention mix (inbound messages n=2957)',
        mixLines,
        ` ${dashboard.mixCaption}`,
      ].join('\n'),
      [
        ' Source family (harmonized · exclusive · n=2403 threads)',
        familyLines,
        ' Partitions from Hermes source-family batches 001–018. Overlapping automation estimates are not summed here.',
      ].join('\n'),
      [
        ' Luna full-thread routes',
        routeLines,
        ` human-lock ${dashboard.lunaHumanLock.locked}/${dashboard.lunaHumanLock.threads}   low-confidence ${dashboard.analysisMeta.lowConfidenceThreads}   tool-demand rows ${dashboard.analysisMeta.toolDemandRows}`,
      ].join('\n'),
      [
        ' HITL',
        ` ${lockLine}`,
        ` ${dashboard.hitlNote}`,
        ' Ranked reads (shadow)',
        toolLines,
      ].join('\n'),
    ],
    footer: '↑↓ scroll · Enter continue · q quit',
  };
}
