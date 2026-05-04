import { describe, expect, it, vi } from 'vitest';
import type { AppRouter } from '@zero/server/trpc';
import { createLegacyTrpcAdapter } from '../lib/api/adapters/legacy-trpc';

describe('legacy trpc adapter wiring', () => {
  it('delegates mail.listThreads to the tRPC client', async () => {
    const query = vi.fn().mockResolvedValue({ threads: [{ id: 't1' }], nextPageToken: null });
    const client = {
      mail: {
        listThreads: { query },
        get: { query: vi.fn() },
        send: { mutate: vi.fn() },
        unsend: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
        bulkDelete: { mutate: vi.fn() },
        bulkArchive: { mutate: vi.fn() },
        markAsRead: { mutate: vi.fn() },
        markAsUnread: { mutate: vi.fn() },
        toggleStar: { mutate: vi.fn() },
        toggleImportant: { mutate: vi.fn() },
        modifyLabels: { mutate: vi.fn() },
        snoozeThreads: { mutate: vi.fn() },
        unsnoozeThreads: { mutate: vi.fn() },
        getMessageAttachments: { query: vi.fn() },
        processEmailContent: { mutate: vi.fn() },
        suggestRecipients: { query: vi.fn() },
        verifyEmail: { query: vi.fn() },
        forceSync: { mutate: vi.fn() },
      },
      drafts: {
        get: { query: vi.fn() },
        list: { query: vi.fn() },
        create: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
      },
      labels: {
        list: { query: vi.fn() },
        create: { mutate: vi.fn() },
        update: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
      },
      settings: {
        get: { query: vi.fn().mockResolvedValue({ settings: {} }) },
        save: { mutate: vi.fn() },
      },
      connections: {
        list: { query: vi.fn().mockResolvedValue({ connections: [] }) },
        getDefault: { query: vi.fn() },
        setDefault: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
      },
      notes: {
        list: { query: vi.fn() },
        create: { mutate: vi.fn() },
        update: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
        reorder: { mutate: vi.fn() },
      },
      templates: {
        list: { query: vi.fn() },
        create: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
      },
      ai: {
        generateSearchQuery: { mutate: vi.fn() },
        compose: { mutate: vi.fn() },
        generateEmailSubject: { mutate: vi.fn() },
        webSearch: { mutate: vi.fn() },
      },
      brain: {
        generateSummary: { query: vi.fn() },
        getState: { query: vi.fn() },
        getPrompts: { query: vi.fn() },
        updatePrompt: { mutate: vi.fn() },
      },
      bimi: {
        getByEmail: { query: vi.fn() },
      },
      user: {
        delete: { mutate: vi.fn() },
        getIntercomToken: { query: vi.fn() },
      },
    } as unknown as AppRouter;

    const api = createLegacyTrpcAdapter(client);
    await api.mail.listThreads({ folder: 'inbox' });
    expect(query).toHaveBeenCalledWith({ folder: 'inbox' });
    expect(api.capabilities.mode).toBe('legacy');
  });
});
