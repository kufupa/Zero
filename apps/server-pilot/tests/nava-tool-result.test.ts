import { describe, expect, it } from 'vitest';
import {
  adaptBatchToolResult, adaptExistingToolResult, AmendStageInputSchema,
  BatchManifestGrantSchema, FilingRunnerInputSchema,
} from '../src/ai/nava-tool-result.js';

describe('Nava tool result contract', () => {
  it.each(['committed_unverified', 'awaiting_readback', 'uncertain', 'save_failed'])(
    '%s is uncertain even after a claimed verification', (outcome) => {
      expect(adaptExistingToolResult({ outcome }, { operation: 'write', readbackVerified: true }).outcome).toBe('uncertain');
    },
  );
  it('never calls an unconfirmed pane save a refusal', () => {
    expect(adaptExistingToolResult({ status: 'refused', reason: 'pane_save_unconfirmed' }, { operation: 'write' }))
      .toMatchObject({ outcome: 'uncertain', reason: 'pane_save_unconfirmed' });
  });
  it.each([{ clickedSave: true }, { saveDispatched: true }, { saveDispatched: 'unknown' as const },
    { possiblyDispatched: true }, { dispatched: true }])('keeps possible dispatch uncertain: %o', (signal) => {
    expect(adaptExistingToolResult({ outcome: 'refused', ...signal }, { operation: 'write' }).outcome).toBe('uncertain');
  });
  it('never converts a dispatched refusal to a definite refusal even with claimed verification', () => {
    expect(adaptExistingToolResult({ outcome: 'refused', clickedSave: true },
      { operation: 'write', readbackVerified: true }).outcome).toBe('uncertain');
    expect(adaptExistingToolResult({ outcome: 'ok', status: 'refused', clickedSave: true },
      { operation: 'write', readbackVerified: true }).outcome).toBe('uncertain');
  });
  it('requires verified readback for successful writes', () => {
    expect(adaptExistingToolResult({ outcome: 'ok' }, { operation: 'write' }).outcome).toBe('uncertain');
    expect(adaptExistingToolResult({ outcome: 'ok', clickedSave: true }, { operation: 'write', readbackVerified: true }).outcome).toBe('ok');
    expect(adaptExistingToolResult({ outcome: 'ok' }, { operation: 'read' }).outcome).toBe('ok');
    expect(adaptExistingToolResult({ outcome: 'saved' }, { operation: 'write', readbackVerified: true }).outcome).toBe('ok');
    expect(adaptExistingToolResult({ outcome: 'saved' }, { operation: 'write' }).outcome).toBe('uncertain');
  });
  it('adapts a legacy committed booking only after fresh readback', () => {
    const result = { status: 'ok', outcome: 'committed', clickedSave: true, confirmationNumber: '123456-1' };
    expect(adaptExistingToolResult(result, { operation: 'write' }).outcome).toBe('uncertain');
    expect(adaptExistingToolResult(result, { operation: 'write', readbackVerified: true }).outcome).toBe('ok');
  });
  it('keeps batch child identity, confirmation and uncertainty', () => {
    expect(adaptBatchToolResult([
      { key: 'a', result: { outcome: 'ok' }, readbackVerified: true, confirmation: '123' },
      { key: 'b', result: { outcome: 'awaiting_readback', issue: 'SAVE_UNCONFIRMED' } },
    ])).toEqual({ schema: 'nava.tool/v1', outcome: 'partial', children: [
      { key: 'a', outcome: 'ok', confirmation: '123' },
      { key: 'b', outcome: 'uncertain', reason: 'save_unconfirmed' },
    ] });
  });
  it('does not drop readback fields', () => {
    const readback = { id: 'stay', otherField: { exact: 'value' } };
    expect(adaptExistingToolResult({ outcome: 'ok', evidence: { readback } }, { operation: 'read' }).evidence?.readback).toEqual(readback);
  });
  it('refuses unknown fields and requires server grants', () => {
    expect(FilingRunnerInputSchema.safeParse({ grantRef: 'g', extra: true }).success).toBe(false);
    expect(FilingRunnerInputSchema.safeParse({}).success).toBe(false);
    expect(AmendStageInputSchema.safeParse({ grantRef: 'g', occupancy: { adults: 2, childAges: 'unknown' } }).success).toBe(true);
    expect(AmendStageInputSchema.safeParse({ grantRef: 'g', occupancy: { adults: 2, childAges: [], extra: true } }).success).toBe(false);
    expect(AmendStageInputSchema.safeParse({ occupancy: { adults: 2, childAges: [] } }).success).toBe(false);
    expect(BatchManifestGrantSchema.safeParse({ manifestId: 'm', revision: 1, expiresAt: '2027-01-01T00:00:00Z',
      children: [{ key: 'a', stayDigest: 's', previewDigest: 'p', extra: true }] }).success).toBe(false);
  });
});
