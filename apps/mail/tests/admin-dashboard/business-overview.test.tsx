import type {
  AdminDashboardDailyPoint,
  AdminDashboardMetrics,
  MetricResult,
} from '@/lib/admin-dashboard/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import * as React from 'react';

const { useAdminDashboardDataMock, useAdminDashboardExportMock } = vi.hoisted(() => ({
  useAdminDashboardDataMock: vi.fn(),
  useAdminDashboardExportMock: vi.fn(),
}));

vi.mock('@/hooks/use-admin-dashboard', () => ({
  useAdminDashboardData: useAdminDashboardDataMock,
  useAdminDashboardExport: useAdminDashboardExportMock,
}));

import AdminDashboardPage from '@/app/(routes)/settings/admin-dashboard/page';

function metric<T>(value: T, unit: string, denominator: number | null = 0): MetricResult<T> {
  return {
    value,
    availability: 'available',
    unit,
    denominator,
    exclusions: {},
    timestampBasis: 'source_event',
    captureBasis: 'two_way_feed_after_t0',
    sourceVintage: '2026-09-07T12:00:00.000Z',
    classificationAsOf: '2026-09-07T12:00:00.000Z',
    snapshotBasis: 'current_observed_snapshot_at_request',
    availabilityReason: null,
  };
}

function unavailableMetric<T>(unit: string, reason: string): MetricResult<T> {
  return {
    value: null,
    availability: 'unavailable',
    unit,
    denominator: null,
    exclusions: {},
    timestampBasis: null,
    captureBasis: 'two_way_feed_after_t0',
    sourceVintage: '2026-09-07T12:00:00.000Z',
    classificationAsOf: null,
    snapshotBasis: null,
    availabilityReason: reason,
  };
}

const metrics: AdminDashboardMetrics = {
  query: {
    cohortId: 'centurion',
    window: '7d',
    windowStart: '2026-08-31T12:00:00.000Z',
    windowEnd: '2026-09-07T12:00:00.000Z',
    observationCutoff: '2026-09-07T12:00:00.000Z',
    sourceVintage: '2026-09-07T12:00:00.000Z',
  },
  traffic: {
    inbound: metric(6, 'messages', 6),
    outbound: metric(4, 'messages', 4),
    daily: metric(
      [
        {
          period: '2026-09-01',
          inbound: 2,
          outbound: 1,
          byTransport: { 'transport-centurion': { inbound: 2, outbound: 1 } },
        },
        {
          period: '2026-09-02',
          inbound: 0,
          outbound: 0,
          byTransport: { 'transport-centurion': { inbound: 0, outbound: 0 } },
        },
        {
          period: '2026-09-03',
          inbound: 4,
          outbound: 3,
          byTransport: { 'transport-centurion': { inbound: 4, outbound: 3 } },
        },
      ],
      'messages per day',
      10,
    ),
    comparableWindowChangePercent: metric(20, 'percent', 5),
  },
  activity: {
    activeConversations: metric(3, 'conversations', 3),
    newlyObservedConversations: metric(2, 'conversations', 3),
    continuingConversations: metric(1, 'conversations', 3),
    distinctExternalSenderAddresses: metric(4, 'email addresses', 4),
    weekdayArrivals: metric({ Monday: 2, Wednesday: 4 }, 'arrivals by weekday', 6),
    hourArrivals: metric({ '09': 3, '14': 3 }, 'arrivals by hour', 6),
  },
  folders: {
    mix: metric(
      [
        {
          folder: 'bookings',
          label: 'Bookings',
          count: 2,
          urgentCount: 1,
          classification: 'primary',
        },
        {
          folder: 'groups-events',
          label: 'Groups & Events',
          count: 1,
          urgentCount: 0,
          classification: 'primary',
        },
        {
          folder: 'unknown-review',
          label: 'Unknown / Needs Review',
          count: 0,
          urgentCount: 0,
          classification: 'unclassified',
        },
      ],
      'conversations by folder',
      3,
    ),
    urgent: metric(1, 'urgent conversations', 3),
    exclusions: { spam: 1, trash: 1 },
  },
  correspondents: {
    externalDomains: metric(
      [
        { domain: 'public-email', count: 3, addresses: 2 },
        { domain: 'example.org', count: 3, addresses: 2 },
      ],
      'external domains',
      6,
    ),
  },
  service: {
    firstObservedHumanReply: unavailableMetric('calendar minutes', 'reply_evidence_unavailable'),
    firstUsefulReply: unavailableMetric('calendar minutes', 'no_useful_reply_evidence'),
    counts: {
      eligibleNewConversations: {
        ...unavailableMetric('conversations', 'reply_evidence_unavailable'),
        denominatorStatus: 'not_applicable',
      },
      unansweredEligible: {
        ...unavailableMetric('conversations', 'reply_evidence_unavailable'),
        denominatorStatus: 'unknown',
      },
      unscorable: {
        ...unavailableMetric('conversations', 'reply_evidence_unavailable'),
        denominatorStatus: 'unknown',
      },
      measurementStartAt: null,
      measurementConfigVersion: null,
    },
    eligibleNewConversationCount: null,
    unansweredEligible: null,
    unscorable: null,
  },
  conversations: {
    awaitingHotel: unavailableMetric('conversations', 'request_projection_unavailable'),
    awaitingCustomer: unavailableMetric('conversations', 'request_projection_unavailable'),
    hotelActionPending: unavailableMetric('conversations', 'request_projection_unavailable'),
    answered: unavailableMetric('conversations', 'request_projection_unavailable'),
    noReplyRequired: unavailableMetric('conversations', 'request_projection_unavailable'),
    partial: unavailableMetric('conversations', 'request_projection_unavailable'),
    unknown: unavailableMetric('conversations', 'request_projection_unavailable'),
    unknownEvidence: unavailableMetric('conversations', 'request_projection_unavailable'),
    bucketTotals: unavailableMetric('conversations', 'request_projection_unavailable'),
    ageBands: unavailableMetric('conversation age bands', 'request_projection_unavailable'),
  },
  dataHealth: {
    availability: 'available',
    observationCutoff: '2026-09-07T12:00:00.000Z',
    directionCounts: { inbound: 6, outbound: 4 },
    lastObservedAt: {
      inbound: '2026-09-07T11:00:00.000Z',
      outbound: '2026-09-07T10:00:00.000Z',
    },
    lastObservedBasis: { inbound: 'source_event', outbound: 'source_event' },
    singleton: { numerator: 1, denominator: 10 },
    quotedMailboxReplyNoMatchingOutbound: {
      numerator: null,
      denominator: null,
      availability: 'unavailable',
      reason: 'quote_projection_unavailable',
    },
    unscorable: {
      total: 1,
      inbound: 1,
      outbound: 0,
      missingClock: 1,
      invalidClock: 0,
      missingThreadLinkage: 0,
      missingIdentity: 0,
    },
  },
  inboundVolume: { availability: 'live', value: 6 },
  medianFirstResponseMinutes: { availability: 'unavailable', value: null },
  p90FirstResponseMinutes: { availability: 'unavailable', value: null },
  answeredWithin3hPercent: { availability: 'unavailable', value: null },
  draftCreationMinutes: { availability: 'unavailable', value: null },
  aiAssistedSendRate: { availability: 'unavailable', value: null },
  medianEditDistance: { availability: 'unavailable', value: null },
  totalRevenue: { availability: 'unavailable', value: null },
  eligibleThreadCount: null,
  unansweredEligible: null,
  inboundPerDay: [],
  comparison: [],
  perTransport: [],
  transports: [
    { id: 'transport-centurion', email: 'centurion@example.test', displayName: 'Centurion' },
  ],
  assumptions: ['event_clock_not_import_created_at'],
  footnote: 'Observed mail only.',
  windowStart: '2026-08-31T12:00:00.000Z',
  windowEnd: '2026-09-07T12:00:00.000Z',
};

describe('AdminDashboardPage executive business overview', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React);
    useAdminDashboardDataMock.mockReturnValue({
      canAccess: true,
      isLoading: false,
      isError: false,
      isStale: false,
      source: 'hosted',
      data: null,
      metrics,
    });
    useAdminDashboardExportMock.mockReturnValue({
      isDownloading: false,
      isError: false,
      download: vi.fn(),
    });
  });

  it('renders observed traffic and business breakdowns with provenance', () => {
    const markup = renderToStaticMarkup(createElement(AdminDashboardPage));

    expect(markup).toContain('Executive email dashboard');
    expect(markup).toContain('Incoming messages');
    expect(markup).toContain('Outgoing messages');
    expect(markup).toContain('6');
    expect(markup).toContain('4');
    expect(markup).toContain('Business work by folder');
    expect(markup).toContain('Bookings');
    expect(markup).toContain('Groups &amp; Events');
    expect(markup).toContain('Unknown / Needs Review');
    expect(markup).toContain('External correspondents');
    expect(markup).toContain('public-email');
    expect(markup).toContain('Answered');
    expect(markup).toContain('No reply required');
    expect(markup).toContain('Unknown evidence');
    expect(markup).toContain('Primary request-state buckets are mutually exclusive');
    expect(markup).toContain('Export bounded snapshot');
    expect(markup).toContain('Measurement config version');
    expect(markup).toContain('Source vintage');
    expect(markup).toContain('classificationAsOf');
    expect(markup).toContain('View data table');
    expect(markup).not.toContain('Total revenue');
  });

  it('uses CSS-pixel touch-target floors under the scaled document root', () => {
    const markup = renderToStaticMarkup(createElement(AdminDashboardPage));
    const pixelTargetCount = (markup.match(/min-h-\[44px\]/g) ?? []).length;

    expect(pixelTargetCount, 'dashboard interactive targets').toBe(34);
    expect(markup).not.toContain('min-h-11');
  });

  it('labels the prior snapshot while a changed selection is still refreshing', () => {
    useAdminDashboardDataMock.mockReturnValue({
      canAccess: true,
      isLoading: false,
      isError: false,
      isStale: true,
      source: 'hosted',
      data: null,
      metrics: {
        ...metrics,
        query: { ...metrics.query!, window: '28d' },
      },
    });

    const markup = renderToStaticMarkup(createElement(AdminDashboardPage));

    expect(markup).toContain(
      'Selected cohort/window/cutoff: centurion / 7d / latest. Observed cohort/window/cutoff: centurion / 28d / 2026-09-07T12:00:00.000Z.',
    );
    expect(markup).toContain('The selected query is refreshing; showing the observed snapshot.');
    expect(markup).toContain('<dt class="text-foreground font-medium">Window</dt><dd>28d</dd>');
  });

  it('labels a latest selection separately from an explicitly cut-off observed snapshot', () => {
    useAdminDashboardDataMock.mockReturnValue({
      canAccess: true,
      isLoading: false,
      isError: true,
      isStale: true,
      source: 'hosted',
      data: null,
      metrics: {
        ...metrics,
        query: { ...metrics.query!, observationCutoff: '2026-09-06T12:00:00.000Z' },
      },
    });

    const markup = renderToStaticMarkup(createElement(AdminDashboardPage));

    expect(markup).toContain(
      'Selected cohort/window/cutoff: centurion / 7d / latest. Observed cohort/window/cutoff: centurion / 7d / 2026-09-06T12:00:00.000Z.',
    );
    expect(markup).toContain(
      'The selected query failed; showing the observed snapshot; no demo data is substituted.',
    );
  });

  it('labels the prior snapshot when a changed selection fails', () => {
    useAdminDashboardDataMock.mockReturnValue({
      canAccess: true,
      isLoading: false,
      isError: true,
      isStale: true,
      source: 'hosted',
      data: null,
      metrics: {
        ...metrics,
        query: { ...metrics.query!, window: '28d' },
      },
    });

    const markup = renderToStaticMarkup(createElement(AdminDashboardPage));

    expect(markup).toContain(
      'Selected cohort/window/cutoff: centurion / 7d / latest. Observed cohort/window/cutoff: centurion / 28d / 2026-09-07T12:00:00.000Z.',
    );
    expect(markup).toContain(
      'The selected query failed; showing the observed snapshot; no demo data is substituted.',
    );
    expect(markup).toContain('<dt class="text-foreground font-medium">Window</dt><dd>28d</dd>');
  });

  it('keeps unavailable chart evidence inspectable instead of reducing it to a reason-only state', () => {
    useAdminDashboardDataMock.mockReturnValue({
      canAccess: true,
      isLoading: false,
      isError: false,
      isStale: false,
      source: 'hosted',
      data: null,
      metrics: {
        ...metrics,
        traffic: {
          ...metrics.traffic!,
          daily: unavailableMetric<AdminDashboardDailyPoint[]>(
            'messages per day',
            'classification_snapshot_unavailable',
          ),
        },
      },
    });

    const markup = renderToStaticMarkup(createElement(AdminDashboardPage));

    expect(markup).toContain('Message trend unavailable');
    expect(markup).toContain('aria-label="Message trend evidence"');
    expect(markup).toContain('classification snapshot unavailable');
  });

  it('shows diagnostic ratios and shares only when their denominators are known', () => {
    useAdminDashboardDataMock.mockReturnValue({
      canAccess: true,
      isLoading: false,
      isError: false,
      isStale: false,
      source: 'hosted',
      data: null,
      metrics: {
        ...metrics,
        dataHealth: {
          ...metrics.dataHealth!,
          quotedMailboxReplyNoMatchingOutbound: {
            numerator: 2,
            denominator: 4,
            availability: 'available',
          },
        },
      },
    });

    const availableMarkup = renderToStaticMarkup(createElement(AdminDashboardPage));
    expect(availableMarkup).toContain('Direction ratio');
    expect(availableMarkup).toContain('6:4');
    expect(availableMarkup).toContain('Singleton quoted-mailbox-reply share');
    expect(availableMarkup).toContain('50.0% (2/4)');
    expect(availableMarkup).toContain('Inbound clock basis');

    useAdminDashboardDataMock.mockReturnValue({
      canAccess: true,
      isLoading: false,
      isError: false,
      isStale: false,
      source: 'hosted',
      data: null,
      metrics: {
        ...metrics,
        dataHealth: {
          ...metrics.dataHealth!,
          availability: 'unavailable',
          availabilityReason: 'missing_evidence',
          directionCounts: { inbound: null, outbound: null },
          lastObservedAt: { inbound: null, outbound: null },
          lastObservedBasis: { inbound: null, outbound: null },
          singleton: { numerator: null, denominator: null },
          quotedMailboxReplyNoMatchingOutbound: {
            numerator: null,
            denominator: null,
            availability: 'unavailable',
            reason: 'quote_projection_unavailable',
          },
        },
      },
    });

    const unavailableMarkup = renderToStaticMarkup(createElement(AdminDashboardPage));
    expect(unavailableMarkup).toContain('Diagnostics unavailable: missing evidence');
    expect(unavailableMarkup).not.toContain('Unscorable events');
  });

  it('renders strict service count evidence with the configured measurement start', () => {
    const strictService = {
      ...metrics.service!,
      counts: {
        eligibleNewConversations: {
          ...metric(2, 'conversations', null),
          denominatorStatus: 'not_applicable',
        },
        unansweredEligible: {
          ...metric(1, 'conversations', 2),
          denominatorStatus: 'known',
        },
        unscorable: {
          ...metric(0, 'conversations', 2),
          denominatorStatus: 'known',
        },
        measurementStartAt: '2026-08-01T00:00:00.000Z',
      },
    } as unknown as AdminDashboardMetrics['service'];
    useAdminDashboardDataMock.mockReturnValue({
      canAccess: true,
      isLoading: false,
      isError: false,
      isStale: false,
      source: 'hosted',
      data: null,
      metrics: {
        ...metrics,
        service: strictService,
      },
    });

    const markup = renderToStaticMarkup(createElement(AdminDashboardPage));

    expect(markup).toContain('Eligible new conversations');
    expect(markup).toContain('aria-label="Eligible new conversations evidence"');
    expect(markup).toContain('Measurement start');
    expect(markup).toContain('01 Aug 2026');
    expect(markup).toContain('Not applicable (absolute count)');
    expect(markup).toContain('Known eligible new conversations');
  });
});
