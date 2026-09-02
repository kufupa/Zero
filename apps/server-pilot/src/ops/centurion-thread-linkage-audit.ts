import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type LinkageLayer = 'layer_a_header' | 'layer_b_signal' | 'layer_c_deterministic' | 'layer_d_llm' | 'unlinked';

export type DefensibleThreadRow = {
  threadId: string;
  day: string;
  intent: string;
  centurionOnly: boolean;
  responded: boolean;
  threadClass: string;
  responseSignals: readonly string[];
};

export type WalkthroughThreadRow = {
  threadId: string;
  msgs: number;
  in: number;
  out: number;
  workflow: string;
  handling: string;
  handler: string;
  finished: boolean;
  needsResponse: boolean;
};

export type StaffBriefThreadRow = {
  threadId: string;
  subject: string;
  day: string;
  intent: string;
};

export type ThreadLinkageAuditInput = {
  defensiblePath: string;
  walkthroughPath: string;
  staffBriefPath: string;
  outDir: string;
};

export type SubjectCluster = {
  normSubject: string;
  threadIds: readonly string[];
  spanDays: number;
};

export type ThreadLinkageRow = {
  threadId: string;
  responded: boolean;
  responseSignals: readonly string[];
  layer: LinkageLayer;
  linkReasons: readonly string[];
  subject?: string;
  normSubject?: string;
  msgs: number;
  handling?: string;
};

export type ThreadLinkageAuditReport = {
  generatedAt: string;
  sources: {
    defensible: string;
    walkthrough: string;
    staffBrief: string;
  };
  waterfall: {
    inThreadOnlyResponded: number;
    withCrossThreadConf: number;
    defensibleResponded: number;
    actionable: number;
    unanswered: number;
  };
  layerCounts: Record<LinkageLayer, number>;
  subjectClustersMultiThread: readonly SubjectCluster[];
  breakfastPackExemplars: readonly {
    threadId: string;
    normSubject: string;
    subject: string;
    day: string;
  }[];
  residualUnanswered: readonly string[];
  threads: readonly ThreadLinkageRow[];
};

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

/** RFC-style subject normalize for conversation-layer grouping (not ingest). */
export function normalizeConversationSubject(subject: string): string {
  let s = subject.trim().toLowerCase();
  for (let i = 0; i < 12; i++) {
    const stripped = s.replace(/^(re|fwd|fw|aw|sv)\s*:\s*/i, '').trim();
    const bracket = stripped.replace(/^\[[^\]]+\]\s*/i, '').trim();
    if (bracket === s) break;
    s = bracket;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Collapse Outlook-style spaced subjects ("B re akfast Pack Re quest").
 * Join tokens when many are very short — do not strip interior "re" (may be word fragment).
 */
export function collapseSpacedSubjectArtifacts(normSubject: string): string {
  const tokens = normSubject.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return normSubject;
  const shortCount = tokens.filter((t) => t.length <= 3).length;
  if (shortCount / tokens.length < 0.35) return normSubject;
  return tokens.join('');
}

function assignLayer(row: DefensibleThreadRow): { layer: LinkageLayer; reasons: string[] } {
  const signals = row.responseSignals;
  const reasons: string[] = [];

  if (signals.some((s) => s.includes('in_thread'))) {
    reasons.push('in_thread_outbound');
    return { layer: 'layer_a_header', reasons };
  }
  if (
    signals.some((s) =>
      ['cross_thread_conf', 'orphan_auto_confirm', 'orphan_centurion_human'].includes(s),
    )
  ) {
    reasons.push(...signals.filter((s) => !s.includes('quoted')));
    return { layer: 'layer_b_signal', reasons };
  }
  if (signals.some((s) => s.includes('quoted'))) {
    reasons.push(...signals.filter((s) => s.includes('quoted')));
    return { layer: 'layer_c_deterministic', reasons };
  }
  if (row.responded) {
    reasons.push('responded_without_listed_signals');
    return { layer: 'layer_d_llm', reasons };
  }
  return { layer: 'unlinked', reasons: ['no_response_signal'] };
}

export async function runCenturionThreadLinkageAudit(
  input: ThreadLinkageAuditInput,
): Promise<ThreadLinkageAuditReport> {
  const defensibleRaw = await readFile(input.defensiblePath, 'utf8');
  const walkthroughRaw = await readFile(input.walkthroughPath, 'utf8');
  const staffBriefRaw = await readFile(input.staffBriefPath, 'utf8');

  const defensible = parseJson<{ threads: DefensibleThreadRow[]; totals: Record<string, number> }>(
    defensibleRaw,
  );
  const walkthrough = parseJson<{ threads: WalkthroughThreadRow[] }>(walkthroughRaw);
  const staffBrief = parseJson<{ threads: StaffBriefThreadRow[] }>(staffBriefRaw);

  const walkById = new Map(walkthrough.threads.map((t) => [t.threadId, t]));
  const subjectById = new Map(staffBrief.threads.map((t) => [t.threadId, t.subject]));

  const threads: ThreadLinkageRow[] = defensible.threads.map((row) => {
    const walk = walkById.get(row.threadId);
    const subject = subjectById.get(row.threadId);
    const normSubject = subject ? normalizeConversationSubject(subject) : undefined;
    const { layer, reasons } = assignLayer(row);
    return {
      threadId: row.threadId,
      responded: row.responded,
      responseSignals: row.responseSignals,
      layer,
      linkReasons: reasons,
      subject,
      normSubject,
      msgs: walk?.msgs ?? 0,
      handling: walk?.handling,
    };
  });

  const layerCounts: Record<LinkageLayer, number> = {
    layer_a_header: 0,
    layer_b_signal: 0,
    layer_c_deterministic: 0,
    layer_d_llm: 0,
    unlinked: 0,
  };
  for (const t of threads) {
    layerCounts[t.layer] += 1;
  }

  const subjectGroups = new Map<string, { threadIds: string[]; days: Set<string> }>();
  for (const row of defensible.threads) {
    const subject = subjectById.get(row.threadId);
    if (!subject) continue;
    const norm = normalizeConversationSubject(subject);
    const collapsed = collapseSpacedSubjectArtifacts(norm);
    const key = collapsed.length >= 8 ? collapsed : norm;
    const bucket = subjectGroups.get(key) ?? { threadIds: [], days: new Set<string>() };
    bucket.threadIds.push(row.threadId);
    bucket.days.add(row.day);
    subjectGroups.set(key, bucket);
  }

  const subjectClustersMultiThread: SubjectCluster[] = [...subjectGroups.entries()]
    .filter(([, v]) => v.threadIds.length > 1)
    .map(([normSubject, v]) => ({
      normSubject,
      threadIds: v.threadIds,
      spanDays: v.days.size,
    }))
    .sort((a, b) => b.threadIds.length - a.threadIds.length);

  const breakfastPackExemplars = threads
    .filter((t) => {
      const s = (t.normSubject ?? '').toLowerCase();
      return s.includes('breakfast') && s.includes('pack');
    })
    .map((t) => ({
      threadId: t.threadId,
      normSubject: t.normSubject ?? '',
      subject: t.subject ?? '',
      day: defensible.threads.find((d) => d.threadId === t.threadId)?.day ?? '',
    }));

  const inThreadOnly = threads.filter(
    (t) =>
      t.responded &&
      t.responseSignals.length === 1 &&
      t.responseSignals[0]?.includes('in_thread'),
  ).length;

  const withCross = threads.filter(
    (t) => t.responded && t.responseSignals.some((s) => s.includes('cross_thread')),
  ).length;

  const defensibleResponded = threads.filter((t) => t.responded).length;

  const residualUnanswered = threads
    .filter((t) => !t.responded)
    .map((t) => t.threadId);

  return {
    generatedAt: new Date().toISOString(),
    sources: {
      defensible: input.defensiblePath,
      walkthrough: input.walkthroughPath,
      staffBrief: input.staffBriefPath,
    },
    waterfall: {
      inThreadOnlyResponded: inThreadOnly,
      withCrossThreadConf: withCross,
      defensibleResponded,
      actionable: defensible.totals.actionable ?? threads.length,
      unanswered: defensible.totals.unanswered ?? residualUnanswered.length,
    },
    layerCounts,
    subjectClustersMultiThread,
    breakfastPackExemplars,
    residualUnanswered,
    threads,
  };
}

export async function writeCenturionThreadLinkageAudit(
  input: ThreadLinkageAuditInput,
): Promise<{ reportPath: string; summaryPath: string }> {
  const report = await runCenturionThreadLinkageAudit(input);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(input.outDir, { recursive: true });
  const reportPath = path.join(input.outDir, 'thread-linkage-audit.json');
  const summaryPath = path.join(input.outDir, 'thread-linkage-audit-summary.md');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const topClusters = report.subjectClustersMultiThread.slice(0, 15)
    .map((c) => `- ${c.normSubject}: ${c.threadIds.length} threads, ${c.spanDays} days`)
    .join('\n');

  const summary = `# Centurion thread linkage audit

Generated: ${report.generatedAt}

## Waterfall (438 actionable)

| Metric | Count |
|--------|------:|
| In-thread-only responded (exclusive proxy) | ${report.waterfall.inThreadOnlyResponded} |
| With cross_thread signal | ${report.waterfall.withCrossThreadConf} |
| Defensible responded | ${report.waterfall.defensibleResponded} |
| Unanswered | ${report.waterfall.unanswered} |

## Layer assignment (actionable threads)

| Layer | Count |
|-------|------:|
| A header / in-thread | ${report.layerCounts.layer_a_header} |
| B cross-thread signals | ${report.layerCounts.layer_b_signal} |
| C quoted / deterministic UI link | ${report.layerCounts.layer_c_deterministic} |
| D LLM residual | ${report.layerCounts.layer_d_llm} |
| Unlinked unanswered | ${report.layerCounts.unlinked} |

## Subject clusters (>1 thread_id)

${topClusters}

## Breakfast pack exemplars

${report.breakfastPackExemplars.map((e) => `- ${e.threadId} · ${e.normSubject}`).join('\n') || 'none in actionable set'}

## Artifacts

- Full JSON: \`${reportPath}\`
`;

  await writeFile(summaryPath, summary, 'utf8');
  return { reportPath, summaryPath };
}
