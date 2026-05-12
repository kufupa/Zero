import '@xyflow/react/dist/style.css';

import { AiOpsBrainFlowNode, AiOpsBrainLaneNode } from '@/components/mail/ai-ops-brain-node';
import { Button } from '@/components/ui/button';
import {
  type AiOpsBrainGraph,
  type AiOpsBrainGraphEdge,
  type AiOpsBrainGraphNode,
  type AiOpsBrainReviewStep,
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
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  ListChecks,
  PencilLine,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

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
  live: { style: { stroke: '#78A8FF', strokeWidth: 1.7, opacity: 0.45 }, animated: false },
  suggested: { style: { stroke: '#9DBDFF', strokeWidth: 2.25, opacity: 0.85 }, animated: false },
  weakSignal: { style: { stroke: '#9DBDFF', strokeWidth: 2.1, strokeDasharray: '5 7', opacity: 0.72 }, animated: true },
  blocked: { style: { stroke: '#FB7185', strokeWidth: 1.6, strokeDasharray: '4 6', opacity: 0.38 }, animated: false },
  riskAlert: { style: { stroke: '#FBBF24', strokeWidth: 1.9, strokeDasharray: '6 5', opacity: 0.68 }, animated: true },
};

type BrainMode = 'focus' | 'reasoning' | 'hotel';
type LearningState = 'live' | 'weak-signal' | 'promoted';
type TourId = AiOpsBrainGraph['tours'][number]['id'];

const FOCUS_NODE_IDS = new Set(['email-received', 'group-availability', 'group-room-plan', 'group-gelato', 'group-gm-approval', 'group-draft', 'group-learn']);
const FOCUS_EDGE_IDS = new Set(['e-classify-group', 'e-group-room-plan', 'e-youth-gelato', 'e-gelato-approval', 'e-approval-draft', 'e-draft-learn']);

export function AiOpsBrainWorkspace({ routeFolder, threadCategory, isUrgent, onClose }: AiOpsBrainWorkspaceProps) {
  const [mode, setMode] = useState<BrainMode>('focus');
  const [selectedNodeId, setSelectedNodeId] = useState('group-gelato');
  const [learningState, setLearningState] = useState<LearningState>('live');
  const [activeTourId, setActiveTourId] = useState<TourId>('categories');
  const graph = useMemo(
    () => getAiOpsBrainGraphForThread({ routeFolder, threadCategory, isUrgent }),
    [routeFolder, threadCategory, isUrgent],
  );
  const activeTour = graph.tours.find((tour) => tour.id === activeTourId) ?? graph.tours[0]!;
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? graph.nodes.find((node) => node.id === 'group-gelato') ?? graph.nodes[0]!;
  const nodes = useBrainNodes({
    graph,
    selectedNodeId: selectedNode.id,
    onSelectNode: setSelectedNodeId,
    learningState,
    mode,
    activeTourNodeIds: activeTour.nodeIds,
  });
  const edges = useBrainEdges({ graph, learningState, mode, activeTourNodeIds: activeTour.nodeIds });

  const workspace = (
    <div className="fixed inset-0 z-50 overflow-hidden bg-[#05080a] text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_34%_44%,rgba(92,130,185,0.18),transparent_30%),radial-gradient(circle_at_82%_12%,rgba(251,191,36,0.08),transparent_24%),linear-gradient(180deg,#05080a,#020304)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(104deg,rgba(255,255,255,0.035)_0,rgba(255,255,255,0.035)_1px,transparent_1px,transparent_24px)] opacity-20" />
      <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_180px_rgba(0,0,0,0.75)]" />

      <Chrome onClose={onClose} onFocus={() => setMode('focus')} onHotel={() => setMode('hotel')} mode={mode} />

      <div className="relative h-full">
        <div className={cn('absolute inset-0 transition-opacity duration-500', mode === 'reasoning' && 'opacity-24 blur-[1px]')}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: mode === 'hotel' ? 0.18 : 0.34 }}
            colorMode="dark"
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={mode !== 'reasoning'}
            minZoom={0.18}
            maxZoom={1.45}
            proOptions={{ hideAttribution: true }}
            className="ai-ops-brain-flow"
            onNodeClick={(_, node) => {
              if (node.type === 'brainNode') setSelectedNodeId(node.id);
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={34} size={1.1} color="rgba(148,163,184,0.14)" />
            {mode === 'hotel' ? (
              <>
                <Controls
                  position="bottom-left"
                  className="!bottom-7 !left-7 !border-white/10 !bg-[#080b12]/90 !text-white [&_button]:!border-white/10 [&_button]:!bg-transparent [&_button]:!text-white"
                />
                <MiniMap
                  position="bottom-right"
                  pannable
                  zoomable
                  className="!bottom-7 !right-7 !h-28 !w-48 !rounded-2xl !border !border-white/10 !bg-[#080b12]/90"
                  nodeColor={(node) => nodeColor(node, activeTour.nodeIds)}
                  maskColor="rgba(2,3,10,0.74)"
                />
              </>
            ) : null}
          </ReactFlow>
        </div>

        {mode === 'focus' ? (
          <FocusOverlay
            graph={graph}
            selectedNode={selectedNode}
            learningState={learningState}
            onReasoning={() => setMode('reasoning')}
            onHotel={() => setMode('hotel')}
          />
        ) : null}

        {mode === 'reasoning' ? (
          <ReasoningOverlay
            graph={graph}
            learningState={learningState}
            onBack={() => setMode('focus')}
            onSelectStep={(step) => {
              setSelectedNodeId(step.nodeId);
            }}
            onApprove={() => setLearningState('promoted')}
            onJustThisOnce={() => setLearningState('weak-signal')}
          />
        ) : null}

        {mode === 'hotel' ? (
          <HotelBrainOverlay
            graph={graph}
            activeTourId={activeTour.id}
            onTourChange={setActiveTourId}
            onFocus={() => setMode('focus')}
          />
        ) : null}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return workspace;
  return createPortal(workspace, document.body);
}

function Chrome({ mode, onClose, onFocus, onHotel }: { mode: BrainMode; onClose?: () => void; onFocus: () => void; onHotel: () => void }) {
  return (
    <div className="absolute inset-x-0 top-0 z-30 flex items-start justify-between p-6">
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon" className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10" onClick={onClose ?? onFocus}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        {mode !== 'focus' ? (
          <Button type="button" variant="ghost" className="h-9 rounded-full border border-white/10 bg-white/[0.04] px-4 text-xs text-slate-300 hover:bg-white/10" onClick={onFocus}>
            Focus path
          </Button>
        ) : null}
      </div>
      <Button type="button" variant="ghost" className="h-9 rounded-md border border-white/10 bg-white/[0.035] px-5 text-sm text-slate-400 hover:bg-white/10 hover:text-slate-100" onClick={onHotel}>
        Zoom out to hotel brain
      </Button>
    </div>
  );
}

function FocusOverlay({
  graph,
  selectedNode,
  learningState,
  onReasoning,
  onHotel,
}: {
  graph: AiOpsBrainGraph;
  selectedNode: AiOpsBrainGraphNode;
  learningState: LearningState;
  onReasoning: () => void;
  onHotel: () => void;
}) {
  return (
    <>
      <section className="pointer-events-none absolute left-7 top-20 z-20 max-w-[470px] sm:left-14 sm:top-14">
        <p className="text-sm font-medium text-[#82A8FF]">Run</p>
        <h1 className="mt-3 text-5xl font-semibold uppercase leading-[0.96] tracking-[-0.07em] text-slate-200/62 sm:text-7xl">
          Hotel AI<br />
          Volleyball<br />
          Group Booking
        </h1>
      </section>

      <section className="absolute bottom-10 left-7 z-20 grid max-w-[700px] gap-8 text-slate-500 sm:left-16 sm:grid-cols-[1fr_0.8fr_1fr]">
        <MiniProof title="Why" lines={selectedNode.reason.slice(0, 2)} />
        <MiniProof title="Sources" lines={selectedNode.sources.slice(0, 2)} />
        <MiniProof title="Next action" lines={[selectedNode.output[0] ?? graph.brainDelta.after]} />
      </section>

      <section className="absolute right-7 top-40 z-30 w-[265px] rounded-2xl border border-white/10 bg-[#0A0E12]/82 p-5 shadow-2xl shadow-black/40 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-lg font-semibold tracking-tight text-slate-300">Decision, Proof, Train</p>
            <p className="mt-1 text-xs text-slate-500">{learningCopy(learningState)}</p>
          </div>
          {learningState === 'promoted' ? <CheckCircle2 className="h-5 w-5 text-[#9DBDFF]" /> : null}
        </div>
        <button type="button" className="mt-5 flex w-full items-center justify-between rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-sm text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-100" onClick={onReasoning}>
          <span className="flex items-center gap-2">
            <span className="h-4 w-8 rounded-full border border-white/10 bg-[#111923] p-0.5">
              <span className="block h-3 w-3 rounded-full bg-[#5f748f]" />
            </span>
            View reasoning text
          </span>
          <ChevronRight className="h-4 w-4" />
        </button>
        <Button type="button" variant="ghost" className="mt-3 h-9 w-full rounded-full border border-white/10 text-xs text-slate-400 hover:bg-white/[0.08] hover:text-slate-100" onClick={onHotel}>
          Show whole brain
        </Button>
      </section>
    </>
  );
}

function MiniProof({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">{title}</p>
      <div className="mt-4 space-y-2">
        {lines.map((line) => (
          <p key={line} className="h-auto rounded-full bg-white/[0.035] px-3 py-1.5 text-xs leading-5 text-slate-500/90">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

function ReasoningOverlay({
  graph,
  learningState,
  onBack,
  onSelectStep,
  onApprove,
  onJustThisOnce,
}: {
  graph: AiOpsBrainGraph;
  learningState: LearningState;
  onBack: () => void;
  onSelectStep: (step: AiOpsBrainReviewStep) => void;
  onApprove: () => void;
  onJustThisOnce: () => void;
}) {
  const activeStep = graph.reviewSteps.find((step) => step.status === 'current') ?? graph.reviewSteps[0]!;
  const hasDelta = learningState !== 'live';

  return (
    <div className="absolute inset-0 z-20 grid grid-cols-1 gap-5 p-6 pt-24 lg:grid-cols-[280px_1fr_360px]">
      <aside className="rounded-[28px] border border-white/10 bg-[#080C10]/88 p-4 shadow-2xl shadow-black/45 backdrop-blur-2xl">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Review queue</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-200">Next, edit, train</h2>
          </div>
          <ListChecks className="h-5 w-5 text-[#9DBDFF]" />
        </div>
        <div className="mt-6 space-y-2">
          {graph.reviewSteps.map((step, index) => (
            <button
              key={step.id}
              type="button"
              className={cn(
                'w-full rounded-2xl border px-3 py-3 text-left transition',
                step.status === 'current'
                  ? 'border-[#8FB4FF]/35 bg-[#8FB4FF]/12 text-slate-100'
                  : 'border-white/8 bg-white/[0.025] text-slate-500 hover:bg-white/[0.055]',
              )}
              onClick={() => onSelectStep(step)}
            >
              <div className="flex items-center gap-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/20 text-[11px]">{index + 1}</span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{step.title}</p>
                  <p className="mt-0.5 truncate text-[11px] text-current/60">{step.actor}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="rounded-[34px] border border-white/10 bg-[#070A0E]/86 p-7 shadow-2xl shadow-black/45 backdrop-blur-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-[#8FB4FF]">Human review</p>
            <h2 className="mt-3 text-4xl font-semibold tracking-[-0.05em] text-slate-100">{activeStep.title}</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">{activeStep.summary}</p>
          </div>
          <Button type="button" variant="ghost" className="rounded-full border border-white/10 px-4 text-slate-400 hover:bg-white/[0.08]" onClick={onBack}>
            Back to graph
          </Button>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <ReasonCard title="Decision" body={activeStep.action} />
          <ReasonCard title="Reason" body={activeStep.reason} mono />
          <ReasonCard title="Proof" body={activeStep.sources.join(' / ')} />
        </div>

        <div className="mt-6 rounded-[28px] border border-white/10 bg-black/20 p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <PencilLine className="h-4 w-4 text-[#9DBDFF]" />
            Draft edit
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Nava draft</p>
              <p className="mt-3 text-sm leading-6 text-slate-300">We can hold 22 rooms for your volleyball teams and will confirm final allocation after manager review.</p>
            </div>
            <div className="rounded-2xl border border-[#8FB4FF]/25 bg-[#8FB4FF]/8 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-[#9DBDFF]">Sarah edit</p>
              <p className="mt-3 text-sm leading-6 text-slate-100">We will try to keep both teams close together, and our team can also review a gelato stand for the players.</p>
            </div>
          </div>
        </div>
      </main>

      <aside className="rounded-[28px] border border-white/10 bg-[#080C10]/88 p-5 shadow-2xl shadow-black/45 backdrop-blur-2xl">
        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Train brain</p>
        <h3 className="mt-3 text-2xl font-semibold tracking-tight text-slate-100">What changed?</h3>
        <p className="mt-3 text-sm leading-6 text-slate-400">Sarah added operational rules, not tone. Save signal to hotel brain.</p>
        <div className="mt-5 space-y-2">
          {['Operational rule', 'API/source correction', 'Brand tone', 'Just this once'].map((item) => (
            <div key={item} className="rounded-2xl border border-white/8 bg-white/[0.025] px-3 py-2 text-sm text-slate-300">
              {item}
            </div>
          ))}
        </div>
        <div className="mt-6 grid gap-2">
          <Button type="button" className="rounded-full bg-[#9DBDFF] text-slate-950 hover:bg-[#B7CCFF]" onClick={onApprove}>
            Promote rule
          </Button>
          <Button type="button" variant="ghost" className="rounded-full border border-white/10 text-slate-300 hover:bg-white/[0.08]" onClick={onJustThisOnce}>
            Just this once
          </Button>
        </div>
        {hasDelta ? <BrainDelta graph={graph} learningState={learningState} /> : null}
      </aside>
    </div>
  );
}

function ReasonCard({ title, body, mono = false }: { title: string; body: string; mono?: boolean }) {
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
      <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{title}</p>
      <p className={cn('mt-3 text-sm leading-6 text-slate-200', mono && 'font-mono text-xs text-[#B8CCFF]')}>{body}</p>
    </section>
  );
}

function BrainDelta({ graph, learningState }: { graph: AiOpsBrainGraph; learningState: LearningState }) {
  return (
    <div className="mt-5 rounded-3xl border border-[#9DBDFF]/25 bg-[#9DBDFF]/10 p-4">
      <div className="flex items-center gap-2 text-[#C8D8FF]">
        <Sparkles className="h-4 w-4" />
        <p className="text-sm font-semibold">{graph.brainDelta.title}</p>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-400">{graph.brainDelta.before}</p>
      <p className="mt-2 text-sm leading-6 text-slate-100">
        {learningState === 'promoted' ? graph.brainDelta.after : 'Weak signal saved. Ask again if this repeats.'}
      </p>
      <p className="mt-3 text-[11px] uppercase tracking-[0.18em] text-slate-500">
        {graph.brainDelta.actor} / {graph.brainDelta.hotel}
      </p>
    </div>
  );
}

function HotelBrainOverlay({
  graph,
  activeTourId,
  onTourChange,
  onFocus,
}: {
  graph: AiOpsBrainGraph;
  activeTourId: TourId;
  onTourChange: (tourId: TourId) => void;
  onFocus: () => void;
}) {
  const activeTour = graph.tours.find((tour) => tour.id === activeTourId) ?? graph.tours[0]!;

  return (
    <div className="absolute inset-x-6 bottom-6 z-20 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <section className="max-w-xl rounded-[28px] border border-white/10 bg-[#080C10]/88 p-5 shadow-2xl shadow-black/45 backdrop-blur-2xl">
        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Whole hotel brain</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-100">{activeTour.title}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">{activeTour.description}</p>
      </section>
      <div className="rounded-full border border-white/10 bg-[#080C10]/88 p-1 shadow-2xl shadow-black/45 backdrop-blur-2xl">
        <div className="flex flex-wrap items-center gap-1">
          {graph.tours.map((tour) => (
            <button
              key={tour.id}
              type="button"
              className={cn(
                'rounded-full px-4 py-2 text-sm transition',
                tour.id === activeTourId ? 'bg-[#9DBDFF] text-slate-950' : 'text-slate-400 hover:bg-white/[0.08] hover:text-slate-100',
              )}
              onClick={() => onTourChange(tour.id)}
            >
              {tour.label}
            </button>
          ))}
          <Button type="button" variant="ghost" className="rounded-full px-4 text-slate-400 hover:bg-white/[0.08]" onClick={onFocus}>
            Return to run
          </Button>
        </div>
      </div>
    </div>
  );
}

function useBrainNodes({
  graph,
  selectedNodeId,
  onSelectNode,
  learningState,
  mode,
  activeTourNodeIds,
}: {
  graph: AiOpsBrainGraph;
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
  learningState: LearningState;
  mode: BrainMode;
  activeTourNodeIds: string[];
}): Node[] {
  return useMemo(() => {
    const laneNodes: Node[] =
      mode === 'hotel'
        ? graph.lanes.map((lane) => ({
            id: `lane-${lane.category}`,
            type: 'laneNode',
            position: { x: 650, y: lane.y - 75 },
            data: { lane },
            selectable: false,
            draggable: false,
            zIndex: -10,
          }))
        : [];

    const brainNodes: Node[] = graph.nodes.map((node) => {
      const promoted = learningState === 'promoted' && ['group-youth-sports', 'group-gelato', 'group-calendar', 'group-gm-approval'].includes(node.id);
      const weak = learningState === 'weak-signal' && ['group-youth-sports', 'group-gelato', 'group-calendar'].includes(node.id);
      const inFocusPath = FOCUS_NODE_IDS.has(node.id);
      const inTour = activeTourNodeIds.includes(node.id);
      const visibleInFocus = mode !== 'focus' || inFocusPath || node.focus === 'hero';
      const nextNode: AiOpsBrainGraphNode = promoted
        ? { ...node, status: 'live', confidence: Math.max(node.confidence, 86) }
        : weak
          ? { ...node, status: 'weak-signal' }
          : node;

      return {
        id: node.id,
        type: 'brainNode',
        position: mode === 'focus' && inFocusPath ? focusPosition(node.id, node.position) : node.position,
        data: { node: nextNode, selectedNodeId, onSelectNode },
        draggable: false,
        hidden: !visibleInFocus,
        selectable: mode !== 'reasoning',
        zIndex: mode === 'focus' && inFocusPath ? 20 : inTour ? 12 : node.focus === 'hero' ? 10 : 2,
        style: {
          opacity: mode === 'hotel' ? (inTour ? 1 : 0.22) : mode === 'reasoning' ? 0.24 : inFocusPath ? 1 : 0.08,
          filter: mode === 'hotel' || inFocusPath ? 'none' : 'grayscale(1)',
        },
      };
    });

    return [...laneNodes, ...brainNodes];
  }, [activeTourNodeIds, graph, learningState, mode, onSelectNode, selectedNodeId]);
}

function useBrainEdges({
  graph,
  learningState,
  mode,
  activeTourNodeIds,
}: {
  graph: AiOpsBrainGraph;
  learningState: LearningState;
  mode: BrainMode;
  activeTourNodeIds: string[];
}): Edge[] {
  return useMemo(
    () =>
      graph.edges.map((edge) => {
        const promoted =
          learningState === 'promoted' &&
          ['e-room-plan-youth', 'e-youth-gelato', 'e-gelato-calendar', 'e-gelato-approval'].includes(edge.id);
        const inFocusPath = FOCUS_EDGE_IDS.has(edge.id);
        const inTour = activeTourNodeIds.includes(edge.source) || activeTourNodeIds.includes(edge.target);
        const theme = EDGE_THEME[promoted ? 'live' : edge.status];

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'smoothstep',
          label: edge.label,
          ...theme,
          hidden: mode === 'focus' && !inFocusPath,
          animated: mode === 'focus' ? inFocusPath : theme.animated,
          style: {
            ...theme.style,
            opacity: mode === 'focus' ? (inFocusPath ? 0.96 : 0) : mode === 'hotel' ? (inTour ? theme.style?.opacity ?? 0.8 : 0.16) : 0.18,
            strokeWidth: mode === 'focus' && inFocusPath ? 2.7 : theme.style?.strokeWidth,
            filter: mode === 'focus' && inFocusPath ? 'drop-shadow(0 0 8px rgba(157,189,255,0.85)) drop-shadow(0 0 18px rgba(157,189,255,0.35))' : undefined,
          },
        };
      }),
    [activeTourNodeIds, graph.edges, learningState, mode],
  );
}

function focusPosition(nodeId: string, fallback: AiOpsBrainGraphNode['position']): AiOpsBrainGraphNode['position'] {
  const positions: Record<string, AiOpsBrainGraphNode['position']> = {
    'email-received': { x: 0, y: 500 },
    'group-availability': { x: 330, y: 500 },
    'group-room-plan': { x: 660, y: 500 },
    'group-gelato': { x: 990, y: 420 },
    'group-gm-approval': { x: 1320, y: 500 },
    'group-draft': { x: 1650, y: 500 },
    'group-learn': { x: 1980, y: 500 },
  };
  return positions[nodeId] ?? fallback;
}

function nodeColor(node: Node, activeTourNodeIds: string[]) {
  if (node.type === 'laneNode') return 'rgba(255,255,255,0.08)';
  if (activeTourNodeIds.includes(node.id)) return '#9DBDFF';
  const brainNode = node.data?.node as AiOpsBrainGraphNode | undefined;
  if (brainNode?.status === 'risk') return '#FBBF24';
  return '#334155';
}

function learningCopy(learningState: LearningState) {
  if (learningState === 'promoted') return 'Branch promoted to live rule';
  if (learningState === 'weak-signal') return 'Weak signal saved for this hotel';
  return 'Watching edit patterns';
}
