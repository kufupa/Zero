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
});
