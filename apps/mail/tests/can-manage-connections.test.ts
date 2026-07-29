import { describe, expect, it } from 'vitest';
import { canManageConnections } from '@/lib/mail/can-manage-connections';

describe('canManageConnections', () => {
  it('is false for 0 or 1 connection', () => {
    expect(canManageConnections(0)).toBe(false);
    expect(canManageConnections(1)).toBe(false);
  });

  it('is true for 2+ connections', () => {
    expect(canManageConnections(2)).toBe(true);
    expect(canManageConnections(5)).toBe(true);
  });
});
