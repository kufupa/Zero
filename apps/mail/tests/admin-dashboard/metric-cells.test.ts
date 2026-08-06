import { describe, expect, it } from 'vitest';
import {
  formatLiveNumber,
  formatMetricCell,
  summarizeTransportSeries,
} from '@/lib/admin-dashboard/types';

describe('formatMetricCell', () => {
  it('renders live values and dashes everything else', () => {
    expect(formatMetricCell({ availability: 'live', value: 12 })).toBe('12');
    expect(formatMetricCell({ availability: 'live', value: null })).toBe('—');
    expect(formatMetricCell({ availability: 'unavailable', value: null })).toBe('—');
    // A non-live cell must never render its number, even if one leaks through.
    expect(formatMetricCell({ availability: 'coming_soon', value: 999 })).toBe('—');
    expect(formatMetricCell(null)).toBe('—');
  });
});

describe('formatLiveNumber', () => {
  it('dashes null instead of coercing to zero', () => {
    expect(formatLiveNumber(null)).toBe('—');
    expect(formatLiveNumber(0, (v) => `${v}%`)).toBe('0%');
  });
});

describe('summarizeTransportSeries', () => {
  it('recomputes a subset from raw latencies rather than averaging medians', () => {
    const summary = summarizeTransportSeries([
      { transportId: 'a', label: 'A', inbound: 3, latenciesMinutes: [10, 30], unanswered: 0 },
      { transportId: 'b', label: 'B', inbound: 1, latenciesMinutes: [200], unanswered: 1 },
    ]);

    expect(summary.inbound).toBe(4);
    expect(summary.medianMinutes).toBe(30);
    expect(summary.unanswered).toBe(1);
    // 2 of 4 eligible threads answered inside 180 minutes.
    expect(summary.answeredWithin3hPercent).toBe(50);
  });

  it('returns nulls when no eligible threads exist', () => {
    const summary = summarizeTransportSeries([
      { transportId: 'a', label: 'A', inbound: 0, latenciesMinutes: [], unanswered: 0 },
    ]);

    expect(summary.medianMinutes).toBeNull();
    expect(summary.p90Minutes).toBeNull();
    expect(summary.answeredWithin3hPercent).toBeNull();
  });

  it('counts an all-unanswered mailbox as a real zero percent', () => {
    const summary = summarizeTransportSeries([
      { transportId: 'a', label: 'A', inbound: 2, latenciesMinutes: [], unanswered: 2 },
    ]);

    expect(summary.answeredWithin3hPercent).toBe(0);
    expect(summary.medianMinutes).toBeNull();
  });
});
