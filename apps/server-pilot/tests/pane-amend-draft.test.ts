import { describe, expect, it } from 'vitest';
import { mailExtractionSchema, sanitizeExtraction } from '../src/ai/extraction/schema.js';
import { amendRequestId, projectAmendRequests, validAmendRequestValue } from '../src/ai/pane-amend-draft.js';
import { paneStateOf, withPaneState } from '../src/ai/work-item-revision.js';
import { AE1_OUTPUT } from './fixtures/inbound-extraction.js';

const ACTION_OUTPUT = { ...AE1_OUTPUT, needsAction: true, action: 'amend' as const, actionEvidence: 'Please change the rate to BAR.', actionConfidence: 'high' as const };

describe('amendment request draft', () => {
  it('undo restores request edits without rolling back HMS commit state', () => {
    const key = `requests[${'a'.repeat(64)}].ratePlan`;
    const before = { [key]: 'BAR', stays: { committed: { confirmationNumber: '123456-1' } } };
    const after = { [key]: 'CRIC', stays: before.stays };
    expect(withPaneState(after, paneStateOf(before))).toEqual(before);
    expect(withPaneState(after, {})).toEqual({ stays: before.stays });
  });
  it('keeps current amendment requests, rejects quoted history and preserves a staff false override', () => {
    const current = 'Please change the rate to BAR. Do not send the confirmation.';
    const history = 'Guest name is Alice';
    const body = `${current}\nFrom: previous@example.com\n${history}`;
    const parsed = mailExtractionSchema.parse({
      ...ACTION_OUTPUT,
      kind: 'amendment',
      action: 'amend',
      stays: [{
        ...AE1_OUTPUT.stays[0]!,
        action: 'amend',
        amendProposal: {
          ratePlan: { value: 'BAR', excerpt: 'change the rate to BAR', attributedTo: null },
          firstName: { value: 'Alice', excerpt: history, attributedTo: 'guest' },
          cmsSend: { value: false, excerpt: 'Do not send the confirmation', attributedTo: null },
        },
      }],
    });
    const { payload } = sanitizeExtraction(parsed, { messageId: 'msg-amend', sourceText: body, currentMessageText: body });
    const stay = payload.stays[0]!;
    expect(stay.amendProposal).toMatchObject({ ratePlan: { value: 'BAR' }, cmsSend: { value: false } });
    expect(stay.amendProposal).not.toHaveProperty('firstName');
    const source = { threadId: 'thread', messageId: 'msg-amend', sourceHash: 'a'.repeat(64) };
    const id = amendRequestId(source, stay.id);
    const state = { [`requests[${id}].ratePlan`]: 'CRIC', [`requests[${id}].cms.send`]: false };
    const result = projectAmendRequests(source, payload, state);
    expect(result.requests[0]?.fields.value).toMatchObject({ ratePlan: 'CRIC', cms: { send: false } });
    expect(result.meta[`requests[${id}].cms.send`]?.origin).toBe('staff');
    expect(projectAmendRequests({ ...source, sourceHash: 'b'.repeat(64) }, payload, state).unappliedEdits).toHaveLength(2);
    expect(validAmendRequestValue('cms.send', false)).toBe(true);
    expect(validAmendRequestValue('childAges', [0, 17])).toBe(true);
    expect(validAmendRequestValue('childAges', [18])).toBe(false);
    expect(validAmendRequestValue('roomType', 'DLX')).toBe(true);
    expect(validAmendRequestValue('target', { confirmation: '123456-1', arrival: '2027-12-01', other: true })).toBe(false);
  });

});
