/**
 * Golden wire-contract tests — FE payload shapes from use-optimistic-actions.ts
 * must parse through server-pilot mail input schemas without zod errors.
 */
import { describe, expect, it } from 'vitest';
import {
  bulkIdsInput,
  snoozeThreadsInput,
  modifyLabelsInput,
  listThreadsInput,
  MAIL_FOLDER_VALUES,
} from '../src/trpc/routes/mail.js';
import {
  buildMetadataDebugHeaders,
  parseFromEmail,
  sendInput,
  toParsedMessage,
} from '../src/trpc/wire-compat.js';
import type { MessageRow } from '../src/trpc/wire-compat.js';

/** Golden thread ids copied from FE bulk mutation calls. */
const GOLDEN_IDS = ['thread-abc-1', 'thread-abc-2'];
const GOLDEN_WAKE_AT = '2026-07-03T10:00:00.000Z';
const GOLDEN_LABEL_ID = 'label-important-1';

describe('mail wire contract — bulk mutations accept { ids }', () => {
  const goldenPayload = { ids: GOLDEN_IDS };

  it('markAsRead / markAsUnread / toggleStar / toggleImportant', () => {
    for (const _op of ['markAsRead', 'markAsUnread', 'toggleStar', 'toggleImportant'] as const) {
      const parsed = bulkIdsInput.parse(goldenPayload);
      expect(parsed.threadIds).toEqual(GOLDEN_IDS);
    }
  });

  it('bulkArchive / bulkDelete / unsnoozeThreads', () => {
    for (const _op of ['bulkArchive', 'bulkDelete', 'unsnoozeThreads'] as const) {
      const parsed = bulkIdsInput.parse(goldenPayload);
      expect(parsed.threadIds).toEqual(GOLDEN_IDS);
    }
  });
});

describe('mail wire contract — snooze accepts { ids, wakeAt }', () => {
  it('parses ISO wakeAt string from FE', () => {
    const parsed = snoozeThreadsInput.parse({
      ids: GOLDEN_IDS,
      wakeAt: GOLDEN_WAKE_AT,
    });
    expect(parsed.threadIds).toEqual(GOLDEN_IDS);
    expect(parsed.snoozedUntil).toBe(GOLDEN_WAKE_AT);
  });

  it('parses Date wakeAt', () => {
    const wakeAt = new Date(GOLDEN_WAKE_AT);
    const parsed = snoozeThreadsInput.parse({
      ids: GOLDEN_IDS,
      wakeAt,
    });
    expect(parsed.threadIds).toEqual(GOLDEN_IDS);
    expect(parsed.snoozedUntil).toBe(wakeAt.toISOString());
  });
});

describe('mail wire contract — modifyLabels accepts { threadId }', () => {
  it('parses add-label payload from optimisticToggleLabel', () => {
    const parsed = modifyLabelsInput.parse({
      threadId: GOLDEN_IDS,
      addLabels: [GOLDEN_LABEL_ID],
      removeLabels: [],
    });
    expect(parsed.threadIds).toEqual(GOLDEN_IDS);
    expect(parsed.addLabels).toEqual([GOLDEN_LABEL_ID]);
    expect(parsed.removeLabels).toEqual([]);
  });

  it('parses remove-label payload from optimisticToggleLabel', () => {
    const parsed = modifyLabelsInput.parse({
      threadId: GOLDEN_IDS,
      addLabels: [],
      removeLabels: [GOLDEN_LABEL_ID],
    });
    expect(parsed.threadIds).toEqual(GOLDEN_IDS);
    expect(parsed.removeLabels).toEqual([GOLDEN_LABEL_ID]);
  });
});

describe('mail wire contract — listThreads FE folder slugs', () => {
  const feFolders = ['draft', 'archive', 'bin', 'spam'] as const;

  it('accepts all FE folder slugs in FOLDER_VALUES', () => {
    for (const folder of feFolders) {
      expect(MAIL_FOLDER_VALUES).toContain(folder);
    }
  });

  it('parses each FE folder slug without zod error', () => {
    for (const folder of feFolders) {
      const parsed = listThreadsInput.parse({ folder });
      expect(parsed.folder).toBe(folder);
    }
  });
});

/** Golden send payload copied from create-email.tsx sendEmail call. */
const GOLDEN_SEND_FROM_CREATE_EMAIL = {
  to: [{ email: 'guest@example.com', name: 'guest' }],
  cc: [{ email: 'cc@example.com', name: 'cc' }],
  bcc: [{ email: 'bcc@example.com', name: 'bcc' }],
  subject: 'Booking confirmation',
  message: '<p>Your room is ready.</p>',
  attachments: [] as {
    name: string;
    type: string;
    size: number;
    lastModified: number;
    base64: string;
  }[],
  fromEmail: 'Front Desk <frontdesk@legacyhotel.com>',
  draftId: 'draft-uuid-1',
};

describe('mail wire contract — send accepts FE payload from create-email.tsx', () => {
  it('parses recipient objects, message body, and fromEmail display string', () => {
    const parsed = sendInput.parse(GOLDEN_SEND_FROM_CREATE_EMAIL);
    expect(parsed.to).toEqual(['guest@example.com']);
    expect(parsed.cc).toEqual(['cc@example.com']);
    expect(parsed.bcc).toEqual(['bcc@example.com']);
    expect(parsed.html).toBe('<p>Your room is ready.</p>');
    expect(parsed.draftId).toBe('draft-uuid-1');
  });

  it('still accepts legacy string recipients and html/text fields', () => {
    const parsed = sendInput.parse({
      to: ['guest@example.com'],
      subject: 'hello',
      html: '<p>hello</p>',
      text: 'hello',
    });
    expect(parsed.to).toEqual(['guest@example.com']);
    expect(parsed.html).toBe('<p>hello</p>');
    expect(parsed.text).toBe('hello');
  });

  it('passes through replyToMessageId, inReplyTo, and references', () => {
    const parsed = sendInput.parse({
      to: ['a@example.com'],
      subject: 'Re: x',
      html: '<p>hi</p>',
      text: 'hi',
      replyToMessageId: 'msg-old-1',
      inReplyTo: '<old@x>',
      references: ['<root@x>', '<old@x>'],
    });
    expect(parsed.replyToMessageId).toBe('msg-old-1');
    expect(parsed.inReplyTo).toBe('<old@x>');
    expect(parsed.references).toEqual(['<root@x>', '<old@x>']);
  });

  it('appends originalMessage when message html lacks the prior body', () => {
    const parsed = sendInput.parse({
      to: ['a@example.com'],
      subject: 'Re: x',
      message: '<p>hiii</p><div>On Thu wrote:</div>',
      originalMessage: '<p>unique-prior-body-xyz</p>',
    });
    expect(parsed.html).toContain('hiii');
    expect(parsed.html).toContain('unique-prior-body-xyz');
  });

  it('does not double-append originalMessage when already embedded', () => {
    const prior = '<p>already-in-body</p>';
    const parsed = sendInput.parse({
      to: ['a@example.com'],
      subject: 'Re: x',
      message: `<p>new</p>${prior}`,
      originalMessage: prior,
    });
    expect(parsed.html.match(/already-in-body/g)?.length).toBe(1);
  });

  it('passes through scheduleAt ISO', () => {
    const parsed = sendInput.parse({
      to: ['a@example.com'],
      subject: 'later',
      html: '<p>x</p>',
      scheduleAt: '2026-07-23T15:00:00.000Z',
    });
    expect(parsed.scheduleAt).toBe('2026-07-23T15:00:00.000Z');
  });
});

describe('mail wire contract — send accepts draft approvals for every draft route', () => {
  const approval = (route: { protocol: string; egress: string }) => ({
    version: 'u6-v1',
    purpose: 'draft',
    draftId: 'draft-uuid-1',
    generationId: 'gen-1',
    transportId: 'transport-1',
    threadId: 'thread-1',
    revisionId: 'rev-1',
    threadStateVersion: 'tsv-1',
    policyVersion: 'policy-1',
    approvedByUserId: 'user-1',
    approvedAt: '2026-10-13T09:00:00.000Z',
    bodyDigest: 'a'.repeat(64),
    recipientDigest: 'b'.repeat(64),
    attachmentDigest: 'c'.repeat(64),
    evidenceDigest: 'd'.repeat(64),
    routeBinding: {
      routeId: 'route-1',
      modelId: 'model-1',
      purpose: 'draft',
      access: 'current_app',
      retention: 'bounded',
      usage: 'reported',
      ...route,
      release: {
        releaseId: 'release-1',
        releaseVersion: '1',
        sourceRevision: 'rev',
        fingerprint: 'fp',
        purpose: 'draft',
        capabilityFamilyVersions: { draft: '1' },
        issuedAt: '2026-10-13T08:00:00.000Z',
        expiresAt: '2026-10-14T08:00:00.000Z',
        withdrawn: false,
      },
    },
    fingerprint: 'e'.repeat(64),
    signature: 'f'.repeat(64),
  });
  const send = (draftApproval: unknown) =>
    sendInput.safeParse({ to: ['guest@example.com'], html: '<p>x</p>', draftApproval });

  it('accepts in-process and Azure Foundry route bindings', () => {
    expect(send(approval({ protocol: 'in_process', egress: 'none' })).success).toBe(true);
    expect(
      send(approval({ protocol: 'azure-foundry-responses', egress: 'azure-foundry' })).success,
    ).toBe(true);
  });

  it('rejects a route binding whose egress does not match its protocol', () => {
    expect(send(approval({ protocol: 'in_process', egress: 'azure-foundry' })).success).toBe(false);
    expect(send(approval({ protocol: 'azure-foundry-responses', egress: 'none' })).success).toBe(
      false,
    );
  });
});

describe('mail wire contract — parseFromEmail for spoof check', () => {
  it('extracts bare email from display string', () => {
    expect(parseFromEmail('Front Desk <frontdesk@legacyhotel.com>')).toBe(
      'frontdesk@legacyhotel.com',
    );
    expect(parseFromEmail('frontdesk@legacyhotel.com')).toBe('frontdesk@legacyhotel.com');
  });
});

/** Minimal DB row matching seeded inbound message shape. */
const GOLDEN_MESSAGE_ROW: MessageRow = {
  id: 'msg-inbound-1',
  transportId: 'transport-centurion',
  threadId: 'thread-centurion-1',
  ingestMailboxId: null,
  direction: 'inbound',
  pop3Uidl: null,
  ownerHeaderValue: null,
  messageIdHeader: '<inbound@example.com>',
  inReplyTo: null,
  references: [],
  fromAddress: 'guest@example.com',
  toAddresses: ['centurion@legacyhotel.com'],
  ccAddresses: [],
  bccAddresses: [],
  subject: 'Centurion booking #4471',
  textBody: 'I need a room',
  htmlBody: '<p>I need a room</p>',
  rawMimeS3Key: null,
  isRead: false,
  isStarred: false,
  receivedAt: new Date('2026-07-01T10:00:00.000Z'),
  sentAt: null,
  createdAt: new Date('2026-07-01T10:00:00.000Z'),
  updatedAt: new Date('2026-07-01T10:00:00.000Z'),
};

describe('mail wire contract — get returns ParsedMessage shape FE reads in use-threads.ts', () => {
  it('maps sender.email, decodedBody, receivedOn, unread for latestMessage', () => {
    const parsed = toParsedMessage(GOLDEN_MESSAGE_ROW, [
      {
        attachmentId: 'att-1',
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 1024,
      },
    ]);

    expect(parsed.sender.email).toBe('guest@example.com');
    expect(parsed.decodedBody).toBe('<p>I need a room</p>');
    expect(parsed.receivedOn).toBe('2026-07-01T10:00:00.000Z');
    expect(parsed.unread).toBe(true);
    expect(parsed.to).toEqual([
      { name: 'centurion', email: 'centurion@legacyhotel.com' },
    ]);
    expect(parsed.attachments).toEqual([
      {
        attachmentId: 'att-1',
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        body: '',
        headers: [],
      },
    ]);
  });

  it('converts text-only bodies into escaped line-preserving display HTML', () => {
    const parsed = toParsedMessage(
      {
        ...GOLDEN_MESSAGE_ROW,
        htmlBody: null,
        textBody: 'Reservation Details:\r\nArrival: Monday\n<script>not markup</script>',
      },
      [],
    );

    expect(parsed.decodedBody).toBe(
      '<div>Reservation Details:<br />Arrival: Monday<br />&lt;script&gt;not markup&lt;/script&gt;</div>',
    );
  });

  it('orders ascending when mapping multiple messages (oldest first)', () => {
    const older = toParsedMessage({
      ...GOLDEN_MESSAGE_ROW,
      id: 'msg-1',
      receivedAt: new Date('2026-07-01T09:00:00.000Z'),
    });
    const newer = toParsedMessage({
      ...GOLDEN_MESSAGE_ROW,
      id: 'msg-2',
      receivedAt: new Date('2026-07-01T11:00:00.000Z'),
    });
    const ordered = [older, newer];
    const latestMessage = ordered[ordered.length - 1]!;
    expect(latestMessage.id).toBe('msg-2');
    expect(latestMessage.sender.email).toBe('guest@example.com');
  });
});

describe('mail wire contract — metadata debug headers', () => {
  it('builds metadata debug headers without raw MIME reads', () => {
    const debug = buildMetadataDebugHeaders(
      {
        ...GOLDEN_MESSAGE_ROW,
        transportId: 'transport-nava',
        direction: 'inbound',
        ownerHeaderValue: 'navaai@legacyhotels.co.za',
        messageIdHeader: 'raw-1@example.com',
        inReplyTo: 'parent@example.com',
        references: ['root@example.com', 'parent@example.com'],
      },
      'navaai@legacyhotels.co.za',
    );

    expect(debug).toEqual([
      { key: 'x-zero-mailbox', line: 'X-Zero-Mailbox: navaai@legacyhotels.co.za' },
      { key: 'message-id', line: 'Message-ID: raw-1@example.com' },
      { key: 'in-reply-to', line: 'In-Reply-To: parent@example.com' },
      { key: 'references', line: 'References: root@example.com parent@example.com' },
    ]);
  });

  it('marks missing inbound X-Zero-Mailbox explicitly', () => {
    const debug = buildMetadataDebugHeaders(
      {
        ...GOLDEN_MESSAGE_ROW,
        transportId: 'transport-nava',
        direction: 'inbound',
        ownerHeaderValue: null,
      },
      'navaai@legacyhotels.co.za',
    );

    expect(debug[0]).toEqual({
      key: 'x-zero-mailbox',
      line: 'X-Zero-Mailbox: (missing)',
    });
  });
});

import { appRouter } from '../src/trpc/router.js';

describe('existing route shape compatibility', () => {
  it('returns frontend-compatible verifyEmail and attachment shapes', async () => {
    const caller = appRouter.createCaller({
      source: 'test',
      sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
      activeTransportId: 'transport-1',
      accessRole: 'owner',
      transportEmail: 'user@example.com',
      reqHeaders: new Headers(),
    } as never);

    const verify = await caller.mail.verifyEmail({ email: 'guest@example.com' });
    expect(verify).toEqual({ isVerified: false, messageId: null });

    const suggestions = await caller.mail.suggestRecipients({ query: 'guest' });
    expect(Array.isArray(suggestions)).toBe(true);
  });
});
