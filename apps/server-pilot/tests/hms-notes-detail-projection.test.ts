import { describe, expect, it } from 'vitest';
import { projectNotesFromDetailDump } from '../src/hms/notes-detail-projection.js';
import { observeNotesTraces } from '../src/hms/live-notes-traces-read-driver.js';

describe('projectNotesFromDetailDump', () => {
  it('maps dump-proved reservationnote and leaves empty cancellationnote out', () => {
    const projected = projectNotesFromDetailDump(
      {
        schemaVersion: 1,
        surface: 'guest_stay_detail',
        keys: ['reservationnote', 'cancellationnote', 'confirmationnumber'],
        values: {
          reservationnote: 'Guest prefers quiet floor.',
          cancellationnote: '   ',
        },
      },
      {
        resourceRef: 'notes-resource-test',
        evidenceRef: 'ev-1',
        observedAt: new Date('2099-01-01T00:00:00.000Z'),
        expiresAt: new Date('2099-01-01T00:05:00.000Z'),
        limit: 20,
      },
    );
    expect(projected.claimKeys).toEqual(['notes.reservationnote']);
    expect('items' in projected.data.notes).toBe(true);
    if ('items' in projected.data.notes) {
      expect(projected.data.notes.items).toHaveLength(1);
      expect(projected.data.notes.items[0]?.permittedText).toMatchObject({
        state: 'known',
        value: 'Guest prefers quiet floor.',
      });
      expect(projected.data.notes.items[0]?.audience).toMatchObject({
        value: 'staff_only',
      });
    }
    expect(projected.tracesReasonCode).toBe('SURFACE_UNPROVEN');
  });

  it('returns notes unavailable when note keys absent from dump', () => {
    const projected = projectNotesFromDetailDump(
      {
        schemaVersion: 1,
        surface: 'guest_stay_detail',
        keys: ['confirmationnumber'],
        values: { confirmationnumber: 'X' },
      },
      {
        resourceRef: 'notes-resource-test',
        evidenceRef: 'ev-1',
        observedAt: new Date('2099-01-01T00:00:00.000Z'),
        expiresAt: new Date('2099-01-01T00:05:00.000Z'),
        limit: 20,
      },
    );
    expect(projected.claimKeys).toEqual([]);
    expect(projected.data.notes).toMatchObject({
      state: 'unavailable',
      reasonCode: 'SOURCE_UNAVAILABLE',
    });
  });
});

describe('observeNotesTraces with detail dump', () => {
  const authorization = {
    toolId: 'hms_read_notes_traces' as const,
    discoveryOperationId: 'notes_traces_list' as const,
    requestBranchId: 'notes_traces_list',
    operationId: '00000000-0000-4000-8000-000000000099',
    releaseId: 'rel',
    manifest: {} as never,
    manifestSha256: 'a'.repeat(64),
    roleProofPath: '/tmp/role',
    roleProofSha256: 'b'.repeat(64),
    credentialVersionHmacSha256: 'c'.repeat(64),
    runtimeFingerprintSha256: 'd'.repeat(64),
    privateDigestKeyVersion: 'v1',
    sourceRevision: 'phase-a-test',
    expiresAt: '2099-01-01T00:10:00.000Z',
  };

  it('returns partial notes from dump and marks traces SURFACE_UNPROVEN', async () => {
    const result = await observeNotesTraces(
      authorization,
      {
        resourceRef: 'notes-resource-test',
        states: ['open'],
        limit: 20,
        audience: 'staff',
      },
      new AbortController().signal,
      {
        detailDumpFor: async () => ({
          schemaVersion: 1,
          surface: 'guest_stay_detail',
          keys: ['reservationnote'],
          values: { reservationnote: 'Late arrival expected.' },
        }),
      },
    );
    expect(result.status).toBe('partial');
    expect(result.unavailableSections).toEqual([
      { section: 'traces', reasonCode: 'SURFACE_UNPROVEN' },
    ]);
    expect(result.data).toBeTruthy();
  });
});
