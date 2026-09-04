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

  it('verifies email-composer invalidates unreadCounts on draft save', () => {
    const filePath = path.resolve(__dirname, '../components/create/email-composer.tsx');
    const content = fs.readFileSync(filePath, 'utf-8');

    // persistDraftOnce must invalidate trpc.mail.unreadCounts alongside drafts.list
    expect(content).toContain('queryClient.invalidateQueries({ queryKey: trpc.mail.unreadCounts.queryKey() })');
  });

  it('verifies email-composer invalidates unreadCounts after sending email', () => {
    const filePath = path.resolve(__dirname, '../components/create/email-composer.tsx');
    const content = fs.readFileSync(filePath, 'utf-8');

    // proceedWithSend must invalidate trpc.mail.unreadCounts when message is sent
    const proceedWithSendIndex = content.indexOf('const proceedWithSend = async');
    const handleSendIndex = content.indexOf('const handleSend = async');
    expect(proceedWithSendIndex).toBeGreaterThanOrEqual(0);
    expect(handleSendIndex).toBeGreaterThan(proceedWithSendIndex);

    const proceedSnippet = content.slice(proceedWithSendIndex, handleSendIndex);
    expect(proceedSnippet).toContain('trpc.mail.unreadCounts.queryKey()');
  });
});

