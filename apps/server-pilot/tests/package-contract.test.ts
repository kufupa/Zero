import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

const FORBIDDEN_AI_PACKAGES = [
  'langfuse',
  'langsmith',
  '@mastra/langfuse',
  '@mastra/langsmith',
  '@mastra/platform',
  '@mastra/observability-langfuse',
  '@mastra/observability-langsmith',
];

describe('server-pilot package contract', () => {
  it('does not depend on hosted observability or Mastra platform exporters', () => {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const depNames = Object.keys(allDeps);

    for (const forbidden of FORBIDDEN_AI_PACKAGES) {
      expect(depNames).not.toContain(forbidden);
    }

    const hostedObservability = depNames.filter(
      (name) =>
        name.includes('langfuse') ||
        name.includes('langsmith') ||
        (name.startsWith('@mastra/') && name.includes('platform')),
    );
    expect(hostedObservability).toEqual([]);
  });

  it(
    'exports modules apps/mail imports via package.json exports map',
    async () => {
      await expect(import('@zero/server/trpc')).resolves.toBeDefined();
      await expect(import('@zero/server/auth')).resolves.toBeDefined();
      await expect(import('@zero/server/auth-providers')).resolves.toBeDefined();
      await expect(import('@zero/server/schemas')).resolves.toBeDefined();
    },
    30_000,
  );

  it('package.json exports map includes mail-facing entrypoints', () => {
    expect(pkg.exports).toMatchObject({
      './trpc': expect.any(String),
      './auth': expect.any(String),
      './auth-providers': expect.any(String),
      './schemas': expect.any(String),
    });
  });

  it('exposes AppRouter type and appRouter value from /trpc', async () => {
    const mod = await import('@zero/server/trpc');
    expect(mod.appRouter).toBeDefined();
    expect(typeof mod.router).toBe('function');
  });

  it('exposes Auth type builder from /auth', async () => {
    const mod = await import('@zero/server/auth');
    expect(typeof mod.createAuth).toBe('function');
  });

  it('exposes EnvVarInfo shape and authProviders from /auth-providers', async () => {
    const mod = await import('@zero/server/auth-providers');
    expect(Array.isArray(mod.authProviders({}))).toBe(true);
    expect(Array.isArray(mod.customProviders)).toBe(true);
    expect(typeof mod.getSocialProviders).toBe('function');
  });

  it('exposes schema constants from /schemas', async () => {
    const mod = await import('@zero/server/schemas');
    expect(mod.userSettingsSchema).toBeDefined();
    expect(mod.defaultUserSettings).toBeDefined();
    expect(mod.defaultUserSettings.confirmation).toEqual({ mode: 'self' });
    const withConfirmation = mod.userSettingsSchema.parse({
      ...mod.defaultUserSettings,
      confirmation: { mode: 'custom', address: 'desk@example.invalid' },
      notASetting: true,
    });
    expect(withConfirmation.confirmation).toEqual({ mode: 'custom', address: 'desk@example.invalid' });
    expect('notASetting' in withConfirmation).toBe(false);
    const legacy = mod.userSettingsSchema.parse({
      language: 'en',
      timezone: 'UTC',
      externalImages: true,
    });
    expect(legacy.confirmation).toBeUndefined();
    expect(
      mod.userSettingsSchema.safeParse({
        ...mod.defaultUserSettings,
        confirmation: { mode: 'custom', address: 'not-an-email' },
      }).success,
    ).toBe(false);
    expect(
      mod.confirmationSettingSchema.safeParse({ mode: 'hotel' }).success,
    ).toBe(false);
    expect(Array.isArray(mod.defaultMailCategories)).toBe(true);
    expect(mod.mailCategorySchema).toBeDefined();
    expect(mod.createDraftData).toBeDefined();
    expect(mod.serializedFileSchema).toBeDefined();
    expect(typeof mod.deserializeFiles).toBe('function');
  });
});

import type {
  MailCategory,
  MailFilterInput,
  ParsedDraft,
  ParsedMessage,
  PilotCapabilities,
  ThreadDetailResponse,
  ThreadListItem,
  ThreadListResponse,
} from '../src/lib/driver/types.js';

describe('driver type package contract', () => {
  it('exports live pilot mail contract types', () => {
    const message = {
      id: 'msg-1',
      title: 'Hello',
      subject: 'Hello',
      tags: [],
      sender: { email: 'guest@example.com' },
      to: [{ email: 'nava@example.com' }],
      cc: null,
      bcc: null,
      tls: true,
      receivedOn: '2026-07-06T10:00:00.000Z',
      unread: true,
      body: 'Body',
      processedHtml: 'Body',
      blobUrl: '',
      threadId: 'thread-1',
      isDraft: false,
    } satisfies ParsedMessage;

    const draft = {
      id: 'draft-1',
      threadId: 'thread-1',
      replyToMessageId: 'msg-1',
      to: ['guest@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      content: '<p>Reply</p>',
      updatedAt: '2026-07-06T10:01:00.000Z',
      status: 'active',
      origin: 'manual',
      generationId: null,
      isStale: false,
    } satisfies ParsedDraft;

    const category = {
      id: 'cat-new-bookings',
      slug: 'new-bookings',
      name: 'New Bookings',
      color: '#14b8a6',
      sortOrder: 10,
    } satisfies MailCategory;

    const filters = {
      unread: true,
      important: false,
      starred: false,
      categoryIds: [category.id],
      labelIds: [],
    } satisfies MailFilterInput;

    const listItem = {
      id: 'thread-1',
      subject: 'Hello',
      snippet: 'Body',
      latestMessageAt: '2026-07-06T10:00:00.000Z',
      isRead: false,
      isStarred: false,
      labelIds: [],
      categoryIds: [category.id],
      hasDraft: true,
      draftCount: 1,
    } satisfies ThreadListItem;

    const list = {
      threads: [listItem],
      nextPageToken: null,
    } satisfies ThreadListResponse;

    const detail = {
      latest: message,
      messages: [message],
      drafts: [draft],
      hasUnread: true,
      totalReplies: 1,
      labels: [],
      categories: [category],
      categoryIds: [category.id],
    } satisfies ThreadDetailResponse;

    const caps = {
      ai: false,
      brain: false,
      notes: false,
      templates: false,
      bimi: false,
      gmailSearchGrammar: true,
      hotelCategories: true,
      staleDraftWarning: true,
    } satisfies PilotCapabilities;

    expect(detail.drafts[0]?.id).toBe('draft-1');
    expect(detail.categories[0]?.slug).toBe('new-bookings');
    expect(filters.categoryIds).toEqual(['cat-new-bookings']);
    expect(list.threads).toHaveLength(1);
    expect(caps.hotelCategories).toBe(true);
  });
});
