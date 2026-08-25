# Connected reservationist-inbox KPI availability catalog

Date: 2026-08-24

## Purpose

Static, PII-free catalog for KPI honesty. It defines availability and meaning,
not baseline values. No corpus metric is asserted as measured here.

## Canonical dashboard interface

Source: [`apps/mail/lib/admin-dashboard/types.ts`](../../apps/mail/lib/admin-dashboard/types.ts).

`MetricAvailability` permits only `live`, `unavailable`, and `coming_soon`.
`offline` is a catalog-only classification. It is never a `MetricAvailability`
value or dashboard cell.

Non-live or missing metrics receive no numeric substitute. Missing does not mean
zero.

## Dashboard KPI availability mapping

| KPI | Stable definition | Dashboard availability | Interface mapping | Catalog rule |
| --- | --- | --- | --- | --- |
| Inbound volume | Count of inbound messages in dashboard scope and window. | `live` | `AdminDashboardMetrics.inboundVolume` | Permitted live cell; this catalog makes no measured-volume claim. |
| Response times | First-response latency metrics for eligible inbound work. | `live` | `medianFirstResponseMinutes`, `p90FirstResponseMinutes`, `answeredWithin3hPercent` | Permitted live cells; this catalog makes no measured-response claim. |
| Draft time | Time to draft creation. | `unavailable` | `draftCreationMinutes` | Remain unavailable; no numeric fallback. |
| AI-assisted | Share of sends assisted by AI. | `unavailable` | `aiAssistedSendRate` | Remain unavailable; no numeric fallback. |
| Edit distance | Difference between draft and sent content. | `unavailable` | `medianEditDistance` | Remain unavailable; no numeric fallback. |
| Revenue | Attributable revenue. | `coming_soon` | `totalRevenue` | Remain coming soon; no numeric fallback. |
| Booked-by-AI | Attributable completed bookings. | `coming_soon` | No `AdminDashboardMetrics` field | Catalog-only until a truthful dashboard contract exists. |

## Offline evidence catalog

These are catalog-only evidence fields. They never receive
`MetricAvailability`, render as dashboard cells, or become dashboard KPI output.

| Evidence field | Catalog classification | Definition and evidence status |
| --- | --- | --- |
| Refine hit rate | `offline` | Rate from an approved local snapshot; unavailable until that snapshot exists. |
| Gold size | `offline` | Count of approved gold items; unavailable until gold review occurs. |
| Active connected transport scope | `offline` | Non-empty, sorted transport membership bound to one `asOf`; metadata only. |
| Snapshot `asOf` | `offline` | Read-only local snapshot boundary; unavailable until metadata gate passes. |
| SOP catalog volumes | `offline` | Counts from approved local taxonomy review; unavailable until dump-bound review occurs. |

## Snapshot blocker

Data-derived offline evidence requires all of:

1. metadata-only read-only gate passed;
2. non-empty active connected transport scope confirmed;
3. one sealed `asOf` bound to selections; and
4. approved local private DB access and raw-dump path available.

Otherwise record `BLOCKED_LOCAL_PRIVATE_DB_ACCESS_UNAVAILABLE` when private
access is missing. Do not manufacture a value, use an empty fallback, or infer a
named-source scope.

## Honesty rules

- `live` identifies a dashboard classification permitted by interface, not a
  measurement claim in this catalog.
- `unavailable` and `coming_soon` remain non-live and receive no numeric
  fallback.
- `offline` stays catalog-only and never enters `MetricAvailability`.
- Any data-derived KPI evidence stays local and PII-free in tracked artifacts;
  raw mail never enters the catalog.
