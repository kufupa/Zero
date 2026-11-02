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
    { saveAttempted: true }, { saveAttempted: 'unknown' as const }, { uploadSent: true },
    { uploadSent: 'unknown' as const }, { clickedOk: true }, { clickedOk: 'unknown' as const },
    { possiblyDispatched: true }, { dispatched: true }])('keeps possible dispatch uncertain: %o', (signal) => {
    expect(adaptExistingToolResult({ outcome: 'refused', ...signal }, { operation: 'write' }).outcome).toBe('uncertain');
  });
  it('never converts a dispatched refusal to a definite refusal even with claimed verification', () => {
    expect(adaptExistingToolResult({ outcome: 'refused', clickedSave: true },
      { operation: 'write', readbackVerified: true }).outcome).toBe('uncertain');
    expect(adaptExistingToolResult({ outcome: 'ok', status: 'refused', clickedSave: true },
      { operation: 'write', readbackVerified: true }).outcome).toBe('uncertain');
  });
  it.each(['refused_flag_off', 'amend_preview_required'])('keeps known pre-dispatch refusal %s', (code) => {
    expect(adaptExistingToolResult({ outcome: code }, { operation: 'write' }))
      .toMatchObject({ outcome: 'refused', reason: code });
    expect(adaptExistingToolResult({ status: 'uncertain', outcome: code }, { operation: 'write' }).outcome)
      .toBe('uncertain');
    for (const signal of [{ clickedSave: true }, { saveDispatched: 'unknown' as const }, { possiblyDispatched: true }]) {
      expect(adaptExistingToolResult({ outcome: code, ...signal }, { operation: 'write', readbackVerified: true }).outcome)
        .toBe('uncertain');
    }
  });
  it('keeps unknown refusal-looking codes uncertain', () => {
    expect(adaptExistingToolResult({ outcome: 'refused_unknown' }, { operation: 'write' }).outcome).toBe('uncertain');
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
    expect(adaptExistingToolResult(result, { operation: 'write' })).toMatchObject({
      outcome: 'uncertain', data: { confirmationNumber: '123456-1' },
    });
    expect(adaptExistingToolResult(result, { operation: 'write', readbackVerified: true })).toMatchObject({
      outcome: 'ok', data: { confirmationNumber: '123456-1' },
    });
  });
  it('retains all legacy search rows and other producer fields', () => {
    const rows = [{ confirmation: '123', extra: { exact: true } }, { confirmation: '456' }];
    expect(adaptExistingToolResult({ outcome: 'ok', rows, coverage: { complete: true } }, { operation: 'read' }))
      .toMatchObject({ outcome: 'ok', data: { rows, coverage: { complete: true } } });
    expect(adaptExistingToolResult({ outcome: 'ok', data: { normalized: true }, confirmationNumber: '123',
      previewDigest: null }, { operation: 'write' })).toMatchObject({ outcome: 'uncertain',
      data: { normalized: true }, legacyData: { confirmationNumber: '123', previewDigest: null } });
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
  it('retains each batch child payload and evidence without treating them as verification', () => {
    const batch = adaptBatchToolResult([
      { key: 'a', result: { status: 'confirmed', confirmationNumber: '123', runId: 'run-a', screenshots: ['save.png'] } },
      { key: 'b', result: { status: 'uncertain', confirmationNumber: '456', saveAttempted: true } },
    ]);
    expect(batch).toEqual({ schema: 'nava.tool/v1', outcome: 'partial', children: [
      { key: 'a', outcome: 'uncertain', data: { confirmationNumber: '123' },
        evidence: { legacy: [{ runId: 'run-a', screenshots: ['save.png'] }] } },
      { key: 'b', outcome: 'uncertain', data: { confirmationNumber: '456' } },
    ] });
  });
  it('preserves producer-style confirmed and uncertain batch children', () => {
    expect(adaptBatchToolResult([
      { key: 'child-a', result: { status: 'confirmed' }, readbackVerified: true, confirmation: '123456-1' },
      { key: 'child-b', result: { status: 'uncertain', possiblyDispatched: true } },
    ])).toEqual({ schema: 'nava.tool/v1', outcome: 'partial', children: [
      { key: 'child-a', outcome: 'ok', confirmation: '123456-1' },
      { key: 'child-b', outcome: 'uncertain' },
    ] });
    for (const signal of [{}, { possiblyDispatched: true }]) {
      expect(adaptExistingToolResult({ outcome: 'partial', ...signal }, { operation: 'write' }).outcome)
        .toBe('uncertain'); // The single-result adapter cannot preserve batch children.
    }
    expect(adaptExistingToolResult({ outcome: 'partial' }, { operation: 'read' }).outcome).toBe('uncertain');
  });
  it('keeps every nonempty batch partial, regardless of child outcomes', () => {
    const verified = adaptBatchToolResult([
      { key: 'a', result: { status: 'confirmed' }, readbackVerified: true, confirmation: '123456-1' },
      { key: 'b', result: { status: 'confirmed' }, readbackVerified: true, confirmation: '123457-1' },
    ]);
    expect(verified).toEqual({ schema: 'nava.tool/v1', outcome: 'partial', children: [
      { key: 'a', outcome: 'ok', confirmation: '123456-1' },
      { key: 'b', outcome: 'ok', confirmation: '123457-1' },
    ] });
    const refused = adaptBatchToolResult([
      { key: 'a', result: { outcome: 'not_dispatched' } },
      { key: 'b', result: { outcome: 'refused', reason: 'POLICY_BLOCK' } },
    ]);
    expect(refused).toEqual({ schema: 'nava.tool/v1', outcome: 'partial', children: [
      { key: 'a', outcome: 'refused' }, { key: 'b', outcome: 'refused', reason: 'policy_block' },
    ] });
    expect(adaptBatchToolResult([])).toEqual({ schema: 'nava.tool/v1', outcome: 'needs_input', reason: 'batch_empty' });
  });
  it('retains legacy hashed shots and readback without claiming verification', () => {
    const hash = 'a'.repeat(64);
    const legacy = { status: 'ok', outcome: 'committed', clickedSave: true, runId: 'run-1',
      screenshots: ['saved.png', 'unhashed.png'], shots: [{ name: 'saved.png', sha256: hash, at: '2026-11-02T00:00:00Z' }],
      changedFieldsReadback: { arrival: '2027-01-01', unknownField: { exact: true } } };
    const adapted = adaptExistingToolResult(legacy, { operation: 'write' });
    expect(adapted.outcome).toBe('uncertain');
    expect(adapted.evidence).toEqual({
      screenshots: [{ runId: 'run-1', name: 'saved.png', sha256: hash }],
      readback: legacy.changedFieldsReadback,
      legacy: [{ runId: legacy.runId, screenshots: legacy.screenshots, shots: legacy.shots,
        changedFieldsReadback: legacy.changedFieldsReadback }],
    });
    expect(adapted.evidence?.level).toBeUndefined();
  });
  it('retains conflicting producer observations without fabricating shot hashes', () => {
    const adapted = adaptExistingToolResult({ outcome: 'ok', runId: 'run-1', screenshots: ['saved.png'],
      shots: [{ name: '../outside.png', sha256: 'bad' }], readback: { top: true },
      changedFieldsReadback: { changed: true }, evidence: { readback: { normalized: true }, level: 'none' } },
    { operation: 'read' });
    expect(adapted.evidence).toEqual({ readback: { normalized: true }, level: 'none',
      legacy: [{ runId: 'run-1', screenshots: ['saved.png'], shots: [{ name: '../outside.png', sha256: 'bad' }],
        readback: { top: true }, changedFieldsReadback: { changed: true } }] });
    expect(adapted.evidence?.screenshots).toBeUndefined();
  });
  it('does not attach an unverified legacy readback to an unrelated verified level', () => {
    for (const legacy of [{ readback: { raw: true } }, { changedFieldsReadback: { raw: true } }]) {
      const adapted = adaptExistingToolResult({ outcome: 'ok', ...legacy,
        evidence: { level: 'readback_verified' } }, { operation: 'read' });
      expect(adapted.evidence).toEqual({ level: 'none', legacy: [legacy] });
    }
    const verified = { id: 'verified-stay' };
    const adapted = adaptExistingToolResult({ outcome: 'ok', readback: { raw: true },
      evidence: { level: 'readback_verified', readback: verified } }, { operation: 'read' });
    expect(adapted.evidence).toEqual({ level: 'readback_verified', readback: verified,
      legacy: [{ readback: { raw: true } }] });
  });
  it('does not drop readback fields', () => {
    const readback = { id: 'stay', otherField: { exact: 'value' } };
    expect(adaptExistingToolResult({ outcome: 'ok', evidence: { readback } }, { operation: 'read' }).evidence?.readback).toEqual(readback);
  });
  it('rejects duplicate or noncanonical batch keys and invalid child digests', () => {
    const child = { key: 'room-a', stayDigest: 'a'.repeat(64), previewDigest: 'b'.repeat(64) };
    const manifest = { manifestId: 'manifest', revision: 1, expiresAt: '2027-01-01T00:00:00Z', children: [child] };
    expect(BatchManifestGrantSchema.safeParse(manifest).success).toBe(true);
    for (const children of [
      [child, child], [{ ...child, key: ' ' }], [{ ...child, key: ' room-a' }], [{ ...child, key: 'room\na' }],
      [{ ...child, stayDigest: 'not-a-digest' }], [{ ...child, previewDigest: 'A'.repeat(64) }],
    ]) expect(BatchManifestGrantSchema.safeParse({ ...manifest, children }).success).toBe(false);
    expect(BatchManifestGrantSchema.safeParse({ ...manifest, manifestId: ' ' }).success).toBe(false);
  });

  it('refuses unknown fields and requires server grants', () => {
    expect(FilingRunnerInputSchema.safeParse({ grantRef: 'g', extra: true }).success).toBe(false);
    expect(FilingRunnerInputSchema.safeParse({}).success).toBe(false);
    expect(AmendStageInputSchema.safeParse({ grantRef: 'g', occupancy: { adults: 2, childAges: 'unknown' } }).success).toBe(true);
    expect(AmendStageInputSchema.safeParse({ grantRef: 'g', occupancy: { adults: 2, childAges: [], extra: true } }).success).toBe(false);
    expect(AmendStageInputSchema.safeParse({ occupancy: { adults: 2, childAges: [] } }).success).toBe(false);
    expect(BatchManifestGrantSchema.safeParse({ manifestId: 'm', revision: 1, expiresAt: '2027-01-01T00:00:00Z',
      children: [{ key: 'a', stayDigest: 's', previewDigest: 'p', extra: true }] }).success).toBe(false);
    expect(BatchManifestGrantSchema.safeParse({ manifestId: 'm', revision: 1, expiresAt: '2027-01-01T00:00:00Z',
      children: [] }).success).toBe(false);
  });
});
