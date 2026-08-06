import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '@/lib/demo/runtime';

vi.mock('@/lib/demo/runtime', () => ({
  isFrontendOnlyDemo: vi.fn(),
}));

import { describeAdminSource, isAdminDashboardEnabled } from '@/lib/admin-dashboard/access';

describe('isAdminDashboardEnabled', () => {
  beforeEach(() => {
    vi.mocked(runtime.isFrontendOnlyDemo).mockReset();
  });

  it('always enables the dashboard in demo mode', () => {
    vi.mocked(runtime.isFrontendOnlyDemo).mockReturnValue(true);

    expect(isAdminDashboardEnabled({ user: { email: 'any@example.com' } })).toBe(true);
    expect(describeAdminSource(null)).toBe('demo');
  });

  it('only enables allowlist users when not in demo', () => {
    vi.mocked(runtime.isFrontendOnlyDemo).mockReturnValue(false);

    expect(isAdminDashboardEnabled({ user: { email: 'centurion@legacyhotels.co.za' } })).toBe(true);
    expect(isAdminDashboardEnabled({ user: { email: 'ropperman@legacyhotels.co.za' } })).toBe(true);
    expect(isAdminDashboardEnabled({ user: { email: 'random@legacyhotels.co.za' } })).toBe(false);
    expect(isAdminDashboardEnabled(null)).toBe(false);
    expect(describeAdminSource({ user: { email: 'random@legacyhotels.co.za' } })).toBe('hosted');
  });
});
