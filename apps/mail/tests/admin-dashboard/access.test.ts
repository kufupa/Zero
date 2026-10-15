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

  it('enables only the owner email when not in demo', () => {
    vi.mocked(runtime.isFrontendOnlyDemo).mockReturnValue(false);

    expect(isAdminDashboardEnabled({ user: { email: 'navaai@legacyhotels.co.za' } })).toBe(true);
    expect(isAdminDashboardEnabled({ user: { email: '  NavaAI@LegacyHotels.co.za ' } })).toBe(true);
    expect(isAdminDashboardEnabled({ user: { email: 'centurion@legacyhotels.co.za' } })).toBe(false);
    expect(isAdminDashboardEnabled({ user: { email: 'martha@legacyhotels.co.za' } })).toBe(false);
    expect(isAdminDashboardEnabled(null)).toBe(false);
    expect(describeAdminSource({ user: { email: 'navaai@legacyhotels.co.za' } })).toBe('hosted');
  });
});
