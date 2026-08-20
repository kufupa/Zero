import { adjudicateCenturionThreadState } from '../../src/ops/centurion-thread-adjudication.js';
import {
  canonicalCorpora,
  fixtureMessage,
  THREAD_ADJUDICATION_ROSTER,
} from './centurion-thread-adjudication.js';

export const THREAD_REPORTS_VERSIONS = {
  identityRulesVersion: 'identity-rules-v1',
  classifierVersion: 'deterministic-classifier-v1',
  metricDefinitionVersion: 'metric-definition-v2',
} as const;

export const THREAD_REPORTS_GENERATED_AT = '2026-08-10T00:00:00.000Z';

export const RAW_REPORT_SENTINELS = {
  threadId: 'synthetic-private-thread-sentinel',
  subject: 'SYNTHETIC_PRIVATE_SUBJECT|#',
  address: 'private-sentinel@fixture.invalid',
  body:
    'Could you please confirm availability for one room from 10 May 2026 to 12 May 2026? SYNTHETIC_PRIVATE_BODY.',
  attachment: 'SYNTHETIC_PRIVATE_ATTACHMENT_NAME.pdf',
  messageId: '<synthetic-private-message-id@fixture.invalid>',
  path: 'C:\\synthetic-private\\private-source-path.eml',
} as const;

export function createThreadReportsFixture() {
  const corpora = canonicalCorpora([
    fixtureMessage({
      id: 'responded-fast-request',
      threadId: 'responded-fast-thread',
      createdAt: '2026-08-01T08:00:00.000Z',
      receivedAt: '2026-08-01T08:00:00.000Z',
      subject: 'Synthetic fast response',
      textBody:
        'Could you please confirm availability for one room from 10 May 2026 to 12 May 2026?',
    }),
    fixtureMessage({
      id: 'responded-fast-reply',
      threadId: 'responded-fast-thread',
      direction: 'outbound',
      createdAt: '2026-08-01T09:00:00.000Z',
      sentAt: '2026-08-01T09:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['guest-fast@fixture.invalid'],
      subject: 'Synthetic fast response',
      textBody: 'Synthetic staff response.',
    }),
    fixtureMessage({
      id: 'responded-slow-request',
      threadId: 'responded-slow-thread',
      createdAt: '2026-08-01T10:00:00.000Z',
      receivedAt: '2026-08-01T10:00:00.000Z',
      subject: 'Synthetic slow response',
      textBody:
        'Could you please confirm availability for one room from 14 May 2026 to 16 May 2026?',
    }),
    fixtureMessage({
      id: 'responded-slow-reply',
      threadId: 'responded-slow-thread',
      direction: 'outbound',
      createdAt: '2026-08-01T13:00:00.000Z',
      sentAt: '2026-08-01T13:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['guest-slow@fixture.invalid'],
      subject: 'Synthetic slow response',
      textBody: 'Synthetic delayed staff response.',
    }),
    fixtureMessage({
      id: 'unresponded-request',
      threadId: RAW_REPORT_SENTINELS.threadId,
      createdAt: '2026-08-01T14:00:00.000Z',
      receivedAt: '2026-08-01T14:00:00.000Z',
      from: RAW_REPORT_SENTINELS.address,
      subject: RAW_REPORT_SENTINELS.subject,
      textBody: RAW_REPORT_SENTINELS.body,
      htmlBody: `<p>${RAW_REPORT_SENTINELS.attachment} ${RAW_REPORT_SENTINELS.path}</p>`,
      messageIdHeader: RAW_REPORT_SENTINELS.messageId,
    }),
    fixtureMessage({
      id: 'quote-offer',
      threadId: 'booking-instruction-thread',
      direction: 'outbound',
      createdAt: '2026-08-01T15:00:00.000Z',
      sentAt: '2026-08-01T15:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['guest-booking@fixture.invalid'],
      subject: 'Synthetic quotation',
      textBody: 'Quotation for a synthetic stay.',
      messageIdHeader: '<quote-offer@fixture.invalid>',
    }),
    fixtureMessage({
      id: 'booking-instruction',
      threadId: 'booking-instruction-thread',
      createdAt: '2026-08-01T16:00:00.000Z',
      receivedAt: '2026-08-01T16:00:00.000Z',
      from: 'guest-booking@fixture.invalid',
      subject: 'Synthetic quotation',
      textBody: 'Please book the quoted room for us.',
      inReplyTo: 'quote-offer@fixture.invalid',
      references: ['quote-offer@fixture.invalid'],
    }),
    fixtureMessage({
      id: 'automatic-acknowledgement',
      threadId: 'automatic-acknowledgement-thread',
      createdAt: '2026-08-01T17:00:00.000Z',
      receivedAt: '2026-08-01T17:00:00.000Z',
      subject: 'Automatic acknowledgement',
      textBody: 'Automatic reply: synthetic recipient is away.',
    }),
    fixtureMessage({
      id: 'internal-handoff',
      threadId: 'internal-handoff-thread',
      direction: 'outbound',
      createdAt: '2026-08-01T18:00:00.000Z',
      sentAt: '2026-08-01T18:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['team@fixture.test'],
      subject: 'Synthetic internal handoff',
      textBody: 'Please take this synthetic follow-up.',
    }),
    fixtureMessage({
      id: 'late-duplicate-first',
      threadId: 'late-duplicate-thread',
      createdAt: '2026-08-01T19:00:00.000Z',
      receivedAt: '2026-08-01T19:00:00.000Z',
      subject: 'Synthetic late duplicate',
      textBody:
        'Could you please confirm availability for one room from 20 May 2026 to 22 May 2026?',
    }),
    fixtureMessage({
      id: 'late-duplicate-second',
      threadId: 'late-duplicate-thread',
      createdAt: '2026-08-01T19:30:00.000Z',
      receivedAt: '2026-08-01T19:30:00.000Z',
      subject: 'Synthetic late duplicate',
      textBody:
        'Could you please confirm availability for one room from 20 May 2026 to 22 May 2026?',
    }),
    fixtureMessage({
      id: 'nested-quote-offer',
      threadId: 'nested-quote-thread',
      direction: 'outbound',
      createdAt: '2026-08-01T20:00:00.000Z',
      sentAt: '2026-08-01T20:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['guest-nested@fixture.invalid'],
      subject: 'Synthetic nested quotation',
      textBody: 'Quotation for nested synthetic stay.',
      messageIdHeader: '<nested-quote-offer@fixture.invalid>',
    }),
    fixtureMessage({
      id: 'nested-quote-acceptance',
      threadId: 'nested-quote-thread',
      createdAt: '2026-08-01T21:00:00.000Z',
      receivedAt: '2026-08-01T21:00:00.000Z',
      from: 'guest-nested@fixture.invalid',
      subject: 'Synthetic nested quotation',
      textBody: [
        'Yes, please proceed with the quotation.',
        'On 2026-08-01, Internal <internal@fixture.test> wrote:',
        '> Quotation for nested synthetic stay.',
        '> On 2026-07-31, Guest <guest-nested@fixture.invalid> wrote:',
        '>> Earlier synthetic request.',
      ].join('\n'),
      inReplyTo: 'nested-quote-offer@fixture.invalid',
      references: ['nested-quote-offer@fixture.invalid'],
    }),
    fixtureMessage({
      id: 'ambiguous-correlation-staff',
      threadId: 'ambiguous-correlation-thread',
      direction: 'outbound',
      createdAt: '2026-08-01T22:00:00.000Z',
      sentAt: '2026-08-01T22:00:00.000Z',
      from: 'internal@fixture.test',
      to: ['guest-ambiguous@fixture.invalid'],
      subject: 'Synthetic ambiguous correlation',
      textBody: 'We received your synthetic message.',
    }),
    fixtureMessage({
      id: 'ambiguous-correlation-external',
      threadId: 'ambiguous-correlation-thread',
      createdAt: '2026-08-01T23:00:00.000Z',
      receivedAt: '2026-08-01T23:00:00.000Z',
      from: 'guest-ambiguous@fixture.invalid',
      subject: 'Synthetic ambiguous correlation',
      textBody: 'Please proceed with the quote.',
    }),
  ]);
  const adjudication = adjudicateCenturionThreadState({
    roster: THREAD_ADJUDICATION_ROSTER,
    corpora,
    ...THREAD_REPORTS_VERSIONS,
  });

  return {
    corpora,
    adjudication,
    roster: THREAD_ADJUDICATION_ROSTER,
    versions: THREAD_REPORTS_VERSIONS,
    generatedAt: THREAD_REPORTS_GENERATED_AT,
  };
}

export function deterministicReportReferenceFactory(seed: string) {
  let index = 0;
  return (kind: 'run' | 'case' | 'message' | 'thread') => {
    index += 1;
    const token = `${seed}${index.toString(16).padStart(2, '0')}`
      .repeat(32)
      .slice(0, 64);
    return `${kind}_${token}`;
  };
}
