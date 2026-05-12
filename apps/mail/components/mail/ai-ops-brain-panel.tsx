import { Card, CardContent } from '@/components/ui/card';
import type { AiOpsBrainWorkflow } from '@/lib/demo/ai-ops-brain';
import { cn } from '@/lib/utils';

type AiOpsBrainPanelProps = {
  workflow: AiOpsBrainWorkflow;
  compact?: boolean;
};

const STATUS_THEME: Record<AiOpsBrainWorkflow['nodes'][number]['status'], string> = {
  live: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-400/30 dark:bg-blue-400/10 dark:text-blue-100',
  review:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100',
  learned:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-100',
};

export function AiOpsBrainPanel({ workflow, compact = false }: AiOpsBrainPanelProps) {
  return (
    <aside
      className={cn(
        'border-border/70 bg-background/95 dark:bg-[#111111]/95 overflow-hidden border-l shadow-[inset_1px_0_0_rgba(255,255,255,0.5)]',
        compact ? 'border-l-0 border-t' : 'hidden w-[360px] shrink-0 xl:block',
      )}
    >
      <div className={cn('space-y-3 overflow-y-auto', compact ? 'max-h-none p-3' : 'h-full p-4')}>
        <BrainHero workflow={workflow} />
        <WorkflowGraph workflow={workflow} />
        <DecisionCard workflow={workflow} />
        <SourcesCard workflow={workflow} />
        <LearningCard workflow={workflow} />
      </div>
    </aside>
  );
}

function BrainHero({ workflow }: { workflow: AiOpsBrainWorkflow }) {
  return (
    <Card className="overflow-hidden border-blue-200/70 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.18),transparent_34%),linear-gradient(135deg,#ffffff,#f8fbff)] dark:border-blue-400/20 dark:bg-[radial-gradient(circle_at_top_left,rgba(96,165,250,0.18),transparent_34%),linear-gradient(135deg,#101827,#0b1120)]">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-300">
              AI Ops Brain
            </p>
            <h3 className="mt-2 text-lg font-semibold leading-tight">{workflow.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{workflow.categoryLabel} · {workflow.owner}</p>
          </div>
          <div className="rounded-2xl border bg-white/80 px-3 py-2 text-right shadow-sm dark:border-white/10 dark:bg-white/10">
            <p className="text-xl font-semibold">{workflow.confidence}%</p>
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">confidence</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Metric label="Automated" value={`${workflow.automationRate}%`} />
          <Metric label="Review load" value={workflow.reviewLoad} />
        </div>
        <p className="mt-4 rounded-2xl border border-white/70 bg-white/70 p-3 text-sm leading-5 text-slate-700 dark:border-white/10 dark:bg-white/10 dark:text-slate-200">
          {workflow.impact}
        </p>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border bg-white/75 px-3 py-2 dark:border-white/10 dark:bg-white/10">
      <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function WorkflowGraph({ workflow }: { workflow: AiOpsBrainWorkflow }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Live workflow graph</p>
            <p className="mt-1 text-xs text-muted-foreground">Trigger to action, with review nodes visible.</p>
          </div>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium dark:bg-white/10">
            n8n-style
          </span>
        </div>
        <div className="mt-4 space-y-2">
          {workflow.nodes.map((node, index) => (
            <div key={node.id} className="grid grid-cols-[18px_1fr] gap-3">
              <div className="flex flex-col items-center">
                <span className="mt-1 h-3 w-3 rounded-full bg-blue-600 ring-4 ring-blue-100 dark:bg-blue-300 dark:ring-blue-300/10" />
                {index < workflow.nodes.length - 1 ? <span className="mt-1 h-full min-h-10 w-px bg-border" /> : null}
              </div>
              <div className={cn('rounded-2xl border p-3', STATUS_THEME[node.status])}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{node.label}</p>
                  <span className="rounded-full bg-white/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-current dark:bg-white/10">
                    {node.status}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 opacity-85">{node.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DecisionCard({ workflow }: { workflow: AiOpsBrainWorkflow }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <SectionKicker label="Suggested action" />
        <p className="text-sm leading-6">{workflow.plan}</p>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100">
          <p className="font-semibold">Human-in-loop reason</p>
          <p className="mt-1 text-xs leading-5">{workflow.humanReason}</p>
        </div>
        <div className="rounded-2xl border bg-muted/40 p-3 text-sm">
          <p className="font-semibold">Next click</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{workflow.nextAction}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function SourcesCard({ workflow }: { workflow: AiOpsBrainWorkflow }) {
  return (
    <Card>
      <CardContent className="p-4">
        <SectionKicker label="Grounding" />
        <div className="mt-3 space-y-2">
          {workflow.sources.map((source) => (
            <div key={source} className="rounded-xl border bg-background px-3 py-2 text-xs leading-5">
              {source}
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {workflow.apiIntegrations.map((integration) => (
            <span key={integration} className="rounded-full border bg-muted/40 px-2.5 py-1 text-[11px]">
              {integration}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function LearningCard({ workflow }: { workflow: AiOpsBrainWorkflow }) {
  return (
    <Card className="border-emerald-200 bg-emerald-50/70 dark:border-emerald-400/20 dark:bg-emerald-400/10">
      <CardContent className="p-4">
        <SectionKicker label="What this teaches Nava" />
        <p className="mt-2 text-sm font-medium leading-6 text-emerald-950 dark:text-emerald-50">
          {workflow.learnedEdit}
        </p>
        <div className="mt-3 rounded-2xl border border-emerald-300/60 bg-white/70 p-3 text-xs leading-5 text-emerald-900 dark:border-emerald-300/20 dark:bg-white/10 dark:text-emerald-100">
          If the user edits tone, save a few-shot example. If the user changes decision logic, add a workflow node.
        </div>
      </CardContent>
    </Card>
  );
}

function SectionKicker({ label }: { label: string }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
      {label}
    </p>
  );
}
