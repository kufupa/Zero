import {
  PREVIEW_ONLY_MESSAGE,
  activeEmailFromMessage,
  buildPreviewBridge,
  isInboundMessage,
  latestInboundMessage,
  selectPreviewMessage,
} from '@/lib/workstation/web-pane-bridge';
import { WorkstationEmailPayloadSchema } from '@/lib/workstation/bridge-protocol';
import type { IGetThreadResponse } from '@zero/server/driver/types';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createSerializer, parseAsString } from 'nuqs';

type Message = IGetThreadResponse['messages'][number];

const MAILBOX = 'centurion@legacyhotels.co.za';
const TRANSPORT = 'transport-centurion';

/** A stored message as mail.get returns it. Defaults describe a guest's inbound email. */
function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    title: 'Quote request',
    subject: 'Quote request',
    tags: [],
    sender: { name: 'Guest One', email: 'guest1@example.com' },
    to: [{ email: MAILBOX }],
    cc: null,
    bcc: null,
    tls: true,
    receivedOn: '2026-10-08T09:00:00.000Z',
    unread: false,
    body: 'Please quote 2 rooms, 12 to 14 November.',
    processedHtml: '<p>Please quote 2 rooms, 12 to 14 November.</p>',
    blobUrl: '',
    messageId: '<guest-1@example.com>',
    threadId: 'thread-1',
    isDraft: false,
    direction: 'inbound',
    ...overrides,
  } as Message;
}

const staffReply = (overrides: Partial<Message> & { id: string }) =>
  message({
    sender: { name: 'Centurion', email: MAILBOX },
    direction: 'outbound',
    messageId: '<reply-1@legacyhotels.co.za>',
    receivedOn: '2026-10-08T11:00:00.000Z',
    ...overrides,
  });

describe('latest inbound selection', () => {
  it('selects the latest inbound message, not the newer reply from the mailbox', () => {
    const messages = [
      message({ id: 'in-1', receivedOn: '2026-10-08T09:00:00.000Z' }),
      message({
        id: 'in-2',
        receivedOn: '2026-10-08T10:00:00.000Z',
        messageId: '<guest-2@example.com>',
      }),
      staffReply({ id: 'out-1' }),
    ];
    const selection = selectPreviewMessage(messages, MAILBOX, TRANSPORT);
    expect(selection).toMatchObject({ status: 'ready', email: { entryId: 'in-2' } });
    expect(latestInboundMessage(messages, MAILBOX)?.id).toBe('in-2');
  });

  it('keeps a workflow preview bound to its listed thread when a linked thread is newer', () => {
    const selection = selectPreviewMessage(
      [
        message({
          id: 'quotes-source-message',
          threadId: 'quotes-thread',
          receivedOn: '2026-10-08T09:00:00.000Z',
          messageId: '<quotes-source@example.com>',
        }),
        message({
          id: 'amendments-source-message',
          threadId: 'amendments-thread',
          receivedOn: '2026-10-08T10:00:00.000Z',
          messageId: '<amendments-source@example.com>',
        }),
      ],
      MAILBOX,
      TRANSPORT,
      'quotes-thread',
    );

    expect(selection).toMatchObject({
      status: 'ready',
      email: {
        entryId: 'quotes-source-message',
        internetMessageId: '<quotes-source@example.com>',
      },
    });
  });

  it('trusts the stored direction over the sender address', () => {
    const outboundFromGuest = message({ id: 'odd', direction: 'outbound' });
    expect(isInboundMessage(outboundFromGuest, MAILBOX)).toBe(false);
    const inboundFromMailbox = message({
      id: 'fwd',
      direction: 'inbound',
      sender: { email: MAILBOX },
    });
    expect(isInboundMessage(inboundFromMailbox, MAILBOX)).toBe(true);
  });

  it('falls back to the sender address when a payload carries no direction', () => {
    const { direction: _ignored, ...withoutDirection } = message({ id: 'in-1' });
    const messages = [
      withoutDirection as Message,
      { ...staffReply({ id: 'out-1' }), direction: undefined } as Message,
    ];
    expect(latestInboundMessage(messages, MAILBOX)?.id).toBe('in-1');
  });

  it('does not guess a direction when the mailbox address is unknown', () => {
    const { direction: _ignored, ...withoutDirection } = message({ id: 'in-1' });
    expect(isInboundMessage(withoutDirection as Message, '')).toBe(false);
    expect(selectPreviewMessage([withoutDirection as Message], '', TRANSPORT)).toEqual({
      status: 'unsynced',
      reason: 'no_inbound',
    });
  });

  it('skips drafts', () => {
    const messages = [
      message({ id: 'in-1', receivedOn: '2026-10-08T09:00:00.000Z' }),
      message({ id: 'draft', receivedOn: '2026-10-08T12:00:00.000Z', isDraft: true }),
    ];
    expect(latestInboundMessage(messages, MAILBOX)?.id).toBe('in-1');
  });

  it('reports no inbound message when the thread holds only mailbox replies', () => {
    expect(selectPreviewMessage([staffReply({ id: 'out-1' })], MAILBOX, TRANSPORT)).toEqual({
      status: 'unsynced',
      reason: 'no_inbound',
    });
  });
});

describe('exact source message selection', () => {
  it('round-trips an explicit missing source through the real URL serializer', () => {
    const serialize = createSerializer({ threadId: parseAsString, sourceMessageId: parseAsString });
    const query = serialize({ threadId: 'thread-1', sourceMessageId: '' });
    const params = new URLSearchParams(query);
    expect(params.has('sourceMessageId')).toBe(true);
    const source = params.get('sourceMessageId');
    expect(source).toBe('');
    expect(selectPreviewMessage([message({ id: 'newer' })], MAILBOX, TRANSPORT, 'thread-1', source ?? undefined))
      .toEqual({ status: 'unsynced', reason: 'source_message_unavailable' });
  });

  const messages = [
    message({ id: 'source-a', threadId: 'thread-1', messageId: '<a@example.com>', receivedOn: '2026-10-08T09:00:00Z' }),
    message({ id: 'source-b', threadId: 'thread-1', messageId: '<b@example.com>', receivedOn: '2026-10-08T10:00:00Z' }),
  ];

  it('selects A/B/A by stored message id instead of the newest message', () => {
    for (const id of ['source-a', 'source-b', 'source-a']) {
      expect(selectPreviewMessage(messages, MAILBOX, TRANSPORT, 'thread-1', id))
        .toMatchObject({ status: 'ready', email: { entryId: id } });
    }
  });

  it('refuses missing, blank, wrong-thread, outbound, draft and duplicate source ids', () => {
    for (const [rows, id] of [
      [messages, 'absent'], [messages, ''], [[message({ id: '' })], ''],
      [[message({ id: 'other', threadId: 'other-thread' })], 'other'],
      [[staffReply({ id: 'outbound' })], 'outbound'],
      [[message({ id: 'draft', isDraft: true })], 'draft'],
      [[message({ id: 'duplicate' }), message({ id: 'duplicate' })], 'duplicate'],
    ] as Array<[Message[], string]>) {
      expect(selectPreviewMessage(rows, MAILBOX, TRANSPORT, 'thread-1', id))
        .toEqual({ status: 'unsynced', reason: 'source_message_unavailable' });
    }
  });

  it.each(['inbound', 'outbound'] as const)(
    'opens the exact self-addressed pre-stay source with %s ingest direction',
    (direction) => {
      const preStay = message({
        id: 'pre-stay', direction, sender: { email: MAILBOX.toUpperCase() },
        to: [{ email: MAILBOX }], subject: 'Pre Stay : Property HRDAV Confirmation No 57291630 Guest',
        messageId: '<pre-stay@example.com>',
      });
      const newer = message({ id: 'newer', receivedOn: '2026-10-09T09:00:00Z' });
      expect(selectPreviewMessage([preStay, newer], MAILBOX, TRANSPORT, 'thread-1', 'pre-stay'))
        .toMatchObject({ status: 'ready', email: { entryId: 'pre-stay', internetMessageId: '<pre-stay@example.com>' } });
    },
  );

  it('only admits an exact outbound pre-stay when sender, recipient, subject and confirmation agree', () => {
    const valid = staffReply({
      id: 'self', to: [{ email: MAILBOX }],
      subject: 'Pre Stay : Property HRDAV Confirmation No 57291630 Guest',
    });
    const cases: Array<[Message, string]> = [
      [{ ...valid, sender: { email: 'other@example.com' } }, MAILBOX],
      [{ ...valid, to: [{ email: 'other@example.com' }] }, MAILBOX],
      [{ ...valid, subject: 'Reservation Confirmation No 57291630 Guest' }, MAILBOX],
      [{ ...valid, subject: 'Pre Stay : Property HRDAV Guest' }, MAILBOX],
      [{ ...valid, isDraft: true }, MAILBOX],
      [valid, ''],
    ];
    for (const [row, mailbox] of cases) {
      expect(selectPreviewMessage([row], mailbox, TRANSPORT, 'thread-1', 'self'))
        .toEqual({ status: 'unsynced', reason: 'source_message_unavailable' });
    }
    expect(selectPreviewMessage([valid, { ...valid, isDraft: true }], MAILBOX, TRANSPORT, 'thread-1', 'self'))
      .toEqual({ status: 'unsynced', reason: 'source_message_unavailable' });
    expect(selectPreviewMessage([valid], MAILBOX, TRANSPORT))
      .toEqual({ status: 'unsynced', reason: 'no_inbound' });
  });

  it('refuses an exact source without an internet Message-ID', () => {
    expect(selectPreviewMessage([message({ id: 'source-a', messageId: undefined })], MAILBOX, TRANSPORT, 'thread-1', 'source-a'))
      .toEqual({ status: 'unsynced', reason: 'no_message_id' });
  });
});

describe('mapping a stored message to the pane payload', () => {
  it('maps the DB message onto the pane payload and validates against the bridge schema', () => {
    const email = activeEmailFromMessage(
      message({
        id: 'msg-db-7',
        subject: 'Rooms 12-14 Nov',
        sender: { name: 'Ana Guest', email: 'ana@example.com' },
        to: [{ email: MAILBOX }, { email: 'frontdesk@legacyhotels.co.za' }],
        cc: [{ email: 'ops@example.com' }],
        messageId: '  <guest-7@example.com>  ',
        receivedOn: '2026-10-08T09:30:00.000Z',
      }),
      TRANSPORT,
    );
    expect(email).toEqual({
      entryId: 'msg-db-7',
      storeId: TRANSPORT,
      folderEntryId: 'thread',
      subject: 'Rooms 12-14 Nov',
      senderEmail: 'ana@example.com',
      senderName: 'Ana Guest',
      to: `${MAILBOX}; frontdesk@legacyhotels.co.za`,
      cc: 'ops@example.com',
      receivedTime: '2026-10-08T09:30:00.000Z',
      bodyText: 'Please quote 2 rooms, 12 to 14 November.',
      bodyHtml: '<p>Please quote 2 rooms, 12 to 14 November.</p>',
      internetMessageId: '<guest-7@example.com>',
    });
    expect(WorkstationEmailPayloadSchema.safeParse(email).success).toBe(true);
  });

  it('keeps the sender address as the name when the guest has none', () => {
    const email = activeEmailFromMessage(
      message({ id: 'm', sender: { email: 'anon@example.com' } }),
      TRANSPORT,
    );
    expect(email?.senderName).toBe('anon@example.com');
    expect(email && 'cc' in email).toBe(false);
  });

  it('reports unsynced when the latest guest email has no Message-ID', () => {
    const missing = [message({ id: 'no-id', messageId: undefined })];
    expect(selectPreviewMessage(missing, MAILBOX, TRANSPORT)).toEqual({
      status: 'unsynced',
      reason: 'no_message_id',
    });
    const blank = [message({ id: 'blank-id', messageId: '   ' })];
    expect(selectPreviewMessage(blank, MAILBOX, TRANSPORT)).toEqual({
      status: 'unsynced',
      reason: 'no_message_id',
    });
  });
});

describe('buildPreviewBridge', () => {
  const email = activeEmailFromMessage(message({ id: 'msg-1' }), TRANSPORT);

  it('reports a connected, paired, read-only bridge with no capabilities', () => {
    const bridge = buildPreviewBridge(email);
    expect(bridge).toMatchObject({
      isConnected: true,
      authorizationUnavailable: false,
      selectionOutsideMailbox: false,
      consentInProgress: false,
      updateRequired: false,
      requiresRelogin: false,
      capabilities: null,
      activeEmail: email,
      workstationInfo: { bridgeProtocolVersion: 4, paired: true, deviceId: null },
    });
  });

  it('answers only the read actions', () => {
    const bridge = buildPreviewBridge(email);
    expect(bridge.supportsAction('PING')).toBe(true);
    expect(bridge.supportsAction('GET_ACTIVE_EMAIL')).toBe(true);
    for (const action of [
      'CREATE_REPLY_DRAFT',
      'ADD_ATTACHMENT_TO_DRAFT',
      'UPDATE_DRAFT',
      'MOVE_EMAIL',
      'GET_EMAIL_BY_ENTRY_ID',
    ] as const) {
      expect(bridge.supportsAction(action)).toBe(false);
    }
  });

  it('answers PING and GET_ACTIVE_EMAIL', async () => {
    const bridge = buildPreviewBridge(email);
    await expect(bridge.sendCommand('PING', {})).resolves.toMatchObject({
      bridgeProtocolVersion: 4,
    });
    await expect(bridge.sendCommand('GET_ACTIVE_EMAIL', {})).resolves.toEqual(email);
    await expect(buildPreviewBridge(null).sendCommand('GET_ACTIVE_EMAIL', {})).resolves.toBeNull();
  });

  it.each([
    'CREATE_REPLY_DRAFT',
    'ADD_ATTACHMENT_TO_DRAFT',
    'UPDATE_DRAFT',
    'MOVE_EMAIL',
    'READ_ATTACHMENT_BASE64',
  ] as const)('rejects %s with the preview-only message', async (action) => {
    const bridge = buildPreviewBridge(email);
    await expect(bridge.sendCommand(action, { operationId: 'op-1' })).rejects.toThrow(
      PREVIEW_ONLY_MESSAGE,
    );
  });

  it('resolves the no-op controls without reaching a native bridge', async () => {
    const bridge = buildPreviewBridge(email);
    await expect(bridge.pairDevice()).resolves.toBeUndefined();
    expect(bridge.refreshAuthorization()).toBeUndefined();
    await expect(
      bridge.activateMailboxSync({
        version: 1,
        sourceId: 's',
        storeId: 'st',
        rootEntryId: 'r',
        activationTicket: 't',
        idempotencyKey: 'k',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('source guard', () => {
  it('never reaches the Outlook ticket path', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../lib/workstation/web-pane-bridge.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/bridgeTicket/);
  });
});
