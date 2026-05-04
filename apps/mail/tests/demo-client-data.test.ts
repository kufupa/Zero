import { describe, expect, it } from 'vitest';
import { getDemoActiveConnection, listDemoConnections, listDemoLabels } from '../lib/demo-data/client';
import { normalizeDemoMailFolderSlug } from '../lib/demo/folder-map';

const REMOVED_DEMO_LABELS = new Set(['comment', 'to respond', 'promotion', 'billing', 'notification']);

describe('demo client data helpers', () => {
  it('normalizes demo mail folder slugs for list queries', () => {
    expect(normalizeDemoMailFolderSlug('urgent')).toBe('urgent');
    expect(normalizeDemoMailFolderSlug('hr')).toBe('internal');
    expect(normalizeDemoMailFolderSlug('inbox')).toBe('inbox');
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

  it('omits removed demo labels from list payload', () => {
    const labels = listDemoLabels();
    const hasRemovedLabel = labels.some(
      (label) =>
        REMOVED_DEMO_LABELS.has(label.id.toLowerCase()) || REMOVED_DEMO_LABELS.has(label.name.toLowerCase()),
    );

    expect(hasRemovedLabel).toBe(false);
  });
});
