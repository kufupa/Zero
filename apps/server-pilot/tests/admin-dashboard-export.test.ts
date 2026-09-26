import { aggregateAdminDashboardMetrics } from '../src/metrics/admin-dashboard-aggregates.js';
import { serializeAdminDashboardExport } from '../src/metrics/admin-dashboard-export.js';
import { describe, expect, it } from 'vitest';

describe('admin dashboard authorized export', () => {
  it('serializes six exclusive buckets and overlays with honest metric cells', () => {
    const cutoff = new Date('2026-09-08T00:00:00.000Z');
    const payload = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: null,
      measurementConfig: null,
      threads: [],
      messages: [],
      transports: [],
      windowStart: new Date('2026-09-01T00:00:00.000Z'),
      windowEnd: cutoff,
    });

    const exported = serializeAdminDashboardExport(payload);
    expect(exported.schemaVersion).toBe('admin-dashboard-export-v1');
    expect(Object.keys(exported.buckets)).toEqual([
      'awaiting_hotel_reply',
      'awaiting_customer_information',
      'hotel_action_pending',
      'unknown',
      'answered',
      'no_reply_required',
    ]);
    expect(Object.keys(exported.overlays)).toEqual(['partially_answered', 'unknown_evidence']);
    for (const metric of Object.values({ ...exported.buckets, ...exported.overlays })) {
      expect(metric).toEqual(
        expect.objectContaining({
          value: null,
          availability: 'unavailable',
          denominator: null,
          availabilityReason: expect.any(String),
        }),
      );
    }
    expect(JSON.stringify(exported)).not.toContain('textBody');
  });
});
