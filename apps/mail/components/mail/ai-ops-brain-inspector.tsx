import { AiOpsApiPopover } from '@/components/mail/ai-ops-api-popover';
import { Button } from '@/components/ui/button';
import type { AiOpsBrainGraph, AiOpsBrainGraphNode } from '@/lib/demo/ai-ops-brain';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, GitBranch, X } from 'lucide-react';

type AiOpsBrainInspectorProps = {
  graph: AiOpsBrainGraph;
  node: AiOpsBrainGraphNode;
  onApprove: () => void;
  onJustThisOnce: () => void;
  onClose?: () => void;
  learningState: 'live' | 'weak-signal' | 'promoted';
};

export function AiOpsBrainInspector({
  graph,
  node,
  onApprove,
  onJustThisOnce,
  onClose,
  learningState,
}: AiOpsBrainInspectorProps) {
  const relatedRisk = graph.riskAlerts.find((alert) => alert.affectedNodeIds.includes(node.id));

  return (
    <aside className="flex h-full w-[390px] shrink-0 flex-col border-l border-white/10 bg-[#07090f]/95 text-slate-100 shadow-2xl shadow-black/60 backdrop-blur-2xl">
      <div className="border-b border-white/10 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">Selected node</p>
            <h2 className="mt-2 text-xl font-semibold leading-tight">{node.label}</h2>
            <p className="mt-1 text-sm text-slate-400">{node.hotelScope} · {node.kind}</p>
          </div>
          {onClose ? (
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-slate-400" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {node.badges.map((badge) => (
            <span key={badge} className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[11px]">
              {badge}
            </span>
          ))}
          <span className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[11px]">
            {node.confidence}% confidence
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {relatedRisk ? (
          <div className="rounded-3xl border border-amber-300/30 bg-amber-300/10 p-4">
            <div className="flex items-center gap-2 text-amber-100">
              <AlertTriangle className="h-4 w-4" />
              <p className="text-sm font-semibold">{relatedRisk.title}</p>
            </div>
            <p className="mt-2 text-xs leading-5 text-amber-100/80">{relatedRisk.recommendedAction}</p>
          </div>
        ) : null}

        <InspectorSection title="Input" items={node.input} />
        <InspectorSection title="Reason" items={node.reason} code />
        <InspectorSection title="Output" items={node.output} />

        <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Sources</p>
          <div className="mt-3 space-y-2">
            {node.sources.map((source) => (
              <div key={source} className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-slate-300">
                {source}
              </div>
            ))}
          </div>
        </div>

        {node.apiConfig ? <AiOpsApiPopover node={node} /> : null}
      </div>

      {node.id === 'group-learn' || node.status === 'weak-signal' || node.status === 'suggested' ? (
        <div className="border-t border-white/10 p-5">
          <div className="rounded-3xl border border-fuchsia-300/25 bg-fuchsia-300/10 p-4">
            <div className="flex items-center gap-2 text-fuchsia-100">
              {learningState === 'promoted' ? <CheckCircle2 className="h-4 w-4" /> : <GitBranch className="h-4 w-4" />}
              <p className="text-sm font-semibold">{learningState === 'promoted' ? 'Branch promoted' : 'Teach Nava?'}</p>
            </div>
            <p className="mt-2 text-xs leading-5 text-fuchsia-100/75">
              Apply volleyball room proximity + gelato workflow to future youth sports groups at The Centurion.
            </p>
            <div className={cn('mt-4 grid gap-2', learningState === 'promoted' ? 'grid-cols-1' : 'grid-cols-2')}>
              {learningState === 'promoted' ? (
                <Button type="button" size="sm" className="bg-emerald-300 text-slate-950 hover:bg-emerald-200">
                  Live rule
                </Button>
              ) : (
                <>
                  <Button type="button" size="sm" className="bg-fuchsia-300 text-slate-950 hover:bg-fuchsia-200" onClick={onApprove}>
                    Approve update
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="border border-white/10 text-slate-200" onClick={onJustThisOnce}>
                    Just this once
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function InspectorSection({ title, items, code = false }: { title: string; items: string[]; code?: boolean }) {
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{title}</p>
      <div className={cn('mt-3 space-y-2 text-sm leading-6', code && 'font-mono text-xs')}>
        {items.map((item) => (
          <p key={item} className={cn(code ? 'rounded-xl bg-black/25 px-3 py-2 text-cyan-100' : 'text-slate-200')}>
            {item}
          </p>
        ))}
      </div>
    </section>
  );
}
