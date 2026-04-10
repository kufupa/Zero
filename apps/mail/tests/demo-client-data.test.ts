import { describe, expect, it } from 'vitest';
import {
  getDemoActiveConnection,
  listDemoConnections,
  listDemoLabels,
  resolveDemoThreadQueryContext,
} from '../lib/demo-data/client';

describe('demo client data helpers', () => {
  it('maps queue slugs to inbox query context', () => {
    expect(resolveDemoThreadQueryContext('urgent')).toEqual({
      folder: 'inbox',
      workQueue: 'urgent',
    });
    expect(resolveDemoThreadQueryContext('inbox')).toEqual({
      folder: 'inbox',
      workQueue: null,
    });
  });

  it('returns a deterministic demo connection payload', () => {
    const result = listDemoConnections();
    const active = getDemoActiveConnection();

    expect(result.connections.length).toBeGreaterThan(0);
    expect(active?.id).toBe(result.connections[0]?.id);
    expect(active?.providerId).toBe('demo');
  });

  it('builds a deduped label list from corpus data', () => {
    const labels = listDemoLabels();
    const uniqueIds = new Set(labels.map((label) => label.id));

    expect(labels.length).toBeGreaterThan(0);
    expect(uniqueIds.size).toBe(labels.length);
  });
});
