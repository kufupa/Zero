import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CENTURION_CHILD_RULES, extractInboundMail } from '../src/ai/extraction/extract.js';
import { mailExtractionSchema, sanitizeExtraction } from '../src/ai/extraction/schema.js';
import { buildPreparedStaffQuotePlan } from '../src/ai/quote-ready.js';
import { storedAnalysis } from '../src/ai/work-items.js';
import { AE1_OUTPUT, AE1_TEXT, fakeModel, selectionFor } from './fixtures/inbound-extraction.js';

function payload(count: number | null | undefined, ages: number[]) {
  return {
    contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
    confirmationNumbers: [], missing: [], stays: [{
      id: 's_1', hotel: null, requested: { arrival: '2027-10-20', departure: '2027-10-21' },
      booked: null, totalRooms: 1, rows: [{
        id: 'r_1', roomType: null, rooms: 1, adultsPerRoom: 2,
        ...(count === undefined ? {} : { childrenPerRoom: count }), childAges: ages, board: null,
      }],
    }],
  };
}

function plan(source: unknown, propertyCode?: string) {
  return buildPreparedStaffQuotePlan({
    messageId: 'm1', sourceHash: 'a'.repeat(64), payload: source, propertyCode,
    now: new Date('2026-10-01T00:00:00Z'),
  });
}

describe('child occupancy extraction and prefetch', () => {
  it('instructs the model to preserve per-room counts without inventing ages', () => {
    expect(CENTURION_CHILD_RULES).toContain('Do not spread a total across rooms without an explicit allocation');
    expect(CENTURION_CHILD_RULES).toContain('never invent an age or assume an age is zero');
    expect(CENTURION_CHILD_RULES).toContain('0 only if zero children are explicitly stated');
    expect(CENTURION_CHILD_RULES).toContain('null when children are not mentioned');
    expect(JSON.stringify(zodToJsonSchema(mailExtractionSchema))).toContain('0 only when explicitly stated; null when absent or unknown');
  });

  it.each(['HRCEN', 'HRDAV'] as const)('scopes child prompts and synthetic warnings to Centurion, preserving unknown for %s', async (propertyCode) => {
    const original = AE1_OUTPUT.stays[0]!;
    const model = fakeModel(() => ({ ...AE1_OUTPUT, missing: [], stays: [{ ...original, rows: [
      { ...original.rows[0]!, childrenPerRoom: null, childAges: [] },
    ] }] }));
    const result = await extractInboundMail({
      adapter: model.adapter, selection: selectionFor('Please quote one room for two adults.'),
      messageId: 'm1', propertyCode,
    });
    expect(model.calls[0]?.systemPrompt.includes(CENTURION_CHILD_RULES)).toBe(propertyCode === 'HRCEN');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.payload.stays[0]?.rows[0]?.childrenPerRoom).toBeNull();
    expect(result.payload.missing.some((item) => item.field === 'childAges')).toBe(propertyCode === 'HRCEN');
  });

  it('keeps zero, unknown and legacy counts distinct and warns about incomplete ages', () => {
    const original = AE1_OUTPUT.stays[0]!;
    const row = original.rows[0]!;
    const parsed = mailExtractionSchema.parse({ ...AE1_OUTPUT, stays: [{ ...original, rows: [
      { ...row, childrenPerRoom: 0, childAges: [] },
      { ...row, childrenPerRoom: 2, childAges: [7] },
      { ...row, childrenPerRoom: null, childAges: [] },
      { ...row, childAges: [] },
    ] }] });
    const result = sanitizeExtraction(parsed, { messageId: 'm1', sourceText: AE1_TEXT, propertyCode: 'HRCEN' }).payload;
    expect(result.stays[0]?.rows.map((item) => item.childrenPerRoom)).toEqual([0, 2, null, undefined]);
    expect(result.missing).toContainEqual(expect.objectContaining({ field: 'childAges' }));
  });

  it('does not turn a discarded invalid age into evidence for zero children', () => {
    const original = AE1_OUTPUT.stays[0]!;
    const parsed = mailExtractionSchema.parse({ ...AE1_OUTPUT, stays: [{ ...original, rows: [
      { ...original.rows[0]!, childrenPerRoom: 0, childAges: [-1] },
    ] }] });
    const result = sanitizeExtraction(parsed, { messageId: 'm1', sourceText: AE1_TEXT, propertyCode: 'HRCEN' }).payload;
    expect(result.stays[0]?.rows[0]).toMatchObject({ childrenPerRoom: null, childAges: [] });
    expect(result.missing).toContainEqual(expect.objectContaining({ field: 'childAges' }));
  });

  it.each([
    [undefined, [], 'missing_children_count'],
    [null, [], 'missing_children_count'],
    [2, [7], 'missing_child_ages'],
    [0, [7], 'missing_child_ages'],
  ] as const)('does not prefetch count %s and ages %j for Centurion', (count, ages, reason) => {
    const result = plan(payload(count, [...ages]), 'HRCEN');
    expect(result.inputs).toEqual([]);
    expect(result.reason).toBe(reason);
  });

  it.each([[0, []], [2, [7, 9]]] as const)('prefetches complete count %s and ages %j', (count, ages) => {
    expect(plan(payload(count, [...ages]), 'HRCEN').inputs[0]?.groups[0]).toMatchObject({
      childrenPerRoom: count, childrenAges: ages,
    });
  });

  it('preserves Da Vinci quote and reply requirements with an incomplete child warning', () => {
    const original = payload(null, []);
    const warning = { ...original, missing: [{ field: 'childAges', question: 'Confirm each child’s age.' }] };
    const cleanPlan = plan(original, 'HRDAV');
    expect(cleanPlan.inputs).toHaveLength(1);
    expect(plan(warning, 'HRDAV').inputs).toEqual(cleanPlan.inputs);
    expect(cleanPlan.inputs[0]?.groups[0]).not.toHaveProperty('childrenPerRoom');
    const analysis = (source: typeof warning) => storedAnalysis(
      { kind: 'quote', payload: source, attachments: [] }, {}, undefined, 'HRDAV',
    ).analysis;
    const without = analysis(original), withWarning = analysis(warning);
    expect(withWarning.groups).toEqual(without.groups);
    expect(withWarning.intent).toBe(without.intent);
    expect(withWarning.missingQuoteReplyFields).toEqual(without.missingQuoteReplyFields);
    expect(withWarning.reviewItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Confirm each child’s age.', blocking: false }),
    ]));
  });
});
