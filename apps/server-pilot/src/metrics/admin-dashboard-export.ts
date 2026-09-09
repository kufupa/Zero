import type { AdminDashboardAggregateResult, MetricResult } from './admin-dashboard-aggregates.js';
import { PRIMARY_BUCKETS, type MailBaselinePrimaryBucket } from './mail-baseline.js';

export const ADMIN_DASHBOARD_EXPORT_VERSION = 'admin-dashboard-export-v1' as const;

export type AdminDashboardExport = {
  schemaVersion: typeof ADMIN_DASHBOARD_EXPORT_VERSION;
  query: AdminDashboardAggregateResult['query'];
  provenance: {
    observationCutoff: string;
    sourceVintage: string;
    measurementConfigVersions: readonly string[];
    captureBases: readonly string[];
  };
  buckets: Record<MailBaselinePrimaryBucket, MetricResult<number>>;
  overlays: {
    partially_answered: MetricResult<number>;
    unknown_evidence: MetricResult<number>;
  };
  metrics: {
    traffic: AdminDashboardAggregateResult['traffic'];
    activity: AdminDashboardAggregateResult['activity'];
    service: AdminDashboardAggregateResult['service'];
    folders: AdminDashboardAggregateResult['folders'];
    correspondents: AdminDashboardAggregateResult['correspondents'];
    dataHealth: AdminDashboardAggregateResult['dataHealth'];
  };
};

/** Serialize only bounded aggregate/semantic evidence; no message bodies. */
export function serializeAdminDashboardExport(
  payload: AdminDashboardAggregateResult,
): AdminDashboardExport {
  const conversations = payload.conversations;
  const bucketMetric = (bucket: MailBaselinePrimaryBucket): MetricResult<number> => {
    const metric = conversations.bucketTotals;
    if (metric.availability !== 'available' || metric.value === null) {
      return {
        ...metric,
        value: null,
        availability: 'unavailable',
        availabilityReason: metric.availabilityReason ?? 'request_projection_unavailable',
      };
    }
    return {
      ...metric,
      value: metric.value[bucket] ?? null,
      unit: 'requests',
      denominator: metric.denominator,
    };
  };
  const captureBases = [
    payload.traffic.inbound.captureBasis,
    conversations.bucketTotals.captureBasis,
    payload.service.firstUsefulReply.captureBasis,
  ].filter((basis): basis is string => typeof basis === 'string' && basis.length > 0);
  const measurementConfigVersions = [
    payload.traffic.inbound.measurementConfigVersion,
    conversations.bucketTotals.measurementConfigVersion,
    payload.service.firstUsefulReply.measurementConfigVersion,
    payload.service.counts.measurementConfigVersion,
  ].filter((version): version is string => typeof version === 'string' && version.length > 0);

  return {
    schemaVersion: ADMIN_DASHBOARD_EXPORT_VERSION,
    query: payload.query,
    provenance: {
      observationCutoff: payload.query.observationCutoff,
      sourceVintage: payload.query.sourceVintage,
      measurementConfigVersions: [...new Set(measurementConfigVersions)].sort(),
      captureBases: [...new Set(captureBases)].sort(),
    },
    buckets: Object.fromEntries(
      PRIMARY_BUCKETS.map((bucket) => [bucket, bucketMetric(bucket)]),
    ) as Record<MailBaselinePrimaryBucket, MetricResult<number>>,
    overlays: {
      partially_answered: conversations.partial,
      unknown_evidence: conversations.unknownEvidence,
    },
    metrics: {
      traffic: payload.traffic,
      activity: payload.activity,
      service: payload.service,
      folders: payload.folders,
      correspondents: payload.correspondents,
      dataHealth: payload.dataHealth,
    },
  };
}
