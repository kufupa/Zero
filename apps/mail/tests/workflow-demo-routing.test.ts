import {
  getDemoMailFolderDefinition,
  normalizeDemoMailFolderSlug,
} from '../lib/demo/folder-map';
import { listDemoThreads } from '../lib/demo-data/adapter';
import { describe, expect, it } from 'vitest';

const aliases = [
  ['bookings', 'bookings'],
  ['new-bookings', 'new-bookings'],
  ['new-booking', 'new-bookings'],
  ['at_risk', 'at-risk'],
  ['risk', 'at-risk'],
  ['groups', 'groups-events'],
  ['events', 'groups-events'],
  ['mice', 'groups-events'],
  ['operations', 'ops'],
  ['handover', 'ops'],
] as const;

describe('workflow demo routing', () => {
  it.each(aliases)('%s resolves to the canonical %s demo folder', (alias, expected) => {
    expect(getDemoMailFolderDefinition(alias)?.id).toBe(expected);
    expect(normalizeDemoMailFolderSlug(` ${alias} `)).toBe(expected);

    const aliasThreads = listDemoThreads({
      folder: normalizeDemoMailFolderSlug(alias),
      maxResults: 100,
    });
    const canonicalThreads = listDemoThreads({ folder: expected, maxResults: 100 });

    expect(aliasThreads.threads.map((thread) => thread.id)).toEqual(
      canonicalThreads.threads.map((thread) => thread.id),
    );
    expect(aliasThreads.threads.length, alias).toBeGreaterThan(0);
  });
});
