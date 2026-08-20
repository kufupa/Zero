import {
  createCenturionThreadStateSourceManifest,
  parseCenturionThreadStateCorpus,
} from '../../src/ops/centurion-thread-state-corpus.js';

type FixtureMessageOptions = {
  id: string;
  threadId?: string;
  transportId?: string;
  direction?: 'inbound' | 'outbound';
  createdAt?: string;
  sentAt?: string | null;
  receivedAt?: string | null;
  from?: string;
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject?: string;
  textBody?: string | null;
  htmlBody?: string | null;
  messageIdHeader?: string | null;
  inReplyTo?: string | null;
  references?: readonly string[];
};

export const THREAD_ADJUDICATION_ROSTER = {
  schemaVersion: 'centurion_thread_intelligence_roster_v1',
  identities: ['internal@fixture.test', 'team@fixture.test'],
  authorizedTransportIds: ['transport-a'],
} as const;

export function fixtureMessage(options: FixtureMessageOptions) {
  return {
    messageId: options.id,
    threadId: options.threadId ?? options.id,
    transportId: options.transportId ?? 'transport-a',
    direction: options.direction ?? 'inbound',
    createdAt: options.createdAt ?? '2026-08-01T09:00:00.000Z',
    sentAt: options.sentAt ?? null,
    receivedAt:
      options.receivedAt ??
      (options.direction === 'outbound' ? null : '2026-08-01T09:00:00.000Z'),
    fromAddress: options.from ?? 'guest@fixture.test',
    toAddresses: [...(options.to ?? ['internal@fixture.test'])],
    ccAddresses: [...(options.cc ?? [])],
    bccAddresses: [...(options.bcc ?? [])],
    subject: options.subject ?? `Fixture ${options.id}`,
    textBody: options.textBody ?? null,
    htmlBody: options.htmlBody ?? null,
    messageIdHeader: options.messageIdHeader ?? null,
    inReplyTo: options.inReplyTo ?? null,
    references: options.references ? [...options.references] : [],
  };
}

export function canonicalCorpora(
  messages: readonly ReturnType<typeof fixtureMessage>[],
) {
  const byTransport = new Map<
    string,
    ReturnType<typeof fixtureMessage>[]
  >();
  for (const message of messages) {
    const current = byTransport.get(message.transportId) ?? [];
    current.push(message);
    byTransport.set(message.transportId, current);
  }
  return [...byTransport.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([transportId, transportMessages]) =>
      parseCenturionThreadStateCorpus({
        source: {
          schemaVersion: 'centurion_message_projection_v1',
          transportId,
          eventCutoff: '2026-08-31T00:00:00.000Z',
          ingestCutoff: '2026-08-31T00:00:00.000Z',
        },
        manifest: createCenturionThreadStateSourceManifest(transportMessages),
        messages: transportMessages,
      }),
    );
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
