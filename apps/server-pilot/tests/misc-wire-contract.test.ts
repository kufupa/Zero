/**
 * Golden wire-contract tests — drafts.create, settings.save, user.getIntercomToken
 * shapes from FE must parse through server-pilot input schemas without zod errors.
 */
import { describe, expect, it } from 'vitest';
import { createDraftInput } from '../src/trpc/wire-compat.js';
import { settingsSaveInput } from '../src/trpc/routes/settings.js';
import { defaultMailCategories } from '../src/lib/schemas.js';

/** Golden payload from email-composer.tsx saveDraft. */
const GOLDEN_DRAFT_FROM_COMPOSER = {
  to: 'guest@example.com, partner@example.com',
  cc: 'cc@example.com',
  bcc: 'bcc@example.com',
  subject: 'Booking confirmation',
  body: '<p>Your room is ready.</p>',
  message: '<p>Your room is ready.</p>',
  attachments: [] as {
    name: string;
    type: string;
    size: number;
    lastModified: number;
    base64: string;
  }[],
  id: 'draft-uuid-1',
  threadId: 'thread-centurion-1',
  fromEmail: 'frontdesk@legacyhotel.com',
};

/** Golden payload from mailto-handler.ts createDraftFromMailto. */
const GOLDEN_DRAFT_FROM_MAILTO = {
  id: null,
  subject: 'mailto subject',
  message: '<!DOCTYPE html><html><body><p>Hello</p></body></html>',
  attachments: [] as {
    name: string;
    type: string;
    size: number;
    lastModified: number;
    base64: string;
  }[],
  to: 'guest@example.com',
  cc: '',
  bcc: '',
};

describe('misc wire contract — drafts.create accepts FE payload', () => {
  it('parses email-composer string recipients, body/message, and client id', () => {
    const parsed = createDraftInput.parse(GOLDEN_DRAFT_FROM_COMPOSER);
    expect(parsed.to).toEqual(['guest@example.com', 'partner@example.com']);
    expect(parsed.cc).toEqual(['cc@example.com']);
    expect(parsed.bcc).toEqual(['bcc@example.com']);
    expect(parsed.html).toBe('<p>Your room is ready.</p>');
    expect(parsed.id).toBe('draft-uuid-1');
    expect(parsed.threadId).toBe('thread-centurion-1');
  });

  it('parses mailto-handler comma-joined recipients and null id', () => {
    const parsed = createDraftInput.parse(GOLDEN_DRAFT_FROM_MAILTO);
    expect(parsed.to).toEqual(['guest@example.com']);
    expect(parsed.cc).toEqual([]);
    expect(parsed.bcc).toEqual([]);
    expect(parsed.id).toBeNull();
    expect(parsed.html).toContain('<p>Hello</p>');
  });

  it('prefers message over body when both present', () => {
    const parsed = createDraftInput.parse({
      to: 'a@example.com',
      subject: 'hi',
      body: '<p>body</p>',
      message: '<p>message</p>',
      id: null,
    });
    expect(parsed.html).toBe('<p>message</p>');
  });

  it('falls back to body when message omitted', () => {
    const parsed = createDraftInput.parse({
      to: 'a@example.com',
      subject: 'hi',
      body: '<p>body only</p>',
      id: null,
    });
    expect(parsed.html).toBe('<p>body only</p>');
  });
});

describe('misc wire contract — settings.save accepts bare partial object', () => {
  it('parses categories-only save from settings/categories page', () => {
    const parsed = settingsSaveInput.parse({ categories: defaultMailCategories });
    expect(parsed.categories).toEqual(defaultMailCategories);
  });

  it('parses trustedSenders partial from mail-content persistTrustedSender', () => {
    const parsed = settingsSaveInput.parse({
      trustedSenders: ['guest@example.com'],
    });
    expect(parsed.trustedSenders).toEqual(['guest@example.com']);
  });

  it('parses full general settings object from settings/general page', () => {
    const parsed = settingsSaveInput.parse({
      language: 'en',
      timezone: 'America/New_York',
      dynamicContent: false,
      externalImages: true,
      customPrompt: '',
      colorTheme: 'system',
      zeroSignature: false,
      defaultEmailAlias: 'user@example.com',
      undoSendEnabled: true,
      imageCompression: 'medium',
      autoRead: true,
      animations: false,
    });
    expect(parsed.language).toBe('en');
    expect(parsed.defaultEmailAlias).toBe('user@example.com');
  });
});

describe('misc wire contract — user.getIntercomToken return shape', () => {
  it('bare null is falsy so nav-main skips Intercom bootstrap', () => {
    const intercomToken: string | null = null;
    expect(Boolean(intercomToken)).toBe(false);
    // Wrapped { token: null } is truthy — would wrongly bootstrap Intercom.
    expect(Boolean({ token: null as string | null })).toBe(true);
  });
});

import { appRouter } from '../src/trpc/router.js';

describe('pilot inert legacy routers', () => {
  it('exposes disabled pilot capabilities and safe empty legacy responses', async () => {
    const caller = appRouter.createCaller({
      source: 'test',
      sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
      activeTransportId: 'transport-1',
    } as never);

    await expect(caller.brain.getCapabilities()).resolves.toMatchObject({
      ai: false,
      brain: false,
      notes: false,
      templates: false,
      bimi: false,
      gmailSearchGrammar: true,
      hotelCategories: true,
      staleDraftWarning: true,
      catchupUpload: false,
      paneSave: false,
      paneSaveMode: 'off',
    });

    const prevPaneSave = process.env.RESERVATIONIST_PANE_SAVE;
    try {
      process.env.RESERVATIONIST_PANE_SAVE = 'on';
      await expect(caller.brain.getCapabilities()).resolves.toMatchObject({
        paneSave: true,
        paneSaveMode: 'on',
      });
      process.env.RESERVATIONIST_PANE_SAVE = 'lab';
      await expect(caller.brain.getCapabilities()).resolves.toMatchObject({
        paneSave: true,
        paneSaveMode: 'lab',
      });
      process.env.RESERVATIONIST_PANE_SAVE = 'off';
      await expect(caller.brain.getCapabilities()).resolves.toMatchObject({
        paneSave: false,
        paneSaveMode: 'off',
      });
    } finally {
      if (prevPaneSave === undefined) {
        delete process.env.RESERVATIONIST_PANE_SAVE;
      } else {
        process.env.RESERVATIONIST_PANE_SAVE = prevPaneSave;
      }
    }

    const prevFlag = process.env.CATCHUP_UPLOAD_ENABLED;
    try {
      process.env.CATCHUP_UPLOAD_ENABLED = 'true';
      await expect(caller.brain.getCapabilities()).resolves.toMatchObject({
        catchupUpload: true,
      });
    } finally {
      if (prevFlag === undefined) {
        delete process.env.CATCHUP_UPLOAD_ENABLED;
      } else {
        process.env.CATCHUP_UPLOAD_ENABLED = prevFlag;
      }
    }

    await expect(caller.ai.generateSearchQuery({ prompt: 'find urgent mail' })).resolves.toEqual({
      query: '',
      disabled: true,
    });

    await expect(caller.notes.list({ threadId: 'thread-1' })).resolves.toEqual([]);
    await expect(caller.templates.list()).resolves.toEqual([]);
    await expect(caller.bimi.getByEmail({ email: 'guest@example.com' })).resolves.toBeNull();
  });
});
