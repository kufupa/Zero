export const THREAD_STATE_SOURCE = {
  schemaVersion: 'centurion_message_projection_v1',
  transportId: 'transport-centurion',
  eventCutoff: '2026-08-02T00:00:00.000Z',
  ingestCutoff: '2026-08-02T00:00:00.000Z',
} as const;

export const threadStateMessages = [
  {
    messageId: 'message-2',
    threadId: 'thread-1',
    transportId: 'transport-centurion',
    direction: 'inbound',
    createdAt: '2026-08-01T10:00:00.000Z',
    sentAt: null,
    receivedAt: '2026-08-01T09:00:00.000Z',
    fromAddress: ' Sender@Example.test ',
    toAddresses: ['Recipient@Example.test', 'recipient@example.test'],
    ccAddresses: [],
    bccAddresses: [],
    subject: '  Status\u00a0update  ',
    textBody: '\ufefffirst line\r\nsecond line\r\n',
    htmlBody: ' <p>first line</p>\r\n',
    messageIdHeader: '<message-2@fixture.test>',
    inReplyTo: '<root-1@fixture.test>',
    references: ['<root-1@fixture.test>'],
  },
  {
    messageId: 'message-1',
    threadId: 'thread-1',
    transportId: 'transport-centurion',
    direction: 'outbound',
    createdAt: '2026-08-01T08:00:00.000Z',
    sentAt: '2026-08-01T08:30:00.000Z',
    receivedAt: null,
    fromAddress: 'recipient@example.test',
    toAddresses: ['sender@example.test'],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'Initial update',
    textBody: 'first message',
    htmlBody: null,
    messageIdHeader: '<root-1@fixture.test>',
    inReplyTo: null,
    references: [],
  },
] as const;

export const malformedBlockFixture = {
  markdownBlock: '---\nlegacy dump\n---',
};
