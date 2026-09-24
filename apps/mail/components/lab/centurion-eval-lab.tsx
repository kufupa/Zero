import {
  buildLabNavItems,
  countEmptyOptionals,
  filterLabRows,
  interestingFacts,
  LAB_FACETS,
  labReviewSchemaFor,
  projectLabFills,
  proposedActionFacts,
  resolveProposedActions,
  ACTION_PALETTE,
  outcomeCounts,
  rewriteDateSpans,
  sortRequiredFirst,
  spansForPaint,
  splitQuotedHistory,
  THREAD_OUTCOME_COPY,
  valuesToSpans,
  type LabIndex,
  type LabRow,
  type LabSpan,
  type ThreadOutcome,
} from '@/lib/lab/centurion-eval';
import type { LabIndexLoadError } from '@/lib/lab/load-centurion-index';
import { getMailRowSelectionClasses } from '@/lib/mail/mail-row-selection';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useEffect, useMemo, useState } from 'react';
import { VList } from 'virtua';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function highlightedHtml(text: string, row: LabRow, side: 'inbound' | 'gold', tool: string): string {
  const fromValues: LabSpan[] = [];
  if (side === 'inbound') {
    for (const action of resolveProposedActions(row).filter(
      (item) => item.status === 'live' || item.status === 'needs_human',
    )) {
      fromValues.push(...valuesToSpans(text, action.request, 'inbound', action.tool, action.colorIndex));
    }
  }
  const painted = spansForPaint(rewriteDateSpans(text, [...fromValues, ...row.spans]), tool);
  let cursor = 0;
  let out = '';
  const applicable = painted
    .filter((span) => span.side === side && span.start >= 0 && span.end <= text.length && span.start < span.end)
    .sort((a, b) => a.start - b.start);
  for (const span of applicable) {
    if (span.start < cursor) continue;
    const cls =
      side === 'inbound'
        ? `lab-span-action-${span.colorIndex ?? 0}`
        : span.field === 'channelAuto'
          ? 'lab-span-gold-auto'
          : 'lab-span-gold';
    out += escapeHtml(text.slice(cursor, span.start));
    out += `<mark class="${cls}" data-field="${span.field}">${escapeHtml(text.slice(span.start, span.end))}</mark>`;
    cursor = span.end;
  }
  out += escapeHtml(text.slice(cursor));
  return out;
}

function snippetOf(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 140 ? `${compact.slice(0, 137)}…` : compact;
}

function SchemaFieldList({
  testId,
  heading,
  schema,
  filled,
  tone,
}: {
  testId: string;
  heading: string;
  schema: { properties?: Record<string, unknown>; required?: string[] };
  filled: Record<string, unknown>;
  tone: 'request' | 'response';
}) {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const keys = sortRequiredFirst(properties, required);
  const empties = countEmptyOptionals(properties, required, filled);
  return (
    <section className={cn('space-y-2', tone === 'request' ? 'lab-schema-request' : 'lab-schema-response')} data-testid={testId}>
      <h3 className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">{heading}</h3>
      <ul className="space-y-2">
        {keys.map((key) => {
          const isRequired = required.includes(key);
          const value = filled[key];
          const empty = value == null || value === '';
          if (empty && !isRequired && tone === 'response') return null;
          return (
            <li key={key} className="border-border/60 rounded-lg border px-3 py-2" data-required={isRequired ? 'true' : 'false'}>
              <div className={cn('text-[12px]', isRequired ? 'font-medium' : 'text-muted-foreground')}>
                {key}
                {isRequired ? ' *' : ''}
              </div>
              <div
                className={cn(
                  'mt-1 break-words text-[13px]',
                  empty ? 'text-muted-foreground' : tone === 'request' ? 'lab-fill-request rounded px-1' : 'lab-fill-response rounded px-1',
                )}
              >
                {empty ? '∅' : typeof value === 'string' ? value : JSON.stringify(value)}
              </div>
            </li>
          );
        })}
      </ul>
      {testId === 'lab-schema-input' ? (
        <p className="text-muted-foreground text-xs" data-testid="empty-optional-count">
          empty optional {empties.emptyOptional.length}
        </p>
      ) : null}
    </section>
  );
}

function ProposedPane({
  row,
  selectedTool,
  actionIndex,
  onActionIndex,
}: {
  row: LabRow;
  selectedTool: string | null;
  actionIndex: number;
  onActionIndex: (index: number) => void;
}) {
  const actions = resolveProposedActions(row);
  const live = actions.filter((item) => item.status === 'live' || item.status === 'needs_human');
  const folded = actions.filter((item) => item.status === 'done' || item.status === 'superseded');
  const toolMatch = selectedTool ? live.findIndex((item) => item.tool === selectedTool) : -1;
  const current = live[toolMatch >= 0 ? toolMatch : actionIndex] || live[0] || null;
  const tool = current?.tool || selectedTool || row.tools[0] || 'hms_find_reservation';
  const schema = labReviewSchemaFor(tool);
  const fills = projectLabFills(row, tool, actionIndex, current);
  const interesting = interestingFacts(row.staffFilledAbsentFromInbound);
  const skipReason =
    row.otherDesk
      ? `Other desk: ${row.otherDesk}`
      : row.threadOutcome === 'no_reply_owed'
        ? THREAD_OUTCOME_COPY.no_reply_owed
        : row.threadOutcomeCopy;

  return (
    <aside className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4" data-testid="lab-io-pane">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Proposed</h2>
        <span className="text-muted-foreground text-[11px]" data-testid="lab-action-live-count">
          {live.length}
        </span>
      </div>
      {live.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center" data-testid="lab-action-empty">
          <p className="text-sm font-medium">No HMS write for this mail</p>
          <p className="text-muted-foreground text-[12px]">{skipReason}</p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="lab-action-stack">
          {live.map((action, index) => {
            const selected = action === current;
            const palette = ACTION_PALETTE[action.colorIndex % ACTION_PALETTE.length]!;
            const facts = proposedActionFacts(action.request);
            return (
              <div
                key={`${action.tool}-${index}`}
                data-testid={`lab-action-live-${index}`}
                className={cn(
                  'w-full min-h-11 rounded-xl border px-3 py-2 text-left transition-colors',
                  selected ? 'bg-offsetLight dark:bg-primary/10' : 'opacity-70',
                )}
                style={{ borderColor: palette.mark }}
              >
                <button type="button" className="w-full text-left" onClick={() => onActionIndex(index)}>
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: palette.mark }} />
                    <span className="text-[13px] font-medium">{action.title}</span>
                    {action.status === 'needs_human' ? (
                      <span className="text-muted-foreground ml-auto text-[10px] uppercase">needs human</span>
                    ) : null}
                  </div>
                  {facts ? <p className="text-muted-foreground mt-0.5 text-[12px]">{facts}</p> : null}
                </button>
                {selected ? (
                  <div className="mt-3 space-y-3">
                    <SchemaFieldList
                      testId="lab-schema-input"
                      heading="Input"
                      schema={schema.input}
                      filled={fills.input}
                      tone="request"
                    />
                    {Object.values(fills.output).some((value) => value != null && value !== '') ? (
                      <SchemaFieldList
                        testId="lab-schema-staff-did"
                        heading="Staff did"
                        schema={schema.output}
                        filled={fills.output}
                        tone="response"
                      />
                    ) : (
                      <section className="lab-schema-response space-y-2" data-testid="lab-schema-staff-did">
                        <h3 className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">Staff did</h3>
                        <p className="text-muted-foreground text-[12px]" data-testid="lab-staff-did-missing">
                          No captured PMS response in gold
                        </p>
                      </section>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {folded.length ? (
        <details className="border-border/60 rounded-lg border px-3 py-2" data-testid="lab-action-already">
          <summary className="text-muted-foreground cursor-pointer text-[12px]">Already done {folded.length}</summary>
          <ul className="mt-2 space-y-1 text-[12px]">
            {folded.map((action, index) => (
              <li key={`${action.tool}-done-${index}`}>
                {action.title}
                {proposedActionFacts(action.request) ? ` · ${proposedActionFacts(action.request)}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {interesting.length ? (
        <div data-testid="interesting-fact" className="flex flex-wrap gap-1">
          {interesting.map((field) => (
            <span key={field} className="text-muted-foreground text-[11px]">
              {field}
            </span>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function LabIndexLoadingShell() {
  return (
    <div className="flex h-[calc(100dvh-10px)] w-full items-center justify-center" data-testid="centurion-eval-lab">
      <p className="text-muted-foreground text-sm" data-testid="lab-index-loading">
        Loading live lab index…
      </p>
    </div>
  );
}

function LabIndexErrorShell({ error }: { error: LabIndexLoadError }) {
  return (
    <div className="flex h-full items-center justify-center p-8" data-testid="centurion-eval-lab">
      <div className="border-border bg-panelLight dark:bg-panelDark max-w-lg rounded-2xl border p-6 shadow-sm" data-testid="lab-index-error">
        <h1 className="text-base font-semibold">Live lab index failed</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          HTTP {error.status}. {error.message}. rows: 0. Synthetic fixture is not shown.
        </p>
      </div>
    </div>
  );
}

function MessageCard({
  label,
  subject,
  text,
  html,
  channelAuto,
  testId,
  bodyTestId,
  quoted,
}: {
  label: string;
  subject?: string | null;
  text: string;
  html: string;
  channelAuto?: boolean;
  testId?: string;
  bodyTestId?: string;
  quoted?: string | null;
}) {
  return (
    <article
      className="border-border bg-background mb-3 rounded-xl border px-4 py-3"
      data-testid={testId}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        {subject ? <span className="text-muted-foreground text-[13px]">{subject}</span> : null}
        {channelAuto ? (
          <span className="rounded-full bg-pink-200 px-2 py-0.5 text-[10px] text-pink-900" data-testid="channel-auto-chip">
            channelAuto
          </span>
        ) : null}
      </div>
      <div
        className="whitespace-pre-wrap break-words text-[15px] leading-6"
        data-testid={bodyTestId}
        dangerouslySetInnerHTML={{ __html: html || escapeHtml(text) }}
      />
      {quoted ? (
        <details className="border-border/60 mt-3 rounded-lg border px-3 py-2" data-testid="lab-quoted-history">
          <summary className="text-muted-foreground cursor-pointer text-[12px]">Quoted inbound</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px]">{quoted}</pre>
        </details>
      ) : null}
    </article>
  );
}

export function CenturionEvalLab({
  index,
  error,
  selectedTool: selectedToolProp = null,
  onToolChange,
}: {
  index?: LabIndex;
  error?: LabIndexLoadError;
  selectedTool?: string | null;
  onToolChange?: (tool: string | null) => void;
}) {
  if (error) {
    return <LabIndexErrorShell error={error} />;
  }
  if (!index) {
    return <LabIndexLoadingShell />;
  }

  return <CenturionEvalLabReady index={index} selectedTool={selectedToolProp} onToolChange={onToolChange} />;
}

function CenturionEvalLabReady({
  index,
  selectedTool: selectedToolProp = null,
  onToolChange,
}: {
  index: LabIndex;
  selectedTool?: string | null;
  onToolChange?: (tool: string | null) => void;
}) {
  const navItems = useMemo(() => buildLabNavItems(index), [index]);
  const outcomes = useMemo(() => outcomeCounts(index), [index]);
  const [tool, setTool] = useState<string | null>(selectedToolProp);
  const [outcome, setOutcome] = useState<ThreadOutcome | null>(null);
  const [facet, setFacet] = useState<string | null>(null);
  const [proposed, setProposed] = useState<'live' | 'skip' | null>(null);
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const filtered = filterLabRows(index, { tool, outcome, facet, proposed });
    const needle = query.trim().toLowerCase();
    if (!needle) return filtered;
    return filtered.filter((row) => {
      const hay = `${row.inbound.subject ?? ''} ${row.inbound.textBody} ${row.gold?.textBody ?? ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [index, tool, outcome, facet, proposed, query]);
  const [selectedId, setSelectedId] = useState(rows[0]?.inboundId ?? index.rows[0]?.inboundId);
  const selected = rows.find((row) => row.inboundId === selectedId) ?? rows[0];

  useEffect(() => {
    if (selectedToolProp) setTool(selectedToolProp);
  }, [selectedToolProp]);

  useEffect(() => {
    if (selected && rows.some((row) => row.inboundId === selected.inboundId)) return;
    setSelectedId(rows[0]?.inboundId);
  }, [rows, selected]);

  const chooseTool = (next: string | null) => {
    setTool(next);
    onToolChange?.(next);
    const match = filterLabRows(index, { tool: next, outcome, facet, proposed })[0];
    if (match) {
      setSelectedId(match.inboundId);
      const live = resolveProposedActions(match).filter(
        (item) => item.status === 'live' || item.status === 'needs_human',
      );
      const idx = next ? live.findIndex((item) => item.tool === next) : 0;
      setActionIndex(idx >= 0 ? idx : 0);
    }
  };

  const goldAuto = Boolean(selected?.gold?.channelAuto || selected?.channelAuto);
  const actions = selected ? resolveProposedActions(selected) : [];
  const liveActions = actions.filter((item) => item.status === 'live' || item.status === 'needs_human');
  const [actionIndex, setActionIndex] = useState(0);
  useEffect(() => {
    if (!selected) {
      setActionIndex(0);
      return;
    }
    const live = resolveProposedActions(selected).filter(
      (item) => item.status === 'live' || item.status === 'needs_human',
    );
    const idx = tool ? live.findIndex((item) => item.tool === tool) : 0;
    setActionIndex(idx >= 0 ? idx : 0);
  }, [selected?.inboundId, tool]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        const current = rows.findIndex((row) => row.inboundId === selected?.inboundId);
        const next = event.key === 'j' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1);
        const row = rows[next];
        if (row) setSelectedId(row.inboundId);
      }
      if (event.key >= '1' && event.key <= '4') {
        setActionIndex(Number(event.key) - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selected?.inboundId]);
  const currentAction = liveActions[Math.min(actionIndex, Math.max(liveActions.length - 1, 0))] || null;
  const activeTool = tool || currentAction?.tool || selected?.tools[0] || 'hms_find_reservation';

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="centurion-eval-lab">
      <style>{`
        .lab-span-action-0 { background: #fbbf24; color: #78350f; padding: 0 0.15em; border-radius: 2px; }
        .lab-span-action-1 { background: #2dd4bf; color: #115e59; padding: 0 0.15em; border-radius: 2px; }
        .lab-span-action-2 { background: #c4b5fd; color: #5b21b6; padding: 0 0.15em; border-radius: 2px; }
        .lab-span-action-3 { background: #a3e635; color: #3f6212; padding: 0 0.15em; border-radius: 2px; }
        .lab-span-gold { background: #93c5fd; color: #1e3a8a; padding: 0 0.15em; border-radius: 2px; }
        .lab-span-gold-auto { background: #93c5fd; color: #1e3a8a; padding: 0 0.15em; border-radius: 2px; }
        .lab-fill-request { background: #fbbf24; color: #78350f; }
        .lab-fill-response { background: #93c5fd; color: #1e3a8a; }
      `}</style>
      <div className="rounded-inherit z-5 relative flex min-h-0 flex-1 p-0 md:mr-0.5 md:mt-1">
        <ResizablePanelGroup direction="horizontal" className="rounded-inherit overflow-hidden">
          <ResizablePanel
            defaultSize={32}
            minSize={22}
            maxSize={48}
            className="bg-panelLight dark:bg-panelDark mb-1 min-w-0 shadow-sm md:mr-[3px] md:rounded-2xl lg:flex lg:h-[calc(100dvh-8px)] lg:shadow-sm"
          >
            <div className="flex w-full min-h-0 flex-col md:h-[calc(100dvh-10px)]">
              <div className="z-15 sticky top-0 shrink-0 p-4 pb-0">
                <div className="flex items-center justify-between gap-2">
                  <h1 className="text-[13px] font-medium">Centurion lab</h1>
                  <span className="text-muted-foreground text-[11px]" data-testid="lab-live-count">
                    {index.rows.length} inbounds
                  </span>
                </div>
                <input
                  data-testid="lab-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search"
                  className="border-input bg-background mt-2 h-10 w-full rounded-lg border px-3 text-[13px]"
                />
                <div className="mt-2 flex flex-wrap gap-1" data-testid="lab-proposed-filter">
                  {(['live', 'skip'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      data-testid={`proposed-${item}`}
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px]',
                        proposed === item ? 'bg-primary/15' : 'bg-muted',
                      )}
                      onClick={() => {
                        const next = proposed === item ? null : item;
                        setProposed(next);
                        const match = filterLabRows(index, { tool, outcome, facet, proposed: next })[0];
                        if (match) setSelectedId(match.inboundId);
                      }}
                    >
                      {item === 'live' ? 'Has Proposed' : 'Skip'}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1" data-testid="lab-outcome-chips">
                  {outcomes.map((item) => (
                    <button
                      key={item.outcome}
                      type="button"
                      data-testid={`outcome-${item.outcome}`}
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px]',
                        outcome === item.outcome ? 'bg-primary/15' : 'bg-muted',
                      )}
                      onClick={() => {
                        const next = outcome === item.outcome ? null : item.outcome;
                        setOutcome(next);
                        const match = filterLabRows(index, { tool, outcome: next, facet, proposed })[0];
                        if (match) setSelectedId(match.inboundId);
                      }}
                    >
                      {item.outcome} {item.count}
                    </button>
                  ))}
                </div>
                <div className="mt-1 hidden flex-wrap gap-1" data-testid="lab-facet-chips">
                  {LAB_FACETS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      data-testid={`facet-${item}`}
                      className={cn('rounded-full px-2 py-0.5 text-[10px]', facet === item ? 'bg-primary/15' : 'bg-muted')}
                      onClick={() => {
                        const next = facet === item ? null : item;
                        setFacet(next);
                        const match = filterLabRows(index, { tool, outcome, facet: next, proposed })[0];
                        if (match) setSelectedId(match.inboundId);
                      }}
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <nav className="mt-2 hidden" data-testid="lab-tool-list">
                  {navItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={item.id === 'all-threads' ? 'tool-all-threads' : `tool-${item.id}`}
                      onClick={() => chooseTool(item.id === 'all-threads' ? null : item.id)}
                    >
                      {item.title} {item.subtitle}
                    </button>
                  ))}
                </nav>
              </div>
              {rows.length === 0 ? (
                <p className="text-muted-foreground p-4 text-sm" data-testid="lab-empty-tool">
                  No emails for this tool.
                </p>
              ) : (
                <div
                  className="z-1 relative min-h-0 flex-1 overflow-hidden pt-2 md:h-[calc(100dvh-4rem)]"
                  data-testid="lab-thread-list"
                >
                  <VList
                    className="scrollbar scrollbar-w-1 scrollbar-thumb-accent/40 scrollbar-track-transparent hover:scrollbar-thumb-accent scrollbar-thumb-rounded-full h-full overflow-x-hidden"
                    count={rows.length}
                    overscan={12}
                  >
                    {(index) => {
                      const row = rows[index]!;
                      const active = row.inboundId === selected?.inboundId;
                      const verbs = resolveProposedActions(row).filter(
                        (item) => item.status === 'live' || item.status === 'needs_human',
                      );
                      return (
                        <button
                          key={row.inboundId}
                          type="button"
                          onClick={() => setSelectedId(row.inboundId)}
                          className={cn(
                            'hover:bg-offsetLight dark:hover:bg-primary/5 mx-1 mb-1 flex w-[calc(100%-0.5rem)] flex-col gap-0.5 rounded-lg border border-transparent px-4 py-2.5 text-left transition-colors',
                            getMailRowSelectionClasses({
                              isMailSelected: active,
                              isMailBulkSelected: false,
                              isKeyboardFocused: false,
                              isKeyboardNavigationActive: false,
                            }),
                          )}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-[13px] font-medium">{row.inbound.subject || row.inboundId}</span>
                            <span className="text-muted-foreground shrink-0 text-[10px]">{row.threadOutcome}</span>
                          </span>
                          {verbs.length ? (
                            <span className="flex flex-wrap gap-1" data-testid="lab-row-verbs">
                              {verbs.slice(0, 3).map((action) => {
                                const palette = ACTION_PALETTE[action.colorIndex % ACTION_PALETTE.length]!;
                                return (
                                  <span
                                    key={`${row.inboundId}-${action.tool}-${action.colorIndex}`}
                                    className="rounded-full px-1.5 py-0.5 text-[10px]"
                                    style={{ background: palette.mark, color: palette.ink }}
                                  >
                                    {action.title}
                                  </span>
                                );
                              })}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-[10px]" data-testid="lab-row-skip">
                              No HMS write
                            </span>
                          )}
                          <span className="text-muted-foreground line-clamp-2 text-[12px]">{snippetOf(row.inbound.textBody)}</span>
                        </button>
                      );
                    }}
                  </VList>
                </div>
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle className="mr-0.5 hidden w-2 shrink-0 md:flex md:opacity-60 md:hover:opacity-100" />
          <ResizablePanel
            defaultSize={43}
            minSize={30}
            className="bg-panelLight dark:bg-panelDark mb-1 mr-0.5 min-w-0 rounded-2xl shadow-sm lg:h-[calc(100dvh-8px)]"
          >
            {selected ? (
              <div className="relative flex min-h-0 h-[calc(100dvh-10px)] flex-col" data-testid="lab-reading-pane">
                <div className="border-border/40 shrink-0 border-b px-4 py-3">
                  <h2 className="text-[15px] font-semibold">{selected.inbound.subject || selected.inboundId}</h2>
                  <p className="text-muted-foreground mt-1 text-[12px]">{selected.threadOutcomeCopy}</p>
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                  <ScrollArea className="min-h-0 flex-1" type="auto">
                    <div className="px-4 py-3">
                      <MessageCard
                        label="Inbound"
                        subject={selected.inbound.subject}
                        text={selected.inbound.textBody}
                        html={highlightedHtml(selected.inbound.textBody, selected, 'inbound', activeTool)}
                        testId="lab-inbound-card"
                        bodyTestId="lab-inbound-body"
                      />
                      {(selected.priorInbounds || []).map((prior) => (
                        <article key={prior.id} className="border-border bg-background mb-3 rounded-xl border px-4 py-3" data-testid="lab-prior-inbound">
                          <div className="mb-2 text-[13px] font-medium">Prior inbound</div>
                          <p className="text-muted-foreground text-[13px]">{prior.subject}</p>
                          <div
                            className="mt-2 whitespace-pre-wrap break-words text-[13px]"
                            dangerouslySetInnerHTML={{
                              __html: highlightedHtml(prior.textBody, selected, 'inbound', activeTool),
                            }}
                          />
                        </article>
                      ))}
                      {selected.attachmentText ? (
                        <article className="border-border bg-background mb-3 rounded-xl border px-4 py-3" data-testid="lab-attachment-text">
                          <div className="mb-2 text-[13px] font-medium">
                            Attachment
                            {selected.attachmentRefs[0]?.filename ? ` · ${selected.attachmentRefs[0].filename}` : ''}
                          </div>
                          <div
                            className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[13px] leading-6"
                            dangerouslySetInnerHTML={{
                              __html: highlightedHtml(selected.attachmentText, selected, 'inbound', activeTool),
                            }}
                          />
                        </article>
                      ) : null}
                    </div>
                  </ScrollArea>
                  <div className="border-border/40 max-h-[46%] min-h-[32%] overflow-auto border-t px-4 py-3" data-testid="lab-gold-split">
                    {selected.gold ? (
                      <MessageCard
                        label="Gold"
                        subject={selected.gold.subject}
                        text={splitQuotedHistory(selected.gold.textBody).staff}
                        html={highlightedHtml(
                          splitQuotedHistory(selected.gold.textBody).staff,
                          selected,
                          'gold',
                          activeTool,
                        )}
                        channelAuto={goldAuto}
                        testId={goldAuto ? 'lab-gold-auto' : undefined}
                        bodyTestId="lab-gold-body"
                        quoted={splitQuotedHistory(selected.gold.textBody).quoted}
                      />
                    ) : (
                      <section className="border-border rounded-xl border border-dashed px-4 py-3" data-testid="lab-empty-gold">
                        <p className="text-sm" data-testid="thread-outcome-copy">
                          {THREAD_OUTCOME_COPY[selected.threadOutcome]}
                        </p>
                      </section>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground p-4 text-sm">No emails for this tool.</p>
            )}
          </ResizablePanel>
          <ResizableHandle withHandle className="mr-0.5 hidden w-2 shrink-0 md:flex md:opacity-60 md:hover:opacity-100" />
          <ResizablePanel
            defaultSize={25}
            minSize={18}
            className="bg-panelLight dark:bg-panelDark mb-1 min-w-0 rounded-2xl shadow-sm lg:h-[calc(100dvh-8px)]"
          >
            {selected ? (
              <ProposedPane
                row={selected}
                selectedTool={tool}
                actionIndex={actionIndex}
                onActionIndex={setActionIndex}
              />
            ) : null}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
