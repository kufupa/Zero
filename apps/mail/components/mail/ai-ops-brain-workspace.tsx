import '@xyflow/react/dist/style.css';

import { AiOpsBrainFlowNode, AiOpsBrainLaneNode } from '@/components/mail/ai-ops-brain-node';
import { Button } from '@/components/ui/button';
import {
  type AiOpsBrainGraph,
  type AiOpsBrainGraphEdge,
  type AiOpsBrainGraphNode,
  type AiOpsBrainOperatorTraceEvent,
  type AiOpsBrainTrainingOverlay,
  getAiOpsBrainGraphForThread,
} from '@/lib/demo/ai-ops-brain';
import {
  YC_SARAH_TEACHING_NOTE,
  YC_SARAH_TEACHING_TAGS,
  type YcVolleyballDemoStage,
} from '@/lib/demo/yc-volleyball-demo';
import type { CenturionMailCategory } from '@/types';
import { cn } from '@/lib/utils';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Plus,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

type BrainMode = 'focus' | 'reasoning' | 'hotel';

type AiOpsBrainWorkspaceProps = {
  routeFolder?: string;
  threadCategory?: CenturionMailCategory;
  isUrgent?: boolean;
  onClose?: () => void;
  /** When opening from teach-workflow prompt, land on reasoning trace first. */
  initialBrainMode?: BrainMode;
  ycDemoStage?: YcVolleyballDemoStage;
  onYcDemoStageChange?: (stage: YcVolleyballDemoStage) => void;
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

/** Must render as child of ReactFlow — fit camera on gelato when YC workflow preview opens on graph. */
function BrainFlowFitHelper({ active }: { active: boolean }) {
  const { fitView, getNode } = useReactFlow();
  useEffect(() => {
    if (!active) return;
    if (!getNode('group-gelato')) return;
    const id = window.requestAnimationFrame(() => {
      void fitView({ nodes: [{ id: 'group-gelato' }], padding: 0.42, duration: 480 });
    });
    return () => window.cancelAnimationFrame(id);
  }, [active, fitView, getNode]);
  return null;
}

type LearningState = 'live' | 'weak-signal' | 'promoted';
type TourId = AiOpsBrainGraph['tours'][number]['id'];
type DemoStep = AiOpsBrainGraph['demoSteps'][number];

function trainingOverlayForState(graph: AiOpsBrainGraph, learningState: LearningState): AiOpsBrainTrainingOverlay | null {
  if (learningState === 'weak-signal') return graph.trainingOutcomes.weakSignal;
  if (learningState === 'promoted') return graph.trainingOutcomes.promoted;
  return null;
}

export function AiOpsBrainWorkspace({
  routeFolder,
  threadCategory,
  isUrgent,
  onClose,
  initialBrainMode,
  ycDemoStage,
  onYcDemoStageChange,
}: AiOpsBrainWorkspaceProps) {
  const [mode, setMode] = useState<BrainMode>(initialBrainMode ?? 'focus');
  const [selectedNodeId, setSelectedNodeId] = useState('group-gelato');
  const [learningState, setLearningState] = useState<LearningState>('live');
  const [activeTourId, setActiveTourId] = useState<TourId>('categories');
  const [guidedStepIndex, setGuidedStepIndex] = useState<number | null>(null);
  const graph = useMemo(
    () => getAiOpsBrainGraphForThread({ routeFolder, threadCategory, isUrgent }),
    [routeFolder, threadCategory, isUrgent],
  );
  const showGuidedDemo = graph.focusPathId === 'volleyball-group-booking' && graph.demoSteps.length > 0;
  const guidedStep = guidedStepIndex !== null ? graph.demoSteps[guidedStepIndex] : undefined;
  const applyGuidedIndex = useCallback(
    (index: number) => {
      const step = graph.demoSteps[index];
      if (!step) return;
      setGuidedStepIndex(index);
      setSelectedNodeId(step.nodeId);
      if (step.detailKind === 'hotel') setMode('hotel');
      else setMode('focus');
    },
    [graph.demoSteps],
  );
  const startGuidedDemo = useCallback(() => {
    setLearningState('live');
    applyGuidedIndex(0);
  }, [applyGuidedIndex]);
  const exitGuidedDemo = useCallback(() => setGuidedStepIndex(null), []);
  const nextGuidedStep = useCallback(() => {
    if (guidedStepIndex === null) return;
    const next = guidedStepIndex + 1;
    if (next >= graph.demoSteps.length) {
      setGuidedStepIndex(null);
      setMode('focus');
      return;
    }
    applyGuidedIndex(next);
  }, [applyGuidedIndex, graph.demoSteps.length, guidedStepIndex]);
  const prevGuidedStep = useCallback(() => {
    if (guidedStepIndex === null || guidedStepIndex <= 0) return;
    applyGuidedIndex(guidedStepIndex - 1);
  }, [applyGuidedIndex, guidedStepIndex]);
  const activeTour = graph.tours.find((tour) => tour.id === activeTourId) ?? graph.tours[0]!;
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? graph.nodes.find((node) => node.id === 'group-gelato') ?? graph.nodes[0]!;
  const selectNodeInFocus = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setMode('focus');
  };

  const enterWorkflowGraphPreview = useCallback(() => {
    setMode('focus');
    setSelectedNodeId('group-gelato');
    onYcDemoStageChange?.('workflow-preview');
  }, [onYcDemoStageChange]);

  const demoWorkflowHighlightNodeId =
    ycDemoStage === 'workflow-preview' || ycDemoStage === 'stored' ? 'group-gelato' : undefined;
  const fitGelatoView = mode === 'focus' && ycDemoStage === 'workflow-preview';
  const hideChromeHotelNav = Boolean(ycDemoStage === 'workflow-preview' && mode === 'focus');

  const nodes = useBrainNodes({
    graph,
    selectedNodeId: selectedNode.id,
    onSelectNode: setSelectedNodeId,
    learningState,
    mode,
    activeTourNodeIds: activeTour.nodeIds,
    demoWorkflowHighlightNodeId,
  });
  const edges = useBrainEdges({ graph, learningState, mode, activeTourNodeIds: activeTour.nodeIds });

  const workspace = (
    <div className="fixed inset-0 z-50 overflow-hidden bg-[#05080a] text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_34%_44%,rgba(92,130,185,0.18),transparent_30%),radial-gradient(circle_at_82%_12%,rgba(251,191,36,0.08),transparent_24%),linear-gradient(180deg,#05080a,#020304)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(104deg,rgba(255,255,255,0.035)_0,rgba(255,255,255,0.035)_1px,transparent_1px,transparent_24px)] opacity-20" />
      <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_180px_rgba(0,0,0,0.75)]" />

      <Chrome
        onClose={onClose}
        onFocus={() => setMode('focus')}
        onHotel={() => setMode('hotel')}
        mode={mode}
        hideHotelNav={hideChromeHotelNav}
      />

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
            <BrainFlowFitHelper active={fitGelatoView} />
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
            ycDemoStage={ycDemoStage}
            onReasoning={() => {
              if (ycDemoStage === 'workflow-preview') {
                onYcDemoStageChange?.('reasoning');
              }
              setMode('reasoning');
            }}
            onHotel={() => setMode('hotel')}
            onYcWorkflowApprove={() => {
              setLearningState('promoted');
              onYcDemoStageChange?.('stored');
            }}
            onYcWorkflowJustOnce={() => {
              setLearningState('weak-signal');
              onYcDemoStageChange?.('stored');
            }}
            onYcWorkflowSkip={() => onYcDemoStageChange?.('sent')}
            showGuidedDemo={showGuidedDemo}
            guidedStep={guidedStep}
            guidedStepIndex={guidedStepIndex}
            onGuidedStart={startGuidedDemo}
            onGuidedExit={exitGuidedDemo}
            onGuidedNext={nextGuidedStep}
            onGuidedPrev={prevGuidedStep}
            onTrainingApprove={() => setLearningState('promoted')}
            onTrainingWeak={() => setLearningState('weak-signal')}
          />
        ) : null}

        {mode === 'reasoning' ? (
          <ReasoningOverlay
            graph={graph}
            ycDemoStage={ycDemoStage}
            learningState={learningState}
            trainingOverlay={trainingOverlayForState(graph, learningState)}
            onBack={() => setMode('focus')}
            onHotel={() => setMode('hotel')}
            onSelectTraceNode={setSelectedNodeId}
            onShowNodeInFocus={selectNodeInFocus}
            onStageChange={onYcDemoStageChange}
            onEnterWorkflowGraphPreview={enterWorkflowGraphPreview}
            onApprove={() => {
              setLearningState('promoted');
              onYcDemoStageChange?.('stored');
            }}
            onJustThisOnce={() => {
              setLearningState('weak-signal');
              onYcDemoStageChange?.('stored');
            }}
            onSkip={() => onYcDemoStageChange?.('sent')}
          />
        ) : null}

        {mode === 'hotel' ? (
          <HotelBrainOverlay
            graph={graph}
            activeTourId={activeTour.id}
            onTourChange={setActiveTourId}
            trainingOverlay={trainingOverlayForState(graph, learningState)}
            showGuidedDemo={showGuidedDemo}
            guidedStep={guidedStep}
            guidedStepIndex={guidedStepIndex}
            demoStepCount={graph.demoSteps.length}
            onGuidedNext={nextGuidedStep}
            onGuidedPrev={prevGuidedStep}
            onGuidedExit={exitGuidedDemo}
          />
        ) : null}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return workspace;
  return createPortal(workspace, document.body);
}

function Chrome({
  mode,
  onClose,
  onFocus,
  onHotel,
  hideHotelNav,
}: {
  mode: BrainMode;
  onClose?: () => void;
  onFocus: () => void;
  onHotel: () => void;
  /** YC workflow preview on graph — avoid accidental jump to whole-brain */
  hideHotelNav?: boolean;
}) {
  return (
    <div className="absolute inset-x-0 top-0 z-30 flex items-start justify-between p-6">
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon" className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10" onClick={onClose ?? onFocus}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </div>
      {hideHotelNav ? (
        <p className="max-w-xs rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-center text-xs text-slate-500">
          Hotel brain hidden during rule preview — use panel below for whole property
        </p>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="h-9 rounded-md border border-white/10 bg-white/[0.035] px-5 text-sm text-slate-400 hover:bg-white/10 hover:text-slate-100"
          onClick={mode === 'hotel' ? onFocus : onHotel}
        >
          {mode === 'hotel' ? 'Return to run' : 'Zoom out to hotel brain'}
        </Button>
      )}
    </div>
  );
}

function DetailList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <ul className="mt-1.5 list-inside list-disc space-y-1 text-sm text-slate-300">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function DemoStepDetail({
  graph,
  step,
  learningState,
  trainingOverlay,
  onTrainingApprove,
  onTrainingWeak,
}: {
  graph: AiOpsBrainGraph;
  step: DemoStep;
  learningState: LearningState;
  trainingOverlay: AiOpsBrainTrainingOverlay | null;
  onTrainingApprove: () => void;
  onTrainingWeak: () => void;
}) {
  const mock = graph.apiMocks.find((m) => m.nodeId === step.nodeId);
  const card = graph.nodeDetails[step.nodeId];
  const diff = graph.draftDiff;

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#9DBDFF]">Step detail</p>

      {step.detailKind === 'node' && card ? (
        <div className="space-y-3">
          <h3 className="text-lg font-semibold tracking-tight text-slate-100">{card.headline}</h3>
          <DetailList label="Input" items={card.input} />
          <p className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-300">
            <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Decision </span>
            {card.decision}
          </p>
          <DetailList label="Output" items={card.output} />
          <DetailList label="Proof" items={card.proof} />
        </div>
      ) : null}

      {step.detailKind === 'node' && !card ? <p className="text-sm text-slate-500">No detail card for this node.</p> : null}

      {(step.detailKind === 'api-room-plan' || step.detailKind === 'api-calendar') && mock ? (
        <div className="space-y-3">
          <h3 className="text-lg font-semibold tracking-tight text-slate-100">{mock.title}</h3>
          <p className="font-mono text-[11px] text-[#8FB4FF]">
            {mock.method} {mock.path}
          </p>
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Request</p>
          <pre className="max-h-28 overflow-auto rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-300">{mock.requestSummary}</pre>
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Response</p>
          <pre className="max-h-36 overflow-auto rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
            {mock.responseLines.join('\n')}
          </pre>
          <p className="text-sm leading-5 text-slate-400">{mock.effect}</p>
        </div>
      ) : null}

      {(step.detailKind === 'api-room-plan' || step.detailKind === 'api-calendar') && !mock ? (
        <p className="text-sm text-slate-500">No API mock wired for this step.</p>
      ) : null}

      {step.detailKind === 'diff' ? (
        <div className="space-y-3">
          <h3 className="text-lg font-semibold tracking-tight text-slate-100">Draft delta</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{diff.navaLabel}</p>
              <p className="mt-2 text-sm leading-5 text-slate-300">{diff.navaBody}</p>
            </div>
            <div className="rounded-2xl border border-[#9DBDFF]/25 bg-[#9DBDFF]/8 p-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{diff.sarahLabel}</p>
              <p className="mt-2 text-sm leading-5 text-slate-100">{diff.sarahBody}</p>
            </div>
          </div>
          <p className="text-sm leading-6 text-slate-400">{diff.operationalChange}</p>
        </div>
      ) : null}

      {step.detailKind === 'training' ? (
        <div className="space-y-4">
          <RuleMetadata graph={graph} trainingOverlay={trainingOverlay} />
          {learningState !== 'live' ? <BrainDelta graph={graph} learningState={learningState} /> : null}
          <p className="text-xs text-slate-500">Pick how this edit should land in hotel memory.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="rounded-full bg-[#9DBDFF] text-slate-950 hover:bg-[#B7CCFF]" onClick={onTrainingApprove}>
              Approve + train
            </Button>
            <Button type="button" variant="ghost" className="rounded-full border border-white/10 text-slate-300 hover:bg-white/[0.08]" onClick={onTrainingWeak}>
              Save as weak signal
            </Button>
          </div>
        </div>
      ) : null}

      {step.detailKind === 'hotel' ? (
        <p className="text-sm leading-6 text-slate-400">
          Map shows every lane, overlays for urgent approvals, API debt, risk propagation, and learning signals. Use the tour strip at the bottom to walk each story on the graph.
        </p>
      ) : null}
    </div>
  );
}

function FocusOverlay({
  graph,
  selectedNode,
  learningState,
  ycDemoStage,
  onReasoning,
  onHotel,
  showGuidedDemo,
  guidedStep,
  guidedStepIndex,
  onGuidedStart,
  onGuidedExit,
  onGuidedNext,
  onGuidedPrev,
  onTrainingApprove,
  onTrainingWeak,
  onYcWorkflowApprove,
  onYcWorkflowJustOnce,
  onYcWorkflowSkip,
}: {
  graph: AiOpsBrainGraph;
  selectedNode: AiOpsBrainGraphNode;
  learningState: LearningState;
  ycDemoStage?: YcVolleyballDemoStage;
  onReasoning: () => void;
  onHotel: () => void;
  showGuidedDemo: boolean;
  guidedStep?: DemoStep;
  guidedStepIndex: number | null;
  onGuidedStart: () => void;
  onGuidedExit: () => void;
  onGuidedNext: () => void;
  onGuidedPrev: () => void;
  onTrainingApprove: () => void;
  onTrainingWeak: () => void;
  onYcWorkflowApprove: () => void;
  onYcWorkflowJustOnce: () => void;
  onYcWorkflowSkip: () => void;
}) {
  const trainingOverlay = trainingOverlayForState(graph, learningState);
  const guidedActive = guidedStepIndex !== null && guidedStep;
  const workflowRuleSheet = ycDemoStage === 'workflow-preview' && selectedNode.id === 'group-gelato';
  const workflowPickHint = ycDemoStage === 'workflow-preview' && selectedNode.id !== 'group-gelato';

  return (
    <>
      <section
        className={cn(
          'absolute left-7 top-20 z-20 max-w-[min(420px,calc(100vw-3rem))] sm:left-14 sm:top-16',
          guidedActive ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <p className="text-xs font-medium uppercase tracking-[0.28em] text-[#82A8FF]">
          {guidedActive ? `Guided demo · ${guidedStepIndex! + 1} / ${graph.demoSteps.length}` : 'Live run'}
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-[0.98] tracking-[-0.06em] text-slate-100/80 sm:text-5xl">
          {guidedActive ? guidedStep.title : graph.focusRun.title}
        </h1>
        <p className="mt-4 max-w-md text-sm leading-6 text-slate-400">
          {guidedActive ? guidedStep.narration : graph.focusRun.subtitle}
        </p>
        {ycDemoStage === 'workflow-preview' ? (
          <p className="pointer-events-none mt-4 max-w-md rounded-2xl border border-emerald-300/25 bg-emerald-300/10 px-4 py-3 text-sm leading-6 text-emerald-50">
            Rule preview: graph shows <span className="font-semibold">green pulse</span> on the ancillary / gelato node — open the right panel by selecting that node.
          </p>
        ) : null}
        {showGuidedDemo ? (
          <div className="pointer-events-auto mt-6 flex flex-wrap items-center gap-2">
            {guidedStepIndex === null ? (
              <Button
                type="button"
                className="rounded-full bg-[#9DBDFF] px-5 text-slate-950 hover:bg-[#B7CCFF]"
                onClick={onGuidedStart}
              >
                Start guided demo
              </Button>
            ) : (
              <>
                <Button type="button" variant="ghost" className="rounded-full border border-white/10 text-slate-300 hover:bg-white/[0.08]" onClick={onGuidedPrev} disabled={guidedStepIndex <= 0}>
                  Back
                </Button>
                <Button
                  type="button"
                  className="rounded-full bg-[#9DBDFF] px-5 text-slate-950 hover:bg-[#B7CCFF]"
                  onClick={onGuidedNext}
                >
                  {guidedStepIndex >= graph.demoSteps.length - 1 ? 'Finish' : 'Next'}
                </Button>
                <Button type="button" variant="ghost" className="rounded-full border border-white/10 text-xs text-slate-500 hover:bg-white/[0.08]" onClick={onGuidedExit}>
                  Exit tour
                </Button>
              </>
            )}
          </div>
        ) : null}
      </section>

      <section className="absolute bottom-8 left-7 right-7 z-20 grid max-w-[980px] gap-4 rounded-[28px] border border-white/10 bg-[#070B10]/86 p-5 text-slate-300 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:left-16 sm:right-auto sm:grid-cols-[1fr_0.85fr_1fr]">
        <MiniProof title="Why" lines={selectedNode.reason.slice(0, 2)} />
        <MiniProof title="Sources" lines={selectedNode.sources.slice(0, 2)} />
        <MiniProof title="Next action" lines={[selectedNode.output[0] ?? graph.brainDelta.after]} />
      </section>

      <section className="absolute right-7 top-40 z-30 w-[min(360px,calc(100vw-3.5rem))] max-h-[calc(100vh-11rem)] overflow-y-auto rounded-2xl border border-white/10 bg-[#0A0E12]/82 p-5 shadow-2xl shadow-black/40 backdrop-blur-xl">
        {guidedActive && guidedStep ? (
          <DemoStepDetail
            graph={graph}
            step={guidedStep}
            learningState={learningState}
            trainingOverlay={trainingOverlay}
            onTrainingApprove={onTrainingApprove}
            onTrainingWeak={onTrainingWeak}
          />
        ) : null}

        {workflowRuleSheet ? (
          <div className={cn('space-y-4', guidedActive && guidedStep ? 'mt-6 border-t border-white/10 pt-5' : '')}>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200">Store rule draft</p>
            <p className="text-sm leading-6 text-slate-400">
              This is the policy Nava proposes after Sarah&apos;s teach. Approve to promote, or save a lighter signal.
            </p>
            <RuleMetadata graph={graph} trainingOverlay={trainingOverlay} />
            {learningState !== 'live' ? <BrainDelta graph={graph} learningState={learningState} /> : null}
            <div className="flex flex-col gap-2">
              <Button type="button" className="rounded-full bg-[#9DBDFF] text-slate-950 hover:bg-[#B7CCFF]" onClick={onYcWorkflowApprove}>
                Add to hotel brain
              </Button>
              <Button type="button" variant="ghost" className="rounded-full border border-white/10 text-slate-300 hover:bg-white/[0.08]" onClick={onYcWorkflowJustOnce}>
                Use once
              </Button>
              <Button type="button" variant="ghost" className="rounded-full border border-white/10 text-slate-400 hover:bg-white/[0.08]" onClick={onYcWorkflowSkip}>
                Skip
              </Button>
            </div>
          </div>
        ) : null}

        {workflowPickHint ? (
          <div className={cn('rounded-2xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-50', guidedActive && guidedStep && !workflowRuleSheet ? 'mt-6' : '', workflowRuleSheet ? 'mt-4' : '')}>
            Tap the <span className="font-semibold">green-outlined</span> ancillary node on the graph to open the store-rule panel.
          </div>
        ) : null}

        {!workflowRuleSheet ? (
          <div className={cn(guidedActive && guidedStep ? 'mt-6 border-t border-white/10 pt-5' : '')}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-semibold tracking-tight text-slate-300">Decision, Proof, Train</p>
                <p className="mt-1 text-xs text-slate-500">{learningCopy(learningState)}</p>
              </div>
              {learningState === 'promoted' ? <CheckCircle2 className="h-5 w-5 shrink-0 text-[#9DBDFF]" /> : null}
            </div>
            <button
              type="button"
              className="mt-5 flex w-full items-center justify-between rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-sm text-slate-300 transition hover:bg-white/[0.08] hover:text-slate-100"
              onClick={onReasoning}
            >
              <span className="flex items-center gap-2">
                <span className="h-4 w-8 rounded-full border border-white/10 bg-[#111923] p-0.5">
                  <span className="block h-3 w-3 rounded-full bg-[#5f748f]" />
                </span>
                Inspect correction
              </span>
              <ChevronRight className="h-4 w-4 shrink-0" />
            </button>
            <Button type="button" variant="ghost" className="mt-3 h-9 w-full rounded-full border border-white/10 text-xs text-slate-400 hover:bg-white/[0.08] hover:text-slate-100" onClick={onHotel}>
              Show whole brain
            </Button>
          </div>
        ) : (
          <div className="mt-6 border-t border-white/10 pt-5">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-sm text-slate-300 transition hover:bg-white/[0.08] hover:text-slate-100"
              onClick={onReasoning}
            >
              <span>Back to Nava reasoning</span>
              <ChevronRight className="h-4 w-4 shrink-0" />
            </button>
            <Button type="button" variant="ghost" className="mt-3 h-9 w-full rounded-full border border-white/10 text-xs text-slate-400 hover:bg-white/[0.08] hover:text-slate-100" onClick={onHotel}>
              Show whole brain
            </Button>
          </div>
        )}
      </section>
    </>
  );
}

function MiniProof({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#9DBDFF]">{title}</p>
      <div className="mt-3 space-y-2">
        {lines.map((line) => (
          <p key={line} className="h-auto rounded-2xl bg-white/[0.055] px-3 py-2 text-sm leading-5 text-slate-300">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

function ReasoningOverlay({
  graph,
  ycDemoStage,
  learningState,
  trainingOverlay,
  onBack,
  onHotel,
  onSelectTraceNode,
  onShowNodeInFocus,
  onStageChange,
  onEnterWorkflowGraphPreview,
  onApprove,
  onJustThisOnce,
  onSkip,
}: {
  graph: AiOpsBrainGraph;
  ycDemoStage?: YcVolleyballDemoStage;
  learningState: LearningState;
  trainingOverlay: AiOpsBrainTrainingOverlay | null;
  onBack: () => void;
  onHotel: () => void;
  onSelectTraceNode: (nodeId: string) => void;
  onShowNodeInFocus: (nodeId: string) => void;
  onStageChange?: (stage: YcVolleyballDemoStage) => void;
  onEnterWorkflowGraphPreview: () => void;
  onApprove: () => void;
  onJustThisOnce: () => void;
  onSkip: () => void;
}) {
  const hasDelta = learningState !== 'live';
  const stage = ycDemoStage ?? 'reasoning';
  const [selectedTraceId, setSelectedTraceId] = useState('trace-missed-ancillary');
  const [traceRows, setTraceRows] = useState<AiOpsBrainOperatorTraceEvent[]>(() => [...graph.operatorTrace]);

  const selectedTrace =
    traceRows.find((event) => event.id === selectedTraceId) ??
    traceRows.find((event) => event.status === 'missed') ??
    traceRows[0];
  const isTeaching = stage === 'teaching';
  const isPreview = stage === 'workflow-preview';
  const isStored = stage === 'stored';

  const moveTrace = (index: number, dir: -1 | 1) => {
    const next = index + dir;
    if (next < 0 || next >= traceRows.length) return;
    setTraceRows((rows) => {
      const copy = [...rows];
      const tmp = copy[index]!;
      copy[index] = copy[next]!;
      copy[next] = tmp;
      return copy;
    });
  };

  const addDemoTraceRow = () => {
    const id = `trace-demo-${Date.now()}`;
    const row: AiOpsBrainOperatorTraceEvent = {
      id,
      title: 'Sarah note (demo)',
      status: 'missed',
      kind: 'gap',
      actor: 'Nava',
      timestamp: '—',
      summary: 'Presenter-added trace line (demo only).',
      detail: 'Use ↑/↓ to reorder. Click row to teach from it.',
      nodeId: 'group-gelato',
      evidence: [],
      output: '',
    };
    setTraceRows((r) => [...r, row]);
    setSelectedTraceId(id);
    onStageChange?.('teaching');
  };

  return (
    <div className="absolute inset-0 z-20 grid grid-cols-1 gap-5 overflow-y-auto p-6 pt-24 lg:grid-cols-2 lg:gap-6">
      <main className="min-w-0 rounded-[34px] border border-white/10 bg-[#070A0E]/90 p-7 shadow-2xl shadow-black/45 backdrop-blur-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-[#8FB4FF]">Nava reasoning</p>
            <h2 className="mt-3 text-4xl font-semibold tracking-[-0.05em] text-slate-100">What Nava checked, skipped, and learned</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              {isStored
                ? 'Stored rule summary below. Graph preview already ran from Teach Nava.'
                : isPreview
                  ? 'You left graph rule preview — reopen it to see the green ancillary node on the run map.'
                  : "Sarah reviews Nava&apos;s trace after send, then teaches the missing decision logic."}
            </p>
          </div>
          <Button type="button" variant="ghost" className="rounded-full border border-white/10 px-4 text-slate-400 hover:bg-white/[0.08]" onClick={onBack}>
            Back to run
          </Button>
        </div>

        {isStored ? (
          <WorkflowPreview graph={graph} isStored={isStored} onApprove={onApprove} onJustThisOnce={onJustThisOnce} onSkip={onSkip} onHotel={onHotel} />
        ) : isPreview ? (
          <div className="mt-8 rounded-3xl border border-emerald-300/20 bg-emerald-300/[0.06] p-6">
            <p className="text-sm leading-6 text-slate-200">
              Rule preview lives on the <span className="font-semibold text-emerald-100">live run graph</span> (green pulse on ancillary / gelato). Use Teach Nava → Preview workflow update to jump there.
            </p>
            <Button type="button" className="mt-4 rounded-full bg-[#9DBDFF] text-slate-950 hover:bg-[#B7CCFF]" onClick={onEnterWorkflowGraphPreview}>
              Open graph preview
            </Button>
          </div>
        ) : (
          <div className="mt-8 space-y-2">
            <div className="overflow-hidden rounded-3xl border border-white/10 bg-black/20">
              {traceRows.map((event, index) => (
                <div key={event.id} className="flex items-stretch border-b border-white/8 last:border-b-0">
                  <TraceLedgerRow
                    event={event}
                    active={event.id === selectedTrace.id}
                    onSelect={() => {
                      setSelectedTraceId(event.id);
                      onSelectTraceNode(event.nodeId);
                      onStageChange?.(event.status === 'missed' ? 'teaching' : 'reasoning');
                    }}
                  />
                  <div className="flex shrink-0 flex-col justify-center gap-0.5 border-l border-white/8 bg-black/30 px-1 py-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 rounded-md text-slate-400 hover:bg-white/[0.08] hover:text-slate-100"
                      disabled={index === 0}
                      aria-label="Move trace row up"
                      onClick={(e) => {
                        e.stopPropagation();
                        moveTrace(index, -1);
                      }}
                    >
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 rounded-md text-slate-400 hover:bg-white/[0.08] hover:text-slate-100"
                      disabled={index >= traceRows.length - 1}
                      aria-label="Move trace row down"
                      onClick={(e) => {
                        e.stopPropagation();
                        moveTrace(index, 1);
                      }}
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <Button type="button" variant="ghost" className="w-full rounded-2xl border border-dashed border-white/15 py-3 text-sm text-slate-400 hover:bg-white/[0.05] hover:text-slate-200" onClick={addDemoTraceRow}>
              <Plus className="mr-2 inline h-4 w-4 align-text-bottom" />
              Add trace note (demo)
            </Button>
          </div>
        )}
      </main>

      <aside className="min-w-0 rounded-[28px] border border-white/10 bg-[#080C10]/88 p-6 shadow-2xl shadow-black/45 backdrop-blur-2xl lg:p-7">
        {isStored ? (
          <>
            <RuleMetadata graph={graph} trainingOverlay={trainingOverlay} />
            {isStored || hasDelta ? <BrainDelta graph={graph} learningState={isStored ? 'promoted' : learningState} /> : null}
          </>
        ) : isPreview ? (
          <div>
            <RuleMetadata graph={graph} trainingOverlay={trainingOverlay} />
            <p className="mt-4 text-xs leading-5 text-slate-500">
              Full before/after path + actions: use <span className="font-medium text-slate-400">Open graph preview</span> on the left, then select the green node on the graph.
            </p>
          </div>
        ) : (
          <TeachingPanel
            event={selectedTrace}
            active={isTeaching}
            onEnterWorkflowGraphPreview={onEnterWorkflowGraphPreview}
            onShowNode={() => onShowNodeInFocus(selectedTrace.nodeId)}
          />
        )}
      </aside>
    </div>
  );
}

function TraceLedgerRow({
  event,
  active,
  onSelect,
}: {
  event: AiOpsBrainGraph['operatorTrace'][number];
  active: boolean;
  onSelect: () => void;
}) {
  const theme =
    event.kind === 'api'
      ? 'border-sky-400/30 bg-sky-400/10 text-sky-100'
      : event.status === 'missed'
        ? 'border-amber-300/35 bg-amber-300/10 text-amber-100'
        : 'border-white/10 bg-white/[0.035] text-slate-200';

  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      onClick={onSelect}
      className={cn(
        'grid min-w-0 flex-1 cursor-pointer grid-cols-[72px_92px_minmax(0,1fr)] items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.055]',
        active && 'bg-white/[0.07]',
      )}
    >
      <span className="font-mono text-[11px] text-slate-500">{event.timestamp}</span>
      <span className={cn('rounded-full border px-2 py-1 text-center text-[10px] font-semibold uppercase tracking-[0.16em]', theme)}>
        {event.kind === 'gap' ? 'missed' : event.kind}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-slate-100">{event.title}</span>
        <span className="block truncate text-sm text-slate-400">{event.summary}</span>
        {event.status === 'missed' ? (
          <span className="mt-1 inline-block rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-100">
            Sarah fills this gap
          </span>
        ) : null}
      </span>
    </div>
  );
}

function TeachingPanel({
  event,
  active,
  onEnterWorkflowGraphPreview,
  onShowNode,
}: {
  event: AiOpsBrainGraph['operatorTrace'][number];
  active: boolean;
  onEnterWorkflowGraphPreview: () => void;
  onShowNode: () => void;
}) {
  const [sarahNote, setSarahNote] = useState(YC_SARAH_TEACHING_NOTE);
  const [tagOn, setTagOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(YC_SARAH_TEACHING_TAGS.map((t) => [t, true])),
  );

  return (
    <div>
      <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Teach Nava</p>
      <h3 className="mt-3 text-2xl font-semibold tracking-tight text-slate-100">
        {active ? 'What did Nava miss?' : 'Click a missed row'}
      </h3>
      <p className="mt-3 text-sm leading-6 text-slate-400">{event.detail}</p>
      <button type="button" className="mt-4 rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-400 hover:bg-white/[0.08] hover:text-slate-100" onClick={onShowNode}>
        Show node on graph
      </button>

      {active ? (
        <div className="mt-5 space-y-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Tags Sarah applies to this teach</p>
            <p className="mt-1 text-xs text-slate-500">Tap to toggle (demo — not saved).</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {YC_SARAH_TEACHING_TAGS.map((tag) => {
                const on = tagOn[tag] ?? false;
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setTagOn((m) => ({ ...m, [tag]: !on }))}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                      on
                        ? 'border-[#9DBDFF]/40 bg-[#9DBDFF]/15 text-[#D7E2FF]'
                        : 'border-white/10 bg-white/[0.03] text-slate-500 line-through opacity-70',
                    )}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200/90">Sarah&apos;s addition (editable demo)</p>
            <textarea
              className="mt-2 min-h-[120px] w-full resize-y rounded-2xl border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm leading-6 text-emerald-50 placeholder:text-emerald-200/40 focus:border-emerald-400/50 focus:outline-none focus:ring-1 focus:ring-emerald-400/30"
              value={sarahNote}
              onChange={(e) => setSarahNote(e.target.value)}
              spellCheck={false}
            />
          </div>

          <Button type="button" className="w-full rounded-full bg-[#9DBDFF] text-slate-950 hover:bg-[#B7CCFF]" onClick={onEnterWorkflowGraphPreview}>
            Preview workflow update
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function WorkflowPathSegments({ segments }: { segments: { label: string; kind: 'default' | 'new' }[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-2">
      {segments.map((seg, i) => (
        <span key={`${seg.label}-${i}`} className="contents">
          {i > 0 ? <ChevronRight className="mx-0.5 h-4 w-4 shrink-0 text-slate-600" aria-hidden /> : null}
          <span
            className={cn(
              'shrink-0 rounded-full border px-3 py-2 text-xs font-medium',
              seg.kind === 'new'
                ? 'border-emerald-300/35 bg-emerald-300/12 font-semibold text-emerald-50'
                : 'border-white/10 bg-white/[0.04] text-slate-300',
            )}
          >
            {seg.kind === 'new' ? `+ ${seg.label}` : seg.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function WorkflowPreview({
  graph,
  isStored,
  onApprove,
  onJustThisOnce,
  onSkip,
  onHotel,
}: {
  graph: AiOpsBrainGraph;
  isStored: boolean;
  onApprove: () => void;
  onJustThisOnce: () => void;
  onSkip: () => void;
  onHotel: () => void;
}) {
  const proposal = graph.workflowProposal;
  const insertAfter = 2;
  const beforeSegments = proposal.beforePath.map((label) => ({ label, kind: 'default' as const }));
  const afterSegments = [
    ...proposal.beforePath.slice(0, insertAfter).map((label) => ({ label, kind: 'default' as const })),
    ...proposal.proposedNodes.map((n) => ({ label: n.label, kind: 'new' as const })),
    ...proposal.beforePath.slice(insertAfter).map((label) => ({ label, kind: 'default' as const })),
  ];
  const headline = isStored ? 'Added to hotel brain' : (proposal.valueHeadline ?? 'Nava proposes a safer path');
  const detail = isStored ? proposal.ruleText : (proposal.valueDetail ?? proposal.ruleText);
  const moment = proposal.teachingMoment;

  return (
    <div className="mt-8 space-y-8">
      {!isStored && moment ? (
        <div className="rounded-2xl border border-amber-300/20 border-l-amber-300/70 bg-amber-300/[0.06] px-4 py-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/95">Why you&apos;re seeing this</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-200">{moment}</p>
        </div>
      ) : null}

      <div className="rounded-[28px] border border-white/12 bg-gradient-to-br from-white/[0.07] via-[#070A0E] to-[#070A0E] p-6 shadow-inner shadow-black/20">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-100">
            {isStored ? 'Stored rule' : 'Workflow update'}
          </span>
          {!isStored ? (
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] text-slate-400">
              +{proposal.proposedNodes.length} internal step{proposal.proposedNodes.length === 1 ? '' : 's'} before guest promises
            </span>
          ) : null}
        </div>
        <h3 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-slate-50">{headline}</h3>
        <p className="mt-4 max-w-3xl text-[15px] leading-7 text-slate-300">{detail}</p>
        {!isStored && proposal.action ? (
          <p className="mt-4 rounded-2xl border border-[#9DBDFF]/20 bg-[#9DBDFF]/10 px-4 py-3 text-sm leading-6 text-[#D7E4FF]">
            <span className="font-semibold text-[#B8CEFF]">Internal action Nava will queue: </span>
            {proposal.action}
          </p>
        ) : null}
        {!isStored && proposal.checks.length > 0 ? (
          <div className="mt-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Checks Nava adds</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {proposal.checks.map((c) => (
                <span
                  key={c}
                  className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-50"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Policy summary (stored verbatim)</p>
        <p className="mt-2 text-sm leading-6 text-slate-400">{proposal.ruleText}</p>
      </div>

      <div>
        <p className="text-sm font-semibold text-slate-100">Automation path</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Linear order Nava executes. New steps sit between inventory hold and standard review so nothing reaches the guest draft unchecked.
        </p>
        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Before (today)</p>
            <div className="mt-4 overflow-x-auto pb-1">
              <WorkflowPathSegments segments={beforeSegments} />
            </div>
          </div>
          <div className="rounded-3xl border border-emerald-300/30 bg-emerald-300/[0.07] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">After (with this rule)</p>
            <div className="mt-4 overflow-x-auto pb-1">
              <WorkflowPathSegments segments={afterSegments} />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <FactPill label="Runs when" value={proposal.trigger} />
        <FactPill label="Hard guardrail" value={proposal.guardrail} />
        <FactPill label="Scope" value={proposal.defaultScope} />
      </div>

      <div className="flex flex-wrap gap-2">
        {isStored ? (
          <Button type="button" className="rounded-full bg-[#9DBDFF] text-slate-950 hover:bg-[#B7CCFF]" onClick={onHotel}>
            Zoom out to hotel brain
          </Button>
        ) : (
          <>
            <Button type="button" className="rounded-full bg-[#9DBDFF] text-slate-950 hover:bg-[#B7CCFF]" onClick={onApprove}>
              Add to hotel brain
            </Button>
            <Button type="button" variant="ghost" className="rounded-full border border-white/10 text-slate-300 hover:bg-white/[0.08]" onClick={onJustThisOnce}>
              Use once
            </Button>
            <Button type="button" variant="ghost" className="rounded-full border border-white/10 text-slate-400 hover:bg-white/[0.08]" onClick={onSkip}>
              Skip
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function FactPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm leading-5 text-slate-200">{value}</p>
    </div>
  );
}

function RuleMetadata({ graph, trainingOverlay }: { graph: AiOpsBrainGraph; trainingOverlay?: AiOpsBrainTrainingOverlay | null }) {
  const rule = graph.storedRule;
  const overlay = trainingOverlay ?? null;
  const status = overlay?.ruleStatus ?? rule.status;
  const applied = overlay?.appliedCount ?? rule.appliedCount;
  const contradicted = overlay?.contradictedCount ?? rule.contradictedCount;
  const reviewState = overlay?.reviewState ?? rule.reviewState;
  const rows = [
    ['Hotel', rule.hotel],
    ['Actor', rule.actor],
    ['Edit type', rule.editType],
    ['Scope', rule.scope],
    ['Rule status', status],
    ['Review state', reviewState],
    ['Last trained', new Date(rule.lastTrained).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })],
    ['Applied / contradicted', `${applied} / ${contradicted}`],
  ];

  return (
    <>
      <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Stored rule</p>
      <h3 className="mt-3 text-2xl font-semibold tracking-tight text-slate-100">{rule.title}</h3>
      <p className="mt-3 rounded-2xl border border-[#9DBDFF]/20 bg-[#9DBDFF]/8 p-4 text-sm leading-6 text-slate-200">{rule.ruleText}</p>
      <div className="mt-5 space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-white/8 bg-white/[0.025] px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
            <p className="mt-1 text-sm text-slate-300">{value}</p>
          </div>
        ))}
      </div>
    </>
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
  trainingOverlay,
  showGuidedDemo,
  guidedStep,
  guidedStepIndex,
  demoStepCount,
  onGuidedNext,
  onGuidedPrev,
  onGuidedExit,
}: {
  graph: AiOpsBrainGraph;
  activeTourId: TourId;
  onTourChange: (tourId: TourId) => void;
  trainingOverlay: AiOpsBrainTrainingOverlay | null;
  showGuidedDemo: boolean;
  guidedStep?: DemoStep;
  guidedStepIndex: number | null;
  demoStepCount: number;
  onGuidedNext: () => void;
  onGuidedPrev: () => void;
  onGuidedExit: () => void;
}) {
  const activeTour = graph.tours.find((tour) => tour.id === activeTourId) ?? graph.tours[0]!;
  const guidedHotel = Boolean(showGuidedDemo && guidedStep?.detailKind === 'hotel' && guidedStepIndex !== null);

  return (
    <>
      <section className="absolute left-6 top-24 z-20 max-w-xl rounded-[28px] border border-white/10 bg-[#080C10]/88 p-5 shadow-2xl shadow-black/45 backdrop-blur-2xl">
        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Whole hotel brain</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-100">{activeTour.title}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">{activeTour.description}</p>
        {guidedHotel ? (
          <p className="mt-4 rounded-2xl border border-[#9DBDFF]/20 bg-[#9DBDFF]/8 p-3 text-sm text-slate-200">
            Guided step: {guidedStep!.title}. Use tour chips below to spotlight risk and learning overlays on the graph.
          </p>
        ) : null}
      </section>

      <aside className="absolute right-6 top-24 z-20 hidden max-h-[calc(100vh-170px)] w-[360px] overflow-y-auto rounded-[28px] border border-white/10 bg-[#080C10]/90 p-5 shadow-2xl shadow-black/45 backdrop-blur-2xl xl:block">
        <RuleMetadata graph={graph} trainingOverlay={trainingOverlay} />
      </aside>

      <div className="absolute bottom-6 left-1/2 z-20 flex max-w-[95vw] -translate-x-1/2 flex-col items-center gap-3">
        {guidedHotel ? (
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-full border border-white/10 bg-[#080C10]/88 px-3 py-2 shadow-2xl shadow-black/45 backdrop-blur-2xl">
            <span className="px-2 text-xs text-slate-500">
              Demo {(guidedStepIndex ?? 0) + 1}/{demoStepCount}
            </span>
            <Button type="button" variant="ghost" size="sm" className="rounded-full border border-white/10 text-slate-300 hover:bg-white/[0.08]" onClick={onGuidedPrev}>
              Back
            </Button>
            <Button type="button" size="sm" className="rounded-full bg-[#9DBDFF] text-slate-950 hover:bg-[#B7CCFF]" onClick={onGuidedNext}>
              {guidedStepIndex !== null && guidedStepIndex >= demoStepCount - 1 ? 'Finish' : 'Next'}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="rounded-full text-xs text-slate-500 hover:bg-white/[0.08]" onClick={onGuidedExit}>
              Exit tour
            </Button>
          </div>
        ) : null}
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
          </div>
        </div>
      </div>
    </>
  );
}

function useBrainNodes({
  graph,
  selectedNodeId,
  onSelectNode,
  learningState,
  mode,
  activeTourNodeIds,
  demoWorkflowHighlightNodeId,
}: {
  graph: AiOpsBrainGraph;
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
  learningState: LearningState;
  mode: BrainMode;
  activeTourNodeIds: string[];
  demoWorkflowHighlightNodeId?: string;
}): Node[] {
  return useMemo(() => {
    const focusIds = focusNodeIds(graph);
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
      const inFocusPath = focusIds.has(node.id);
      const inTour = activeTourNodeIds.includes(node.id);
      const visibleInFocus = mode !== 'focus' || inFocusPath || node.focus === 'hero';
      const nextNode: AiOpsBrainGraphNode = promoted
        ? { ...node, status: 'live', confidence: Math.max(node.confidence, 86) }
        : weak
          ? { ...node, status: 'weak-signal' }
          : node;
      const demoHighlight = Boolean(demoWorkflowHighlightNodeId && node.id === demoWorkflowHighlightNodeId);

      return {
        id: node.id,
        type: 'brainNode',
        position: mode === 'focus' && inFocusPath ? focusPosition(node.id, node.position) : node.position,
        data: {
          node: nextNode,
          selectedNodeId,
          onSelectNode,
          demoWorkflowHighlight: demoHighlight,
        },
        draggable: false,
        hidden: !visibleInFocus,
        selectable: mode !== 'reasoning',
        zIndex: mode === 'focus' && inFocusPath ? 20 : inTour ? 12 : node.focus === 'hero' ? 10 : 2,
        style: {
          opacity:
            mode === 'hotel'
              ? inTour
                ? 1
                : 0.22
              : mode === 'reasoning'
                ? 0.24
                : demoHighlight
                  ? 1
                  : inFocusPath
                    ? 1
                    : 0.08,
          filter: mode === 'hotel' || inFocusPath || demoHighlight ? 'none' : 'grayscale(1)',
        },
      };
    });

    return [...laneNodes, ...brainNodes];
  }, [activeTourNodeIds, demoWorkflowHighlightNodeId, graph, learningState, mode, onSelectNode, selectedNodeId]);
}

function focusNodeIds(graph: AiOpsBrainGraph) {
  return new Set(graph.focusRun.primaryNodeIds);
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
  return useMemo(() => {
    if (mode === 'focus') {
      return graph.focusRun.segments.map((segment) => ({
        id: `focus-${segment.id}`,
        source: segment.sourceNodeId,
        target: segment.targetNodeId,
        type: 'smoothstep',
        label: segment.label,
        animated: true,
        style: {
          stroke: '#9DBDFF',
          strokeWidth: 2.7,
          opacity: 0.96,
          filter: 'drop-shadow(0 0 8px rgba(157,189,255,0.85)) drop-shadow(0 0 18px rgba(157,189,255,0.35))',
        },
        labelStyle: {
          fill: '#C8D8FF',
          fontSize: 12,
          fontWeight: 600,
        },
        labelBgStyle: {
          fill: 'rgba(7, 16, 26, 0.92)',
          stroke: 'rgba(157, 189, 255, 0.24)',
        },
        labelBgPadding: [10, 6] as [number, number],
        labelBgBorderRadius: 999,
      }));
    }

    return graph.edges.map((edge) => {
        const promoted =
          learningState === 'promoted' &&
          ['e-room-plan-youth', 'e-youth-gelato', 'e-gelato-calendar', 'e-calendar-approval', 'e-gelato-approval'].includes(edge.id);
        const inTour = activeTourNodeIds.includes(edge.source) || activeTourNodeIds.includes(edge.target);
        const theme = EDGE_THEME[promoted ? 'live' : edge.status];

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'smoothstep',
          label: edge.label,
          ...theme,
          animated: theme.animated,
          style: {
            ...theme.style,
            opacity: mode === 'hotel' ? (inTour ? theme.style?.opacity ?? 0.8 : 0.16) : 0.18,
            strokeWidth: theme.style?.strokeWidth,
          },
        };
      });
  }, [activeTourNodeIds, graph.edges, graph.focusRun.segments, learningState, mode]);
}

function focusPosition(nodeId: string, fallback: AiOpsBrainGraphNode['position']): AiOpsBrainGraphNode['position'] {
  const positions: Record<string, AiOpsBrainGraphNode['position']> = {
    'email-received': { x: 0, y: 500 },
    'group-availability': { x: 280, y: 500 },
    'group-room-plan': { x: 560, y: 500 },
    'group-gelato': { x: 840, y: 420 },
    'group-calendar': { x: 1080, y: 500 },
    'group-gm-approval': { x: 1320, y: 500 },
    'group-draft': { x: 1560, y: 500 },
    'group-learn': { x: 1800, y: 500 },
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
