import { describe, expect, it } from 'vitest';
import denominators from '../evals/hms/denominators.v1.json';
import {
  activeDiscoveryCapabilities,
  productionActiveReadToolIds,
} from '../src/hms/contracts';

describe('HMS evidence baseline contracts', () => {
  it('keeps coverage denominators disjointly named and immutable', () => {
    expect(denominators.version).toBe(1);
    expect(denominators.draftEligible.members).toHaveLength(56);
    expect(denominators.operationalPortfolio.members).toHaveLength(116);
    expect(new Set(denominators.draftEligible.members).size).toBe(56);
    expect(new Set(denominators.operationalPortfolio.members).size).toBe(116);
    expect(denominators.referenceCounts).toEqual({
      toolDependentHistorical: 61,
      historicalWorkflow: 68,
      replyWorthy: 97,
    });
  });

  it('permits only active read surfaces in autonomous discovery', () => {
    expect(activeDiscoveryCapabilities()).toEqual([
      'login',
      'reservation-search',
      'room-type-rate-availability',
    ]);
    expect(activeDiscoveryCapabilities()).not.toContain('write-forms');
    expect(activeDiscoveryCapabilities()).not.toContain('crs-check-availability');
  });

  it('production active-read tool allowlist includes soft-proven PMS tools', () => {
    // Quote discovery is intentionally not production-active until a trusted
    // current-rate authority is wired and live-proven.
    expect(productionActiveReadToolIds().sort()).toEqual(['hms_find_reservation']);
  });
});
