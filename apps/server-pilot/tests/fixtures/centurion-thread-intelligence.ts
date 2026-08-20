import {
  createCenturionThreadStateSourceManifest,
  parseCenturionThreadStateCorpus,
} from '../../src/ops/centurion-thread-state-corpus.js';

type SyntheticMessageOptions = {
  id: string;
  threadId?: string;
  transportId?: string;
  direction?: 'inbound' | 'outbound';
  createdAt?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  textBody?: string | null;
  htmlBody?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
};

function valueOrNull(
  value: string | null | undefined,
  fallback: string | null,
): string | null {
  return value === undefined ? fallback : value;
}

export function syntheticMessage(options: SyntheticMessageOptions) {
  return {
    id: options.id,
    threadId: options.threadId ?? 'thread-a',
    transportId: options.transportId ?? 'transport-a',
    direction: options.direction ?? 'inbound',
    timestamps: {
      createdAt: valueOrNull(options.createdAt, '2026-08-01T09:00:00.000Z'),
      sentAt: valueOrNull(options.sentAt, null),
      receivedAt: valueOrNull(options.receivedAt, null),
    },
    participants: {
      from: options.from ?? 'external@fixture.test',
      to: options.to ?? ['internal@fixture.test'],
      cc: options.cc ?? [],
      bcc: options.bcc ?? [],
    },
    subject: options.subject ?? 'Synthetic topic',
    textBody: valueOrNull(options.textBody, null),
    htmlBody: valueOrNull(options.htmlBody, null),
    headers: {
      messageId: valueOrNull(options.messageId, null),
      inReplyTo: valueOrNull(options.inReplyTo, null),
      references: options.references ?? [],
    },
  };
}

export function annotation(
  messageId: string,
  intent:
    | 'actionable_request'
    | 'customer_acknowledgement_or_confirmation'
    | 'automated_or_non_actionable'
    | 'staff_response'
    | 'internal_handoff'
    | 'non_actionable'
    | 'ambiguous',
  actionability: 'actionable' | 'non_actionable' | 'ambiguous',
) {
  return { messageId, intent, actionability };
}

export const THREAD_INTELLIGENCE_ROSTER = {
  schemaVersion: 'centurion_thread_intelligence_roster_v1',
  identities: ['internal@fixture.test'],
  authorizedTransportIds: ['transport-a'],
} as const;

export const THREAD_INTELLIGENCE_SOURCE_COVERAGE = {
  schemaVersion: 'centurion_thread_intelligence_source_coverage_v1',
  complete: true,
  authorizedTransportIds: ['transport-a'],
  corpora: [
    {
      schema: 'centurion_thread_state_corpus_v1',
      sourceSchemaVersion: 'centurion_message_projection_v1',
      transportId: 'transport-a',
      corpusSha256: 'a'.repeat(64),
      eventCutoff: '2026-08-02T00:00:00.000Z',
      ingestCutoff: '2026-08-02T00:00:00.000Z',
    },
  ],
} as const;

export const THREAD_INTELLIGENCE_QUOTE_PARSER_COVERAGE = {
  schemaVersion: 'centurion_thread_intelligence_quote_parser_coverage_v1',
  status: 'verified_complete',
  parser: 'english_structural_v1',
} as const;

export function canonicalCorpora(
  messages: readonly ReturnType<typeof syntheticMessage>[],
) {
  const byTransport = new Map<string, ReturnType<typeof syntheticMessage>[]>();
  for (const message of messages) {
    const transportMessages = byTransport.get(message.transportId) ?? [];
    transportMessages.push(message);
    byTransport.set(message.transportId, transportMessages);
  }
  return [...byTransport.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([transportId, transportMessages]) => {
      const source = {
        schemaVersion: 'centurion_message_projection_v1' as const,
        transportId,
        eventCutoff: '2026-08-02T00:00:00.000Z',
        ingestCutoff: '2026-08-02T00:00:00.000Z',
      };
      const rawMessages = transportMessages.map((message) => ({
        messageId: message.id,
        threadId: message.threadId,
        transportId: message.transportId,
        direction: message.direction,
        createdAt: message.timestamps.createdAt,
        sentAt: message.timestamps.sentAt,
        receivedAt: message.timestamps.receivedAt,
        fromAddress: message.participants.from,
        toAddresses: message.participants.to,
        ccAddresses: message.participants.cc,
        bccAddresses: message.participants.bcc,
        subject: message.subject,
        textBody: message.textBody,
        htmlBody: message.htmlBody,
        messageIdHeader: message.headers.messageId,
        inReplyTo: message.headers.inReplyTo,
        references: message.headers.references,
      }));
      return parseCenturionThreadStateCorpus({
        source,
        manifest: createCenturionThreadStateSourceManifest(rawMessages),
        messages: rawMessages,
      });
    });
}

export const quoteOnlyInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'historical-staff',
      threadId: 'prior-thread',
      direction: 'outbound',
      createdAt: '2026-08-01T08:00:00.000Z',
      sentAt: '2026-08-01T08:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['external@fixture.test'],
      messageId: '<staff-prior@fixture.test>',
    }),
    syntheticMessage({
      id: 'quoted-request',
      threadId: 'current-thread',
      createdAt: '2026-08-01T10:00:00.000Z',
      receivedAt: '2026-08-01T10:00:00.000Z',
      textBody: [
        'Request detail.',
        '',
        'On 2026-08-01, Internal <internal@fixture.test> wrote:',
        'From: Internal <internal@fixture.test>',
        'Sent: 2026-08-01T08:00:00.000Z',
        'To: External <external@fixture.test>',
        'Subject: Prior detail',
        'Message-ID: <staff-prior@fixture.test>',
      ].join('\n'),
    }),
  ],
  annotations: [
    annotation('historical-staff', 'staff_response', 'non_actionable'),
    annotation('quoted-request', 'actionable_request', 'actionable'),
  ],
} as const;

export const openRequestInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'open-request',
      createdAt: '2026-08-01T09:00:00.000Z',
      receivedAt: '2026-08-01T09:00:00.000Z',
      messageId: '<open-request@fixture.test>',
    }),
  ],
  annotations: [annotation('open-request', 'actionable_request', 'actionable')],
} as const;

export const automatedInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'automated-turn',
      createdAt: '2026-08-01T09:00:00.000Z',
      receivedAt: '2026-08-01T09:00:00.000Z',
    }),
  ],
  annotations: [
    annotation('automated-turn', 'automated_or_non_actionable', 'non_actionable'),
  ],
} as const;

export const internalHandoffInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'handoff-turn',
      direction: 'outbound',
      createdAt: '2026-08-01T09:00:00.000Z',
      sentAt: '2026-08-01T09:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['other-internal@fixture.test'],
    }),
  ],
  annotations: [annotation('handoff-turn', 'internal_handoff', 'non_actionable')],
} as const;

export const lateResponseInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'late-staff',
      threadId: 'response-thread',
      direction: 'outbound',
      createdAt: '2026-08-01T13:00:00.000Z',
      sentAt: '2026-08-01T10:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['external@fixture.test'],
      messageId: '<staff-late@fixture.test>',
      inReplyTo: 'request-root@fixture.test',
    }),
    syntheticMessage({
      id: 'request-root',
      threadId: 'request-thread',
      createdAt: '2026-08-01T12:00:00.000Z',
      receivedAt: '2026-08-01T09:00:00.000Z',
      messageId: '<request-root@fixture.test>',
    }),
  ],
  annotations: [
    annotation('late-staff', 'staff_response', 'non_actionable'),
    annotation('request-root', 'actionable_request', 'actionable'),
  ],
} as const;

export const duplicateInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'duplicate-turn',
      createdAt: '2026-08-01T09:00:00.000Z',
      receivedAt: '2026-08-01T09:00:00.000Z',
    }),
    syntheticMessage({
      id: 'duplicate-turn',
      createdAt: '2026-08-01T09:01:00.000Z',
      receivedAt: '2026-08-01T09:01:00.000Z',
    }),
  ],
  annotations: [annotation('duplicate-turn', 'actionable_request', 'actionable')],
} as const;

export const nestedQuoteInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'nested-staff',
      threadId: 'nested-history',
      direction: 'outbound',
      createdAt: '2026-08-01T07:00:00.000Z',
      sentAt: '2026-08-01T07:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['external@fixture.test'],
      messageId: '<nested-staff@fixture.test>',
    }),
    syntheticMessage({
      id: 'nested-request',
      threadId: 'nested-current',
      createdAt: '2026-08-01T09:00:00.000Z',
      receivedAt: '2026-08-01T09:00:00.000Z',
      textBody: [
        'Current detail.',
        '',
        'On 2026-08-01, External <external@fixture.test> wrote:',
        '-----Original Message-----',
        'From: Internal <internal@fixture.test>',
        'Sent: 2026-08-01T07:00:00.000Z',
        'To: External <external@fixture.test>',
        'Subject: Earlier detail',
        'Message-ID: <nested-staff@fixture.test>',
      ].join('\n'),
    }),
  ],
  annotations: [
    annotation('nested-staff', 'staff_response', 'non_actionable'),
    annotation('nested-request', 'actionable_request', 'actionable'),
  ],
} as const;

export const ambiguousCorrelationInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'correlation-a',
      threadId: 'correlation-thread-a',
      createdAt: '2026-08-01T09:00:00.000Z',
      receivedAt: '2026-08-01T09:00:00.000Z',
      subject: 'Shared synthetic subject',
    }),
    syntheticMessage({
      id: 'correlation-b',
      threadId: 'correlation-thread-b',
      createdAt: '2026-08-01T10:00:00.000Z',
      receivedAt: '2026-08-01T10:00:00.000Z',
      subject: 'Shared synthetic subject',
    }),
  ],
  annotations: [
    annotation('correlation-a', 'actionable_request', 'actionable'),
    annotation('correlation-b', 'actionable_request', 'actionable'),
  ],
} as const;

export const foreignTransportInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'coverage-request',
      createdAt: '2026-08-01T09:00:00.000Z',
      receivedAt: '2026-08-01T09:00:00.000Z',
    }),
    syntheticMessage({
      id: 'coverage-staff',
      direction: 'outbound',
      transportId: 'transport-b',
      createdAt: '2026-08-01T10:00:00.000Z',
      sentAt: '2026-08-01T10:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['external@fixture.test'],
    }),
  ],
  annotations: [
    annotation('coverage-request', 'actionable_request', 'actionable'),
    annotation('coverage-staff', 'staff_response', 'non_actionable'),
  ],
} as const;

export const missingAnnotationInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'unannotated-turn',
      createdAt: '2026-08-01T09:00:00.000Z',
      receivedAt: '2026-08-01T09:00:00.000Z',
    }),
  ],
  annotations: [],
} as const;

export const directionOnlyInput = {
  roster: THREAD_INTELLIGENCE_ROSTER,
  sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
  messages: [
    syntheticMessage({
      id: 'identity-request',
      createdAt: '2026-08-01T09:00:00.000Z',
      receivedAt: '2026-08-01T09:00:00.000Z',
    }),
    syntheticMessage({
      id: 'identity-mismatch',
      direction: 'outbound',
      createdAt: '2026-08-01T10:00:00.000Z',
      sentAt: '2026-08-01T10:00:00.000Z',
      from: 'not-approved@fixture.test',
      to: ['external@fixture.test'],
    }),
  ],
  annotations: [
    annotation('identity-request', 'actionable_request', 'actionable'),
    annotation('identity-mismatch', 'staff_response', 'non_actionable'),
  ],
} as const;
