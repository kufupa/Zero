import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('unread count invalidation and freshness contract', () => {
  it('verifies useOptimisticActions refreshData includes trpc.mail.unreadCounts alongside labels', () => {
    const filePath = path.resolve(__dirname, '../hooks/use-optimistic-actions.ts');
    const content = fs.readFileSync(filePath, 'utf-8');

    // refreshData must query trpc.mail.unreadCounts
    expect(content).toMatch(/trpc\.mail\.unreadCounts\.queryKey\(\)/);
    expect(content).toMatch(/trpc\.labels\.list\.queryKey\(\)/);

    // doAction must call refreshData when pending actions are completed
    expect(content).toMatch(/await refreshData\(\)/);
  });

  it('verifies nav-user handleForceSyncAction invalidates unreadCounts alongside listThreads', () => {
    const filePath = path.resolve(__dirname, '../components/ui/nav-user.tsx');
    const content = fs.readFileSync(filePath, 'utf-8');

    // Force sync must invalidate trpc.mail.unreadCounts
    expect(content).toContain('trpc.mail.unreadCounts.queryKey()');
    expect(content).toContain('trpc.mail.listThreads.infiniteQueryKey()');
  });

  it('verifies nav-user handleAccountSwitch removes/invalidates unreadCounts on transport change', () => {
    const filePath = path.resolve(__dirname, '../components/ui/nav-user.tsx');
    const content = fs.readFileSync(filePath, 'utf-8');

    // Account switch must clear/remove unread counts query so old transport snapshot is not reused
    expect(content).toMatch(/trpc\.mail\.unreadCounts\.queryKey\(\)/);
    expect(content).toMatch(/removeQueries|invalidateQueries|refetchQueries/);
  });

  it('verifies connections page invalidateThreads includes unreadCounts', () => {
    const filePath = path.resolve(__dirname, '../app/(routes)/settings/connections/page.tsx');
    const content = fs.readFileSync(filePath, 'utf-8');

    // invalidateThreads must invalidate unreadCounts query
    expect(content).toContain('trpc.mail.unreadCounts.queryKey()');
  });

  it('verifies useUnreadCounts hook consumes the exported resolveThreadPollingMs policy', () => {
    const filePath = path.resolve(__dirname, '../hooks/use-unread-counts.ts');
    const content = fs.readFileSync(filePath, 'utf-8');

    expect(content).toContain('resolveThreadPollingMs');
    expect(content).toContain('@/lib/mail/thread-polling-policy');
  });
});
