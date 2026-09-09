import { serializeAdminDashboardExport } from '@/lib/admin-dashboard/export';
import type { AdminDashboardExport } from '@/lib/admin-dashboard/types';
import { describe, expect, it } from 'vitest';

const metric = {
  value: null,
  availability: 'unavailable' as const,
  unit: 'requests',
  denominator: null,
  exclusions: { unknown_clock: 1 },
  timestampBasis: 'availability' as const,
  captureBasis: 'configured-v1',
  sourceVintage: '2026-09-08T00:00:00.000Z',
  classificationAsOf: null,
  snapshotBasis: null,
  measurementConfigVersion: '1',
  availabilityReason: 'request_projection_unavailable',
};

const exportPayload = {
  schemaVersion: 'admin-dashboard-export-v1' as const,
  query: {
    cohortId: 'centurion' as const,
    window: '7d' as const,
    windowStart: '2026-09-01T00:00:00.000Z',
    windowEnd: '2026-09-08T00:00:00.000Z',
    observationCutoff: '2026-09-08T00:00:00.000Z',
    sourceVintage: '2026-09-08T00:00:00.000Z',
  },
  provenance: {
    observationCutoff: '2026-09-08T00:00:00.000Z',
    sourceVintage: '2026-09-08T00:00:00.000Z',
    measurementConfigVersions: ['1'],
    captureBases: ['configured-v1'],
  },
  buckets: {
    awaiting_hotel_reply: metric,
    awaiting_customer_information: metric,
    hotel_action_pending: metric,
    unknown: metric,
    answered: metric,
    no_reply_required: metric,
  },
  overlays: { partially_answered: metric, unknown_evidence: metric },
  metrics: {
    traffic: {} as AdminDashboardExport['metrics']['traffic'],
    activity: {} as AdminDashboardExport['metrics']['activity'],
    service: {} as AdminDashboardExport['metrics']['service'],
    folders: {} as AdminDashboardExport['metrics']['folders'],
    correspondents: {} as AdminDashboardExport['metrics']['correspondents'],
    dataHealth: null,
  },
} satisfies AdminDashboardExport;

describe('admin dashboard client export', () => {
  it('serializes the authorized bounded export without dropping unavailable reasons', () => {
    const text = serializeAdminDashboardExport(exportPayload);
    const parsed = JSON.parse(text) as AdminDashboardExport;
    expect(Object.keys(parsed.buckets)).toHaveLength(6);
    expect(parsed.buckets.unknown).toMatchObject({
      value: null,
      availability: 'unavailable',
      denominator: null,
      availabilityReason: 'request_projection_unavailable',
    });
    expect(parsed.overlays.unknown_evidence.measurementConfigVersion).toBe('1');
  });
});
