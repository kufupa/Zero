import '@xyflow/react/dist/style.css';

import { AiOpsBrainEvidenceTray } from '@/components/mail/ai-ops-brain-evidence-tray';
import { AiOpsBrainInspector } from '@/components/mail/ai-ops-brain-inspector';
import { AiOpsBrainFlowNode, AiOpsBrainLaneNode } from '@/components/mail/ai-ops-brain-node';
import { Button } from '@/components/ui/button';
import {
  type AiOpsBrainGraph,
  type AiOpsBrainGraphEdge,
  type AiOpsBrainGraphNode,
  getAiOpsBrainGraphForThread,
} from '@/lib/demo/ai-ops-brain';
import type { CenturionMailCategory } from '@/types';
import { cn } from '@/lib/utils';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import { ArrowLeft, BrainCircuit, CheckCircle2, GitBranch, Sparkles, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';

type AiOpsBrainWorkspaceProps = {
  routeFolder?: string;
  threadCategory?: CenturionMailCategory;
  isUrgent?: boolean;
  onClose?: () => void;
};

const nodeTypes: NodeTypes = {
  brainNode: AiOpsBrainFlowNode,
  laneNode: AiOpsBrainLaneNode,
};

const EDGE_THEME: Record<AiOpsBrainGraphEdge['status'], Pick<Edge, 'style' | 'animated' | 'className'>> = {
  live: { style: { stroke: '#34D399', strokeWidth: 2.25 }, animated: false },
  suggested: { style: { stroke: '#F0ABFC', strokeWidth: 2.5, strokeDasharray: '7 5' }, animated: true },
  weakSignal: { style: { stroke: '#E879F9', strokeWidth: 1.75, strokeDasharray: '3 6', opacity: 0.72 }, animated: true },
  blocked: { style: { stroke: '#FB7185', strokeWidth: 2, strokeDasharray: '4 6', opacity: 0.7 }, animated: false },
  riskAlert: { style: { stroke: '#FBBF24', strokeWidth: 2.5, strokeDasharray: '6 4' }, animated: true },
};

export function AiOpsBrainWorkspace({ routeFolder, threadCategory, isUrgent, onClose }: AiOpsBrainWorkspaceProps) {
  const [selectedNodeId, setSelectedNodeId] = useState('group-youth-sports');
  const [learningState, setLearningState] = useState<'live' | 'weak-signal' | 'promoted'>('live');
  const graph = useMemo(
    () => getAiOpsBrainGraphForThread({ routeFolder, threadCategory, isUrgent }),
    [routeFolder, threadCategory, isUrgent],
  );
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? graph.nodes[0]!;
  const nodes = useBrainNodes(graph, selectedNode.id, setSelectedNodeId, learningState);
  const edges = useBrainEdges(graph, learningState);

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#02030a] text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(255,255,255,0.045)_0,rgba(255,255,255,0.045)_1px,transparent_1px,transparent_18px)] opacity-30" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(217,70,239,0.16),transparent_28%),radial-gradient(circle_at_75%_20%,rgba(34,211,238,0.12),transparent_32%),linear-gradient(180deg,rgba(2,3,10,0.2),#02030a)]" />

      <TopBar graph={graph} learningState={learningState} onClose={onClose} />

      <div className="relative z-10 flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            colorMode="dark"
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            minZoom={0.24}
            maxZoom={1.35}
            proOptions={{ hideAttribution: true }}
            className="ai-ops-brain-flow"
          >
            <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="rgba(255,255,255,0.16)" />
            <Controls
              position="bottom-left"
              className="!bottom-[156px] !border-white/10 !bg-[#080b12]/90 !text-white [&_button]:!border-white/10 [&_button]:!bg-transparent [&_button]:!text-white"
            />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              className="!bottom-[156px] !h-28 !w-48 !rounded-2xl !border !border-white/10 !bg-[#080b12]/90"
              nodeColor={(node) => {
                if (node.type === 'laneNode') return 'rgba(255,255,255,0.08)';
                const brainNode = node.data?.node as AiOpsBrainGraphNode | undefined;
                if (brainNode?.focus === 'hero') return '#F0ABFC';
                if (brainNode?.status === 'risk') return '#FBBF24';
                return '#475569';
              }}
              maskColor="rgba(2,3,10,0.72)"
            />
          </ReactFlow>
          <AiOpsBrainEvidenceTray graph={graph} learningState={learningState} />
        </div>
        <AiOpsBrainInspector
          graph={graph}
          node={selectedNode}
          learningState={learningState}
          onApprove={() => setLearningState('promoted')}
          onJustThisOnce={() => setLearningState('weak-signal')}
        />
      </div>
    </div>
  );
}

function TopBar({
  graph,
  learningState,
  onClose,
}: {
  graph: AiOpsBrainGraph;
  learningState: 'live' | 'weak-signal' | 'promoted';
  onClose?: () => void;
}) {
  return (
    <header className="relative z-20 flex h-20 shrink-0 items-center justify-between border-b border-white/10 bg-[#05070c]/88 px-5 backdrop-blur-2xl">
      <div className="flex items-center gap-4">
        {onClose ? (
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10 text-slate-300" onClick={onClose}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        ) : null}
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-fuchsia-300/25 bg-fuchsia-300/10 text-fuchsia-100 shadow-[0_0_32px_rgba(217,70,239,0.25)]">
          <BrainCircuit className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-slate-500">Nava AI Ops Brain</p>
            <span className="rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-300">
              zoomable
            </span>
          </div>
          <h1 className="mt-1 text-lg font-semibold leading-none">{graph.title}</h1>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <TopPill icon={GitBranch} label="5 category lanes" />
        <TopPill icon={Zap} label="Room plan API linked" />
        <TopPill icon={Sparkles} label="Volleyball path focused" />
        <LearningPill learningState={learningState} />
      </div>
    </header>
  );
}

function TopPill({ icon: Icon, label }: { icon: typeof BrainCircuit; label: string }) {
  return (
    <span className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.055] px-3 py-2 text-xs text-slate-300 lg:flex">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function LearningPill({ learningState }: { learningState: 'live' | 'weak-signal' | 'promoted' }) {
  return (
    <span
      className={cn(
        'flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold',
        learningState === 'promoted'
          ? 'bg-emerald-300 text-slate-950'
          : learningState === 'weak-signal'
            ? 'bg-fuchsia-300 text-slate-950'
            : 'border border-white/10 bg-white/[0.055] text-slate-300',
      )}
    >
      {learningState === 'promoted' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
      {learningState === 'promoted' ? 'Branch live' : learningState === 'weak-signal' ? 'Weak signal saved' : 'Watching edits'}
    </span>
  );
}

function useBrainNodes(
  graph: AiOpsBrainGraph,
  selectedNodeId: string,
  onSelectNode: (nodeId: string) => void,
  learningState: 'live' | 'weak-signal' | 'promoted',
): Node[] {
  return useMemo(() => {
    const laneNodes: Node[] = graph.lanes.map((lane) => ({
      id: `lane-${lane.category}`,
      type: 'laneNode',
      position: { x: 650, y: lane.y - 75 },
      data: { lane },
      selectable: false,
      draggable: false,
      zIndex: -10,
    }));

    const brainNodes: Node[] = graph.nodes.map((node) => {
      const promoted = learningState === 'promoted' && ['group-youth-sports', 'group-gelato', 'group-calendar', 'group-gm-approval'].includes(node.id);
      const weak = learningState === 'weak-signal' && ['group-youth-sports', 'group-gelato', 'group-calendar'].includes(node.id);
      const nextNode: AiOpsBrainGraphNode = promoted
        ? { ...node, status: 'live', confidence: Math.max(node.confidence, 86) }
        : weak
          ? { ...node, status: 'weak-signal' }
          : node;

      return {
        id: node.id,
        type: 'brainNode',
        position: node.position,
        data: { node: nextNode, selectedNodeId, onSelectNode },
        draggable: false,
        zIndex: node.focus === 'hero' ? 10 : 2,
      };
    });

    return [...laneNodes, ...brainNodes];
  }, [graph, learningState, onSelectNode, selectedNodeId]);
}

function useBrainEdges(graph: AiOpsBrainGraph, learningState: 'live' | 'weak-signal' | 'promoted'): Edge[] {
  return useMemo(
    () =>
      graph.edges.map((edge) => {
        const promoted =
          learningState === 'promoted' &&
          ['e-room-plan-youth', 'e-youth-gelato', 'e-gelato-calendar', 'e-gelato-approval'].includes(edge.id);
        const theme = EDGE_THEME[promoted ? 'live' : edge.status];

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'smoothstep',
          label: edge.label,
          ...theme,
        };
      }),
    [graph.edges, learningState],
  );
}
