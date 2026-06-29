import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AiOpsBrainGraphLane, AiOpsBrainGraphNode } from '@/lib/demo/ai-ops-brain';
import { cn } from '@/lib/utils';
import {
  AlertTriangle,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  GitBranch,
  Mail,
  PlugZap,
  ShieldAlert,
  Sparkles,
  UserCheck,
} from 'lucide-react';

type BrainNodeData = {
  node: AiOpsBrainGraphNode;
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
  /** YC demo: workflow preview / stored — pulse ring on taught node */
  demoWorkflowHighlight?: boolean;
};

type LaneNodeData = {
  lane: AiOpsBrainGraphLane;
};

const STATUS_THEME: Record<AiOpsBrainGraphNode['status'], string> = {
  live: 'border-[#9DBDFF]/25 bg-[#0A1118]/82 text-slate-200 shadow-black/30',
  suggested: 'border-[#9DBDFF]/35 bg-[#0A1118]/88 text-slate-100 shadow-black/35',
  'weak-signal': 'border-[#9DBDFF]/30 bg-[#0A1118]/82 text-slate-100 shadow-black/30',
  risk: 'border-amber-300/35 bg-amber-300/10 text-amber-50 shadow-black/30',
  muted: 'border-white/10 bg-[#070B10]/68 text-slate-400 shadow-black/20',
};

const KIND_ICON: Record<AiOpsBrainGraphNode['kind'], typeof Mail> = {
  trigger: Mail,
  extract: Sparkles,
  classifier: GitBranch,
  api: PlugZap,
  rule: BrainCircuit,
  task: CalendarClock,
  approval: UserCheck,
  draft: CheckCircle2,
  learn: BrainCircuit,
  safety: ShieldAlert,
};

export function AiOpsBrainFlowNode({ data }: NodeProps) {
  const { node, selectedNodeId, onSelectNode, demoWorkflowHighlight } = data as BrainNodeData;
  const Icon = KIND_ICON[node.kind];
  const selected = selectedNodeId === node.id;
  const dimmed = !node.focus && node.category !== 'core';

  return (
    <button
      type="button"
      onClick={() => onSelectNode?.(node.id)}
      className={cn(
        'group relative w-[230px] rounded-full border px-5 py-4 text-left shadow-2xl backdrop-blur-xl transition-all duration-300',
        STATUS_THEME[node.status],
        demoWorkflowHighlight && 'ring-2 ring-emerald-400/85 shadow-[0_0_28px_rgba(52,211,153,0.35)] animate-pulse',
        selected && !demoWorkflowHighlight && 'scale-[1.03] border-[#C8D8FF]/60 ring-1 ring-[#C8D8FF]/55',
        selected && demoWorkflowHighlight && 'scale-[1.03]',
        node.focus === 'hero' && 'shadow-[0_0_28px_rgba(157,189,255,0.12)]',
        dimmed && 'opacity-60 hover:opacity-95',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-white/60 !bg-slate-950" />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-white/60 !bg-slate-950" />
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/20 text-[#9DBDFF]">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">{node.label}</p>
            <p className="mt-0.5 truncate text-[11px] text-current/65">{node.shortReason}</p>
          </div>
        </div>
        {node.status === 'risk' ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-200" /> : null}
      </div>
      <div className="mt-3 hidden flex-wrap gap-1.5 group-hover:flex">
        {node.badges.slice(0, 3).map((badge) => (
          <span key={badge} className="rounded-full border border-white/10 bg-black/25 px-2 py-0.5 text-[10px] font-medium">
            {badge}
          </span>
        ))}
        <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-[10px] font-medium">
          {node.confidence}%
        </span>
      </div>
      {node.focus === 'hero' ? (
        <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-[#9DBDFF] shadow-[0_0_18px_rgba(157,189,255,0.75)]" />
      ) : null}
    </button>
  );
}

export function AiOpsBrainLaneNode({ data }: NodeProps) {
  const { lane } = data as LaneNodeData;

  return (
    <div
      className="h-[150px] w-[2550px] rounded-[34px] border border-white/[0.06] px-8 py-5 backdrop-blur-sm"
      style={{
        background: `linear-gradient(90deg, ${lane.bg}, rgba(255,255,255,0.018))`,
        boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.025), 0 30px 80px rgba(0,0,0,0.18)`,
      }}
    >
      <div className="flex items-center gap-3">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: lane.color }} />
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">{lane.title}</p>
          <p className="mt-1 text-xs text-white/35">{lane.subtitle}</p>
        </div>
      </div>
    </div>
  );
}
