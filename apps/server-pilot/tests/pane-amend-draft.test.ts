import { describe, expect, it } from 'vitest';
import { mailExtractionSchema, sanitizeExtraction } from '../src/ai/extraction/schema.js';
import { amendRequestId, projectAmendRequests, validAmendRequestValue } from '../src/ai/pane-amend-draft.js';
import { paneStateOf, withPaneState } from '../src/ai/work-item-revision.js';
import { amendDraftMatchesForm, cloudAmendFirstPilotScopeSupported, cloudAmendSourceBinding } from '../src/ai/pane-cloud-amend.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { AE1_OUTPUT } from './fixtures/inbound-extraction.js';

const ACTION_OUTPUT = { ...AE1_OUTPUT,
  needsAction: true, action: 'amend' as const, actionEvidence: 'Please change the rate to BAR.', actionConfidence: 'high' as const };

describe('amendment request draft', () => {
  it('does not approve an old total for retained-rate price changes', () => {
    const current = { arrival: '2027-12-20', departure: '2027-12-22', adults: 1, children: 0,
      childAges: [] as number[], roomType: 'STQN', ratePlan: 'BAR', firstName: 'Proof', lastName: 'Labtest' };
    const choices = { retainRates: 'yes' as const, ratePlan: 'BAR', cmsSend: false, cmsMessageId: '', cmsRecipient: '' };
    expect(cloudAmendFirstPilotScopeSupported(current, { ...choices, departure: '2027-12-23' })).toBe(false);
    expect(cloudAmendFirstPilotScopeSupported(current, { ...choices, adults: 2 })).toBe(false);
    expect(cloudAmendFirstPilotScopeSupported(current, { ...choices, roomType: 'STWN' })).toBe(false);
    expect(cloudAmendFirstPilotScopeSupported(current, { ...choices, ratePlan: 'CRIC' })).toBe(false);
    expect(cloudAmendFirstPilotScopeSupported(current, { ...choices, departure: '2027-12-23', retainRates: 'no' })).toBe(true);
    expect(cloudAmendFirstPilotScopeSupported(current, { ...choices, guestEmail: 'guest@example.test' })).toBe(true);
  });
  it('binds an amendment review to the selected extraction stay and revision', () => {
    const parsed = mailExtractionSchema.parse({ ...ACTION_OUTPUT, kind: 'amendment',
      stays: [{ ...ACTION_OUTPUT.stays[0]!, action: 'amend' }] });
    const payload = sanitizeExtraction(parsed, { messageId: 'm1', sourceText: ACTION_OUTPUT.actionEvidence,
      currentMessageText: ACTION_OUTPUT.actionEvidence }).payload;
    const mail = { id: 'm1', transportId: 't1', threadId: 'th1', direction: 'inbound', historyOnly: false,
      subject: 'Change', textBody: 'Please change the rate to BAR.', htmlBody: null, sourceProvenance: null,
      createdAt: new Date('2026-01-01T00:00:00Z') };
    const selected = { threadId: 'th1', messageId: 'm1', sourceHash: staffQuoteSourceHash(mail), extractionId: 'e1' };
    const rows = { mail, thread: { id: 'th1', transportId: 't1', historyOnly: false, trashedAt: null },
      item: { id: 'w1', transportId: 't1', threadId: 'th1', sourceMessageId: 'm1', extractionId: 'e1',
        status: 'open', kind: 'amendment', state: {}, revision: 2, revisionHead: 2, revisionSeq: 3 },
      extraction: { id: 'e1', messageId: 'm1', kind: 'amendment', status: 'succeeded', payload }, attachments: [] };
    const typedRows = rows as unknown as Parameters<typeof cloudAmendSourceBinding>[0];
    const stayId = payload.stays[0]!.id;
    const identity = { requestId: amendRequestId(selected, stayId), stayId };
    expect(cloudAmendSourceBinding(typedRows, selected, 't1', identity)).toMatchObject({ draft: identity, revisionSeq: 3 });
    expect(cloudAmendSourceBinding(typedRows, selected, 't1', { ...identity, stayId: 'wrong' })).toBeNull();
    expect(cloudAmendSourceBinding(typedRows, selected, 't1', { ...identity, requestId: 'b'.repeat(64) })).toBeNull();
    expect(cloudAmendSourceBinding(typedRows, selected, 't1')).not.toBeNull(); // legacy single-stay form
    const target = { confirmation: '123456-1', arrival: '2027-12-01' };
    const form = { selected, payload, state: { [`requests[${identity.requestId}].target`]: target },
      revisionSeq: 3, ...target, draft: { ...identity, expectedSeq: 3 } };
    expect(amendDraftMatchesForm(form)).toBe(true);
    expect(amendDraftMatchesForm({ ...form, revisionSeq: 4 })).toBe(false);
    expect(amendDraftMatchesForm({ ...form, confirmation: '654321-1' })).toBe(false);
    expect(amendDraftMatchesForm({ ...form, state: { [`requests[${identity.requestId}].target`]: null } })).toBe(false);
    expect(amendDraftMatchesForm({ ...form, draft: undefined })).toBe(true);
    expect(amendDraftMatchesForm({ ...form, draft: undefined,
      payload: { ...payload, stays: [...payload.stays, { ...payload.stays[0], id: 'another' }] } })).toBe(false);
  });
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
        ...ACTION_OUTPUT.stays[0]!,
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
    const arrivalPath = `stays[${stay.id}].requested.arrival`;
    const state = { [`requests[${id}].ratePlan`]: 'CRIC', [`requests[${id}].cms.send`]: false, [arrivalPath]: null };
    const result = projectAmendRequests(source, payload, state);
    expect(result.requests[0]?.fields.value).toMatchObject({ ratePlan: 'CRIC', cms: { send: false } });
    expect(result.meta[`requests[${id}].cms.send`]?.origin).toBe('staff');
    expect(result.meta[arrivalPath]?.origin).toBe('staff');
    expect(result.requests[0]?.fields.value.arrival).toBeNull();
    expect(projectAmendRequests(source, payload, {}).meta[arrivalPath]?.origin)
      .toBe(stay.requested.arrival == null ? 'missing' : 'email');
    expect(projectAmendRequests({ ...source, sourceHash: 'b'.repeat(64) }, payload, state).unappliedEdits).toHaveLength(2);
    expect(validAmendRequestValue('cms.send', false)).toBe(true);
    expect(validAmendRequestValue('childAges', [0, 17])).toBe(true);
    expect(validAmendRequestValue('childAges', [18])).toBe(false);
    expect(validAmendRequestValue('roomType', 'DLX')).toBe(true);
    expect(validAmendRequestValue('target', { confirmation: '123456-1', arrival: '2027-12-01', other: true })).toBe(false);
  });

});
