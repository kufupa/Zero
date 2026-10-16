import { afterEach, describe, expect, it } from 'vitest';
import {
  BODY_HEAD_CHARS,
  COARSE_TO_AGENT,
  COARSE_WORKFLOWS,
  WORKFLOW_CLASSIFIER_DEF,
  agentDecisionToCoarseWorkflow,
  buildClassifierPrompt,
  classifyWorkflow,
  classifierInputFromSelection,
  formatWorkflowHint,
  panePreclassifyEnabled,
  parseClassifierOutput,
  shouldAttachWorkflowHint,
} from '../src/ai/workflow-classifier/index.js';

describe('buildClassifierPrompt', () => {
  it('uses the 9-class DEF, subject, attachment names, and first 600 body chars', () => {
    const body = `${'a'.repeat(BODY_HEAD_CHARS)}TAIL-MUST-DROP`;
    const prompt = buildClassifierPrompt({
      subject: 'Please book 12 Nov',
      attachmentNames: ['voucher.pdf', 'id.jpg'],
      bodyHead: body.slice(0, BODY_HEAD_CHARS),
    });
    expect(prompt).toContain(WORKFLOW_CLASSIFIER_DEF);
    expect(prompt).toContain('Subject: Please book 12 Nov');
    expect(prompt).toContain('Attachments: voucher.pdf, id.jpg');
    expect(prompt).toContain('Body start: ' + 'a'.repeat(BODY_HEAD_CHARS));
    expect(prompt).not.toContain('TAIL-MUST-DROP');
    expect(prompt).toMatch(/Return JSON only/);
  });
});

describe('classifierInputFromSelection', () => {
  it('takes attachment filenames and truncates the body to 600 chars', () => {
    const input = classifierInputFromSelection({
      subject: 'Invoice please',
      bodyText: 'x'.repeat(900),
      attachments: [{ filename: 'folio.pdf' }, { filename: '' }],
    });
    expect(input).toEqual({
      subject: 'Invoice please',
      attachmentNames: ['folio.pdf'],
      bodyHead: 'x'.repeat(BODY_HEAD_CHARS),
    });
  });
});

describe('parseClassifierOutput', () => {
  it('reads workflow + confidence from JSON, including fenced text', () => {
    expect(parseClassifierOutput('{"workflow":"amend","confidence":"high"}')).toEqual({
      workflow: 'amend',
      confidence: 'high',
    });
    expect(
      parseClassifierOutput('here\n```json\n{"workflow":"cancel","confidence":"medium"}\n```'),
    ).toEqual({ workflow: 'cancel', confidence: 'medium' });
  });

  it('returns null for unknown class, bad confidence, or garbage', () => {
    expect(parseClassifierOutput('{"workflow":"create","confidence":"high"}')).toBeNull();
    expect(parseClassifierOutput('{"workflow":"amend","confidence":"sure"}')).toBeNull();
    expect(parseClassifierOutput('not json')).toBeNull();
  });
});

describe('hint helpers', () => {
  it('formats the exact agent hint and maps coarse class onto the catalog', () => {
    expect(formatWorkflowHint({ workflow: 'new_booking', confidence: 'high' })).toBe(
      'Workflow (pre-classified, confidence high): create. Override only with clear evidence.',
    );
    expect(COARSE_TO_AGENT.group_event).toBe('forward_to_partner');
    expect(COARSE_WORKFLOWS).toHaveLength(9);
  });

  it('attaches high and medium hints, not low', () => {
    expect(shouldAttachWorkflowHint('high')).toBe(true);
    expect(shouldAttachWorkflowHint('medium')).toBe(true);
    expect(shouldAttachWorkflowHint('low')).toBe(false);
  });
});

describe('panePreclassifyEnabled', () => {
  const prev = process.env.PANE_PRECLASSIFY;
  afterEach(() => {
    if (prev === undefined) delete process.env.PANE_PRECLASSIFY;
    else process.env.PANE_PRECLASSIFY = prev;
  });

  it('is on only when PANE_PRECLASSIFY=on', () => {
    delete process.env.PANE_PRECLASSIFY;
    expect(panePreclassifyEnabled()).toBe(false);
    process.env.PANE_PRECLASSIFY = 'off';
    expect(panePreclassifyEnabled()).toBe(false);
    process.env.PANE_PRECLASSIFY = 'on';
    expect(panePreclassifyEnabled()).toBe(true);
  });
});

describe('classifyWorkflow', () => {
  it('one invoke, parsed result', async () => {
    const invoke = async (prompt: string) => {
      expect(prompt).toContain('Subject: POP attached');
      return '{"workflow":"payment_proof","confidence":"medium"}';
    };
    await expect(
      classifyWorkflow(
        { subject: 'POP attached', attachmentNames: ['pop.pdf'], bodyHead: 'Please find payment.' },
        { invoke },
      ),
    ).resolves.toEqual({ workflow: 'payment_proof', confidence: 'medium' });
  });

  it('returns null when the model misses the schema', async () => {
    await expect(
      classifyWorkflow(
        { subject: 'Hi', attachmentNames: [], bodyHead: 'Thanks' },
        { invoke: async () => 'nope' },
      ),
    ).resolves.toBeNull();
  });
});

describe('agentDecisionToCoarseWorkflow', () => {
  it('maps catalog + hms_todo targets onto the 9-class gold labels', () => {
    expect(agentDecisionToCoarseWorkflow({ workflow: 'quote' })).toBe('quote_availability');
    expect(agentDecisionToCoarseWorkflow({ workflow: 'create' })).toBe('new_booking');
    expect(agentDecisionToCoarseWorkflow({ workflow: 'payment_ack' })).toBe('payment_proof');
    expect(agentDecisionToCoarseWorkflow({ workflow: 'send_document' })).toBe('billing');
    expect(agentDecisionToCoarseWorkflow({ workflow: 'forward_to_partner' })).toBe('group_event');
    expect(agentDecisionToCoarseWorkflow({ workflow: 'skip' })).toBe('no_action');
    expect(agentDecisionToCoarseWorkflow({ workflow: 'spam' })).toBe('no_action');
    expect(agentDecisionToCoarseWorkflow({ workflow: 'acknowledge' })).toBe('no_action');
    expect(agentDecisionToCoarseWorkflow({ workflow: 'other' })).toBe('other_actionable');
    expect(agentDecisionToCoarseWorkflow({ workflow: 'clarify' })).toBe('other_actionable');
    expect(agentDecisionToCoarseWorkflow({ workflow: 'hms_todo', todoTarget: 'create' })).toBe(
      'new_booking',
    );
    expect(agentDecisionToCoarseWorkflow({ workflow: 'hms_todo', todoTarget: 'post_payment' })).toBe(
      'payment_proof',
    );
    expect(agentDecisionToCoarseWorkflow({ workflow: 'hms_todo', todoTarget: 'read' })).toBe(
      'other_actionable',
    );
  });
});
