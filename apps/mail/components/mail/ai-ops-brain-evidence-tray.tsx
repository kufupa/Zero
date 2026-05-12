import type { AiOpsBrainEvidenceEvent, AiOpsBrainGraph } from '@/lib/demo/ai-ops-brain';
import { cn } from '@/lib/utils';
import { AlertTriangle, ArrowRight, Mail, PencilLine, Sparkles } from 'lucide-react';

type AiOpsBrainEvidenceTrayProps = {
  graph: AiOpsBrainGraph;
  learningState: 'live' | 'weak-signal' | 'promoted';
};

const KIND_THEME: Record<AiOpsBrainEvidenceEvent['kind'], string> = {
  email: 'border-blue-300/25 bg-blue-300/10 text-blue-100',
  draft: 'border-emerald-300/25 bg-emerald-300/10 text-emerald-100',
  edit: 'border-fuchsia-300/25 bg-fuchsia-300/10 text-fuchsia-100',
  'weak-signal': 'border-fuchsia-300/25 bg-fuchsia-300/10 text-fuchsia-100',
  promotion: 'border-emerald-300/25 bg-emerald-300/10 text-emerald-100',
  'internal-alert': 'border-amber-300/25 bg-amber-300/10 text-amber-100',
};

export function AiOpsBrainEvidenceTray({ graph, learningState }: AiOpsBrainEvidenceTrayProps) {
  return (
    <div className="absolute inset-x-5 bottom-5 z-10 rounded-[28px] border border-white/10 bg-[#06080d]/88 text-slate-100 shadow-2xl shadow-black/50 backdrop-blur-2xl">
      <div className="grid grid-cols-[1fr_auto] gap-4 p-4">
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">Evidence timeline</p>
              <p className="mt-1 text-sm text-slate-300">Email {'->'} draft {'->'} edit {'->'} signal {'->'} branch</p>
            </div>
            <SignalBadge learningState={learningState} />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            {graph.evidence.map((event, index) => (
              <EvidenceCard key={event.id} event={event} showArrow={index < graph.evidence.length - 1} />
            ))}
          </div>
        </div>
        <div className="hidden w-[260px] rounded-3xl border border-white/10 bg-white/[0.04] p-4 xl:block">
          <div className="flex items-center gap-2 text-amber-100">
            <AlertTriangle className="h-4 w-4" />
            <p className="text-sm font-semibold">Ops context attached</p>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            Third-floor leak from internal mail now warns room-plan suggestions before Nava drafts group allocation.
          </p>
        </div>
      </div>
    </div>
  );
}

function EvidenceCard({ event, showArrow }: { event: AiOpsBrainEvidenceEvent; showArrow: boolean }) {
  const Icon = event.kind === 'email' ? Mail : event.kind === 'internal-alert' ? AlertTriangle : event.kind === 'weak-signal' ? Sparkles : PencilLine;

  return (
    <div className="relative">
      <div className={cn('h-full rounded-3xl border p-3', KIND_THEME[event.kind])}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-2xl border border-white/10 bg-black/25">
              <Icon className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold">{event.action}</p>
              <p className="text-[11px] text-current/60">{event.actor}</p>
            </div>
          </div>
          {event.signalStrength ? (
            <span className="rounded-full border border-white/10 bg-black/25 px-2 py-0.5 text-[10px]">{event.signalStrength}</span>
          ) : null}
        </div>
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-current/75">{event.detail}</p>
      </div>
      {showArrow ? <ArrowRight className="absolute -right-6 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-white/25" /> : null}
    </div>
  );
}

function SignalBadge({ learningState }: { learningState: AiOpsBrainEvidenceTrayProps['learningState'] }) {
  if (learningState === 'promoted') {
    return <span className="rounded-full bg-emerald-300 px-3 py-1 text-xs font-semibold text-slate-950">Branch live</span>;
  }
  if (learningState === 'weak-signal') {
    return <span className="rounded-full bg-fuchsia-300 px-3 py-1 text-xs font-semibold text-slate-950">Weak signal saved</span>;
  }
  return <span className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-xs text-slate-300">Watching edits</span>;
}
