import { describe, expect, it } from 'vitest';
import {
  AI_OPS_BRAIN_WORKFLOWS,
  getAiOpsBrainGraph,
  getAiOpsBrainGraphForThread,
  getAiOpsBrainWorkflow,
  getAiOpsBrainWorkflowForThread,
} from '../lib/demo/ai-ops-brain';

describe('ai ops brain demo data', () => {
  it('provides a workflow for each hotel demo category', () => {
    expect(Object.keys(AI_OPS_BRAIN_WORKFLOWS).sort()).toEqual([
      'group',
      'individual',
      'internal',
      'travel-agents',
      'urgent',
    ]);
  });

  it('falls back to individual bookings for non-demo folders', () => {
    expect(getAiOpsBrainWorkflow('inbox').id).toBe('individual-booking');
    expect(getAiOpsBrainWorkflow(undefined).id).toBe('individual-booking');
  });

  it('uses urgent workflow ahead of category when thread is urgent', () => {
    const workflow = getAiOpsBrainWorkflowForThread({
      routeFolder: 'group',
      threadCategory: 'group',
      isUrgent: true,
    });

    expect(workflow.id).toBe('urgent-guest-recovery');
  });

  it('uses thread category before route folder', () => {
    const workflow = getAiOpsBrainWorkflowForThread({
      routeFolder: 'inbox',
      threadCategory: 'travel-agents',
      isUrgent: false,
    });

    expect(workflow.id).toBe('travel-agent-rate-check');
  });

  it('models the complete hotel brain across demo categories', () => {
    const graph = getAiOpsBrainGraph();

    expect(graph.lanes.map((lane) => lane.category)).toEqual([
      'internal',
      'individual',
      'group',
      'travel-agents',
      'spam',
    ]);
    expect(graph.overlays.map((overlay) => overlay.id)).toEqual(
      expect.arrayContaining(['urgent', 'needs-approval', 'api-required', 'risk-alert', 'learning-signal']),
    );
  });

  it('highlights the volleyball group booking path as the demo focus', () => {
    const graph = getAiOpsBrainGraphForThread({ threadCategory: 'group' });
    const focusedNodes = graph.nodes.filter((node) => node.focus === 'hero').map((node) => node.id);

    expect(graph.focusPathId).toBe('volleyball-group-booking');
    expect(focusedNodes).toEqual(
      expect.arrayContaining([
        'group-room-plan',
        'group-youth-sports',
        'group-gelato',
        'group-calendar',
        'group-gm-approval',
      ]),
    );
  });

  it('stores just-this-once edits as scoped weak learning signals', () => {
    const graph = getAiOpsBrainGraph();
    const weakSignal = graph.evidence.find((event) => event.kind === 'weak-signal');

    expect(weakSignal).toMatchObject({
      hotel: 'The Centurion',
      actor: 'Sarah Mokoena',
      action: 'Chose Just this once',
      signalStrength: 'weak',
      relatedNodeIds: expect.arrayContaining(['group-youth-sports', 'group-gelato']),
    });
  });

  it('connects internal operational risk alerts to affected booking drafts', () => {
    const graph = getAiOpsBrainGraph();
    const riskAlert = graph.riskAlerts.find((alert) => alert.id === 'third-floor-leak');

    expect(riskAlert).toMatchObject({
      severity: 'high',
      sourceCategory: 'internal',
      affectedCategory: 'group',
      affectedNodeIds: expect.arrayContaining(['group-room-plan', 'group-draft']),
    });
  });

  it('drives the Act -> Review -> Learn -> Brain demo spine', () => {
    const graph = getAiOpsBrainGraph();

    expect(graph.reviewSteps.map((step) => step.status)).toEqual(['done', 'done', 'current', 'queued']);
    expect(graph.reviewSteps.find((step) => step.status === 'current')).toMatchObject({
      id: 'review-gelato',
      nodeId: 'group-gelato',
      action: 'Ask manager before promising guest',
    });
    expect(graph.brainDelta).toMatchObject({
      actor: 'Sarah Mokoena',
      hotel: 'The Centurion',
      affectedNodeIds: expect.arrayContaining(['group-youth-sports', 'group-gelato']),
    });
  });

  it('offers guided whole-brain tour states', () => {
    const graph = getAiOpsBrainGraph();

    expect(graph.tours.map((tour) => tour.id)).toEqual(['categories', 'risk-alerts', 'learning-signals']);
    expect(graph.tours.find((tour) => tour.id === 'risk-alerts')?.nodeIds).toEqual(
      expect.arrayContaining(['internal-risk-alert', 'group-room-plan']),
    );
  });

  it('models focus mode as one continuous compressed run', () => {
    const graph = getAiOpsBrainGraph();

    expect(graph.focusRun.primaryNodeIds).toEqual([
      'email-received',
      'group-availability',
      'group-room-plan',
      'group-gelato',
      'group-calendar',
      'group-gm-approval',
      'group-draft',
      'group-learn',
    ]);
    expect(graph.focusRun.segments).toHaveLength(graph.focusRun.primaryNodeIds.length - 1);
    expect(graph.focusRun.segments.map((segment) => segment.label)).toEqual(
      expect.arrayContaining(['3 evidence reads', '2 ops checks', 'stored SOP']),
    );
  });

  it('stores the operator trace and SOP metadata as first-class demo data', () => {
    const graph = getAiOpsBrainGraph();

    expect(graph.reviewTrace.map((item) => item.type)).toEqual(['evidence', 'decision', 'correction', 'stored-rule']);
    expect(graph.reviewTrace.find((item) => item.type === 'correction')).toMatchObject({
      actor: 'Sarah Mokoena',
      actionLabel: 'Add comment',
      nodeId: 'group-gelato',
    });
    expect(graph.storedRule).toMatchObject({
      id: 'rule-group-ancillary-approval',
      status: 'proposed',
      editType: 'Missing reasoning label',
      affectedSystems: ['PMS room plan', 'F&B calendar', 'Manager approval', 'Guest draft'],
      appliedCount: 0,
      contradictedCount: 0,
    });
  });

  it('stores guided hybrid-demo metadata for live narration and interactions', () => {
    const graph = getAiOpsBrainGraph();
    const ids = new Set(graph.nodes.map((n) => n.id));

    expect(graph.demoSteps.length).toBeGreaterThanOrEqual(9);
    for (const step of graph.demoSteps) {
      expect(ids.has(step.nodeId)).toBe(true);
    }
    expect(graph.apiMocks.length).toBeGreaterThanOrEqual(2);
    expect(graph.draftDiff.navaBody.length).toBeGreaterThan(0);
    expect(graph.trainingOutcomes.weakSignal.ruleStatus).toBe('proposed');
    expect(graph.trainingOutcomes.promoted.ruleStatus).toBe('stored');
  });

  it('includes a YC operator script and lightweight connector story', () => {
    const graph = getAiOpsBrainGraph();

    expect(graph.ycDemoScript.map((beat) => beat.id)).toEqual([
      'open-volleyball-thread',
      'show-bad-draft',
      'make-sarah-edit',
      'teach-workflow',
      'show-api-connectors',
      'show-multi-hotel-scope',
    ]);
    expect(graph.ycDemoScript.find((beat) => beat.id === 'make-sarah-edit')).toMatchObject({
      userAction: expect.stringContaining("Apply Sarah's edit"),
      whyItMatters: expect.stringContaining('workflow'),
    });
    expect(graph.connectorStory.map((connector) => connector.status)).toEqual(['connected', 'connected', 'needs-owner']);
    expect(graph.connectorStory.map((connector) => connector.system)).toEqual(['PMS', 'Room map', 'F&B calendar']);
  });

  it('models the reasoning review as Nava operator trace, not a Sarah edit event', () => {
    const graph = getAiOpsBrainGraph();

    expect(graph.operatorTrace.map((event) => event.id)).toEqual([
      'trace-email',
      'trace-pms',
      'trace-room-logic',
      'trace-draft',
      'trace-missed-ancillary',
      'trace-missed-approval',
    ]);
    expect(graph.operatorTrace.every((event) => event.actor === 'Nava')).toBe(true);
    expect(graph.operatorTrace.map((event) => event.title).join(' ')).not.toMatch(/Sarah edited|human correction/i);
    expect(graph.operatorTrace.filter((event) => event.status === 'missed').map((event) => event.id)).toEqual([
      'trace-missed-ancillary',
      'trace-missed-approval',
    ]);
  });

  it('stores a generalized workflow proposal instead of a volleyball-to-gelato rule', () => {
    const graph = getAiOpsBrainGraph();

    expect(graph.workflowProposal.trigger).toContain('similar group booking');
    expect(graph.workflowProposal.trigger).toContain('children/families');
    expect(graph.workflowProposal.guardrail).toContain('before guest-facing wording');
    expect(graph.workflowProposal.scopeOptions).toEqual(['This hotel', 'All hotels', 'Ask next time']);
    expect(graph.workflowProposal.proposedNodes.map((node) => node.label)).toEqual([
      'Ancillary opportunity check',
      'F&B capacity check',
      'Manager approval gate',
    ]);
    expect(graph.workflowProposal.ruleText).not.toMatch(/volleyball.*gelato|gelato.*volleyball/i);
    expect(graph.workflowProposal.valueHeadline?.length).toBeGreaterThan(10);
    expect(graph.workflowProposal.valueDetail?.length).toBeGreaterThan(40);
    expect(graph.workflowProposal.teachingMoment).toMatch(/Sarah|volleyball/i);
  });
});
