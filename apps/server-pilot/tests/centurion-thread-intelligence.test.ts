import { describe, expect, it } from 'vitest';
import {
  ambiguousCorrelationInput,
  annotation,
  automatedInput,
  canonicalCorpora,
  directionOnlyInput,
  duplicateInput,
  foreignTransportInput,
  internalHandoffInput,
  lateResponseInput,
  missingAnnotationInput,
  nestedQuoteInput,
  openRequestInput,
  quoteOnlyInput,
  syntheticMessage,
  THREAD_INTELLIGENCE_ROSTER,
  THREAD_INTELLIGENCE_SOURCE_COVERAGE,
} from './fixtures/centurion-thread-intelligence.js';

async function loadIntelligence() {
  const api = await import('../src/ops/centurion-thread-intelligence.js');
  return {
    ...api,
    analyzeCenturionThreadIntelligence: (input: {
      messages?: readonly ReturnType<typeof syntheticMessage>[];
    }) =>
      api.analyzeCenturionThreadIntelligence(
        input.messages
          ? corpusInput(input as Parameters<typeof corpusInput>[0])
          : input,
      ),
  };
}

function corpusInput<
  T extends {
    roster: object;
    messages: readonly ReturnType<typeof syntheticMessage>[];
    annotations: readonly object[];
  },
>(input: T) {
  const { messages, sourceCoverage: _sourceCoverage, ...rest } = input;
  return {
    ...rest,
    corpora: canonicalCorpora(messages),
    quoteCoverage: messages.map((message) => ({
      messageId: message.id,
      status: 'no_quote' as const,
    })),
  };
}

const coveredInput = corpusInput;

describe('Centurion thread intelligence', () => {
  it('exposes pure graph and state contract', async () => {
    await expect(loadIntelligence()).resolves.toEqual(
      expect.objectContaining({
        CENTURION_THREAD_INTELLIGENCE_SCHEMA: 'centurion_thread_intelligence_v1',
        analyzeCenturionThreadIntelligence: expect.any(Function),
        extractCenturionQuotedEvidence: expect.any(Function),
      }),
    );
  });

  it('keeps quote-only history manual while preserving quote provenance', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(quoteOnlyInput);
    const component = result.components[0];

    expect(result.components).toHaveLength(1);
    expect(component).toMatchObject({
      state: 'needs_manual_adjudication',
      evidenceTier: 'quoted_reply',
      limitation: 'quoted_only_evidence',
      latestExternalActionableTurn: {
        messageId: 'quoted-request',
      },
    });
    expect(component.quotedEvidence).toHaveLength(1);
    expect(component.quotedEvidence[0]).toMatchObject({
      sourceMessageId: 'quoted-request',
      senderRole: 'internal',
      quotedMessageId: 'staff-prior@fixture.test',
      provenance: {
        marker: 'on_wrote',
      },
    });
    expect(component.responseGaps).toEqual([
      expect.objectContaining({
        actionableMessageId: 'quoted-request',
        durationMs: null,
        reason: 'no_persisted_roster_response',
      }),
    ]);
    expect(result.graph.hardEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unique_quoted_message_id',
          sourceMessageId: 'quoted-request',
          targetMessageId: 'historical-staff',
        }),
      ]),
    );
  });

  it('requires structured roster-attributed quote headers before hard joins', async () => {
    const api = await loadIntelligence();
    const fromOnly = api.analyzeCenturionThreadIntelligence({
      roster: THREAD_INTELLIGENCE_ROSTER,
      sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
      messages: [
        syntheticMessage({
          id: 'quote-target',
          threadId: 'quote-target-thread',
          direction: 'outbound',
          createdAt: '2026-08-01T08:00:00.000Z',
          sentAt: '2026-08-01T08:00:00.000Z',
          from: 'internal@fixture.test',
          to: ['external@fixture.test'],
          subject: 'Target subject',
          messageId: '<quote-target@fixture.test>',
        }),
        syntheticMessage({
          id: 'from-only-turn',
          threadId: 'from-only-thread',
          createdAt: '2026-08-01T09:00:00.000Z',
          receivedAt: '2026-08-01T09:00:00.000Z',
          subject: 'Current subject',
          textBody: [
            'From: Internal <internal@fixture.test>',
            'Message-ID: <quote-target@fixture.test>',
          ].join('\n'),
        }),
      ],
      annotations: [
        annotation('quote-target', 'staff_response', 'non_actionable'),
        annotation('from-only-turn', 'actionable_request', 'actionable'),
      ],
    });

    expect(fromOnly.components).toHaveLength(2);
    expect(fromOnly.graph.hardEdges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unique_quoted_message_id' }),
      ]),
    );
    expect(
      fromOnly.components.find((component) =>
        component.chronology.some(
          (turn) => turn.messageId === 'from-only-turn',
        ),
      ),
    ).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'unsupported_quote_like',
      quotedEvidence: [],
    });

    const mismatchedTarget = api.analyzeCenturionThreadIntelligence({
      roster: THREAD_INTELLIGENCE_ROSTER,
      messages: [
        syntheticMessage({
          id: 'mismatched-target',
          threadId: 'mismatched-target-thread',
          createdAt: '2026-08-01T08:00:00.000Z',
          receivedAt: '2026-08-01T08:00:00.000Z',
          from: 'other-external@fixture.test',
          to: ['internal@fixture.test'],
          subject: 'Prior subject',
          messageId: '<mismatched-target@fixture.test>',
        }),
        syntheticMessage({
          id: 'mismatched-quote-turn',
          threadId: 'mismatched-current-thread',
          createdAt: '2026-08-01T09:00:00.000Z',
          receivedAt: '2026-08-01T09:00:00.000Z',
          subject: 'Current subject',
          textBody: [
            'On 2026-08-01, Internal <internal@fixture.test> wrote:',
            'Message-ID: <mismatched-target@fixture.test>',
          ].join('\n'),
        }),
      ],
      annotations: [
        annotation('mismatched-target', 'non_actionable', 'non_actionable'),
        annotation(
          'mismatched-quote-turn',
          'actionable_request',
          'actionable',
        ),
      ],
    });

    expect(mismatchedTarget.components).toHaveLength(2);
    expect(mismatchedTarget.graph.hardEdges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unique_quoted_message_id' }),
      ]),
    );
  });

  it('marks an annotated open request as action required', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(openRequestInput);
    const component = result.components[0];

    expect(component).toMatchObject({
      state: 'action_required',
      evidenceTier: 'no_evidence',
      limitation: 'none',
      coverage: { complete: true },
      actionEvidence: {
        tier: 'persisted_trusted_actionable_external',
        messageId: 'open-request',
        actionRequiredEligible: true,
      },
      responseEvidence: {
        tier: 'no_evidence',
      },
      latestExternalActionableTurn: {
        messageId: 'open-request',
        eventTime: {
          source: 'received_at',
          quality: 'trustworthy',
        },
      },
    });
  });

  it('requires validated canonical corpora and rejects cutoff-violating artifacts', async () => {
    const api = await loadIntelligence();
    const rawApi = await import('../src/ops/centurion-thread-intelligence.js');
    const message = syntheticMessage({
      id: 'provenance-action',
      receivedAt: '2026-08-01T09:00:00.000Z',
    });
    const corpora = canonicalCorpora([message]);
    const input = corpusInput({
      roster: THREAD_INTELLIGENCE_ROSTER,
      messages: [message],
      annotations: [
        annotation('provenance-action', 'actionable_request', 'actionable'),
      ],
    });

    expect(() =>
      rawApi.analyzeCenturionThreadIntelligence({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [message],
        annotations: input.annotations,
      }),
    ).toThrow('CENTURION_THREAD_INTELLIGENCE_CANONICAL_CORPORA_REQUIRED');
    expect(() =>
      api.analyzeCenturionThreadIntelligence({
        ...input,
        corpora: [
          {
            ...corpora[0],
            source: {
              ...corpora[0].source,
              eventCutoff: '2026-08-01T08:00:00.000Z',
            },
          },
        ],
      }),
    ).toThrow('CENTURION_THREAD_STATE_EVENT_CUTOFF_EXCEEDED');
  });

  it('keeps divider-only history manual', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(
      corpusInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'divider-only-action',
            receivedAt: '2026-08-01T09:00:00.000Z',
            textBody: '-----Original Message-----',
          }),
        ],
        annotations: [
          annotation(
            'divider-only-action',
            'actionable_request',
            'actionable',
          ),
        ],
      }),
    );

    expect(result.components[0]).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'unsupported_quote_like',
    });
  });

  it('overrides no-quote coverage for recognized localized history', async () => {
    const api = await loadIntelligence();
    const message = syntheticMessage({
      id: 'localized-history-action',
      receivedAt: '2026-08-01T09:00:00.000Z',
      textBody: 'El 1 de agosto escribió:',
    });
    const result = api.analyzeCenturionThreadIntelligence({
      roster: THREAD_INTELLIGENCE_ROSTER,
      corpora: canonicalCorpora([message]),
      quoteCoverage: [
        { messageId: 'localized-history-action', status: 'no_quote' },
      ],
      annotations: [
        annotation(
          'localized-history-action',
          'actionable_request',
          'actionable',
        ),
      ],
    });

    expect(result.components[0]).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'unsupported_quote_like',
    });
  });

  it('uses external senders and all weak buckets conservatively', async () => {
    const api = await loadIntelligence();
    const senderOnly = api.analyzeCenturionThreadIntelligence(
      corpusInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'sender-only-a',
            threadId: 'sender-only-thread-a',
            receivedAt: '2026-08-01T09:00:00.000Z',
            from: 'same-external@fixture.test',
            to: ['internal@fixture.test'],
            subject: 'Sender bucket',
          }),
          syntheticMessage({
            id: 'sender-only-b',
            threadId: 'sender-only-thread-b',
            receivedAt: '2026-08-01T10:00:00.000Z',
            from: 'same-external@fixture.test',
            to: ['different@fixture.test'],
            subject: 'Sender bucket',
          }),
        ],
        annotations: [
          annotation('sender-only-a', 'actionable_request', 'actionable'),
          annotation('sender-only-b', 'actionable_request', 'actionable'),
        ],
      }),
    );
    const earlierTurn = api.analyzeCenturionThreadIntelligence(
      corpusInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'weak-earlier-action',
            threadId: 'weak-main-thread',
            receivedAt: '2026-08-01T09:00:00.000Z',
            subject: 'Earlier weak subject',
          }),
          syntheticMessage({
            id: 'later-clear-action',
            threadId: 'weak-main-thread',
            receivedAt: '2026-08-01T10:00:00.000Z',
            subject: 'Later clear subject',
          }),
          syntheticMessage({
            id: 'weak-related-action',
            threadId: 'weak-other-thread',
            receivedAt: '2026-08-01T11:00:00.000Z',
            subject: 'Earlier weak subject',
          }),
        ],
        annotations: [
          annotation('weak-earlier-action', 'actionable_request', 'actionable'),
          annotation('later-clear-action', 'actionable_request', 'actionable'),
          annotation('weak-related-action', 'actionable_request', 'actionable'),
        ],
      }),
    );

    for (const component of senderOnly.components) {
      expect(component).toMatchObject({
        state: 'needs_manual_adjudication',
        limitation: 'weak_subject_participant_correlation',
      });
    }
    expect(
      earlierTurn.components.find((component) =>
        component.chronology.some(
          (turn) => turn.messageId === 'later-clear-action',
        ),
      ),
    ).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'weak_subject_participant_correlation',
      weakCorrelationIndicators: {
        latestActionableTurnAffected: false,
      },
    });
  });

  it('requires verified quote-parser coverage before automatic state', async () => {
    const api = await loadIntelligence();
    const message = syntheticMessage({
      id: 'parser-coverage-action',
      receivedAt: '2026-08-01T09:00:00.000Z',
    });
    const result = api.analyzeCenturionThreadIntelligence({
      roster: THREAD_INTELLIGENCE_ROSTER,
      corpora: canonicalCorpora([message]),
      annotations: [
        annotation(
          'parser-coverage-action',
          'actionable_request',
          'actionable',
        ),
      ],
    });

    expect(result.components[0]).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'quote_parser_coverage_missing',
    });
  });

  it('requires explicit complete canonical source coverage for non-manual state', async () => {
    const api = await loadIntelligence();
    const missingAttestation = api.analyzeCenturionThreadIntelligence({
      roster: THREAD_INTELLIGENCE_ROSTER,
      messages: [
        syntheticMessage({
          id: 'missing-attestation-action',
          receivedAt: '2026-08-01T09:00:00.000Z',
        }),
      ],
      annotations: [
        annotation(
          'missing-attestation-action',
          'actionable_request',
          'actionable',
        ),
      ],
    });
    const missingScope = api.analyzeCenturionThreadIntelligence({
      roster: {
        ...THREAD_INTELLIGENCE_ROSTER,
        authorizedTransportIds: ['transport-a', 'transport-b'],
      },
      sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
      messages: [
        syntheticMessage({
          id: 'missing-scope-action',
          receivedAt: '2026-08-01T09:00:00.000Z',
        }),
      ],
      annotations: [
        annotation('missing-scope-action', 'actionable_request', 'actionable'),
      ],
    });

    expect(missingAttestation.components[0]).toMatchObject({
      state: 'action_required',
      coverage: {
        attestation: 'complete',
      },
    });
    expect(missingScope.components[0]).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'source_coverage_incomplete',
      coverage: {
        missingRosterTransportIds: ['transport-b'],
      },
    });
  });

  it('keeps latest quote uncertainty manual despite earlier persisted response', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(
      coveredInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'earlier-action',
            receivedAt: '2026-08-01T09:00:00.000Z',
          }),
          syntheticMessage({
            id: 'earlier-response',
            direction: 'outbound',
            sentAt: '2026-08-01T10:00:00.000Z',
            from: 'internal@fixture.test',
            to: ['external@fixture.test'],
          }),
          syntheticMessage({
            id: 'quoted-follow-up',
            receivedAt: '2026-08-01T11:00:00.000Z',
            textBody:
              'On 2026-08-01, Internal <internal@fixture.test> wrote:',
          }),
        ],
        annotations: [
          annotation('earlier-action', 'actionable_request', 'actionable'),
          annotation('earlier-response', 'staff_response', 'non_actionable'),
          annotation('quoted-follow-up', 'actionable_request', 'actionable'),
        ],
      }),
    );

    expect(result.components[0]).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'quoted_only_evidence',
      actionEvidence: {
        messageId: 'quoted-follow-up',
        actionRequiredEligible: false,
      },
      responseEvidence: {
        tier: 'persisted_reply',
      },
    });
  });

  it('rejects malformed persisted reply and quote message identifiers', async () => {
    const api = await loadIntelligence();
    const malformedReply = api.analyzeCenturionThreadIntelligence(
      coveredInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'strict-parent',
            threadId: 'strict-parent-thread',
            messageId: '<strict-parent@fixture.test>',
          }),
          syntheticMessage({
            id: 'strict-reply',
            threadId: 'strict-reply-thread',
            direction: 'outbound',
            sentAt: '2026-08-01T10:00:00.000Z',
            from: 'internal@fixture.test',
            to: ['external@fixture.test'],
            inReplyTo: null,
          }),
        ],
        annotations: [
          annotation('strict-parent', 'actionable_request', 'actionable'),
          annotation('strict-reply', 'staff_response', 'non_actionable'),
        ],
      }),
    );
    const malformedQuote = api.analyzeCenturionThreadIntelligence(
      coveredInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'quote-parent',
            threadId: 'quote-parent-thread',
            direction: 'outbound',
            sentAt: '2026-08-01T08:00:00.000Z',
            from: 'internal@fixture.test',
            to: ['external@fixture.test'],
            messageId: '<quote-parent@fixture.test>',
          }),
          syntheticMessage({
            id: 'malformed-quote-action',
            threadId: 'quote-action-thread',
            receivedAt: '2026-08-01T09:00:00.000Z',
            textBody: [
              'On 2026-08-01, Internal <internal@fixture.test> wrote:',
              'Message-ID: <quote-parent@fixture.test> trailing',
            ].join('\n'),
          }),
        ],
        annotations: [
          annotation('quote-parent', 'staff_response', 'non_actionable'),
          annotation(
            'malformed-quote-action',
            'actionable_request',
            'actionable',
          ),
        ],
      }),
    );

    expect(malformedReply.components).toHaveLength(2);
    expect(malformedReply.graph.hardEdges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unique_reply_header' }),
      ]),
    );
    expect(malformedQuote.components).toHaveLength(2);
    expect(malformedQuote.graph.hardEdges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unique_quoted_message_id' }),
      ]),
    );
  });

  it('quarantines conflicting persisted reply headers from graph joins', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(
      coveredInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'conflict-parent',
            threadId: 'conflict-parent-thread',
            messageId: '<conflict-parent@fixture.test>',
            subject: 'Parent conversation',
          }),
          syntheticMessage({
            id: 'conflict-reference',
            threadId: 'conflict-reference-thread',
            messageId: '<conflict-reference@fixture.test>',
            subject: 'Reference conversation',
          }),
          syntheticMessage({
            id: 'conflict-child',
            threadId: 'conflict-child-thread',
            receivedAt: '2026-08-01T10:00:00.000Z',
            subject: 'Current request',
            inReplyTo: '<conflict-parent@fixture.test>',
            references: ['<conflict-reference@fixture.test>'],
          }),
        ],
        annotations: [
          annotation('conflict-parent', 'non_actionable', 'non_actionable'),
          annotation('conflict-reference', 'non_actionable', 'non_actionable'),
          annotation('conflict-child', 'actionable_request', 'actionable'),
        ],
      }),
    );

    expect(result.components).toHaveLength(3);
    expect(result.graph.hardEdges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unique_reply_header' }),
      ]),
    );
    expect(
      result.components.find((component) =>
        component.chronology.some(
          (turn) => turn.messageId === 'conflict-child',
        ),
      ),
    ).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'ambiguous_reply_header',
    });
  });

  it('quarantines malformed reference input from graph joins', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(
      coveredInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'malformed-reference-parent',
            threadId: 'malformed-reference-parent-thread',
            messageId: '<malformed-reference-parent@fixture.test>',
          }),
          syntheticMessage({
            id: 'malformed-reference-child',
            threadId: 'malformed-reference-child-thread',
            receivedAt: '2026-08-01T10:00:00.000Z',
            inReplyTo: '<malformed-reference-parent@fixture.test>',
            references: [
              '<malformed-reference-parent@fixture.test>',
              'malformed reference value',
            ],
          }),
        ],
        annotations: [
          annotation(
            'malformed-reference-parent',
            'non_actionable',
            'non_actionable',
          ),
          annotation(
            'malformed-reference-child',
            'actionable_request',
            'actionable',
          ),
        ],
      }),
    );

    expect(result.components).toHaveLength(2);
    expect(result.graph.hardEdges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unique_reply_header' }),
      ]),
    );
    const childComponent = result.components.find((component) =>
      component.chronology.some(
        (turn) => turn.messageId === 'malformed-reference-child',
      ),
    );
    expect(childComponent).toMatchObject({
      state: 'needs_manual_adjudication',
    });
    expect(childComponent?.limitations).toContain('malformed_reply_header');
  });

  it('requires explicit annotation for automation and acknowledgements', async () => {
    const api = await loadIntelligence();
    const automated = api.analyzeCenturionThreadIntelligence(automatedInput);
    const acknowledgement = api.analyzeCenturionThreadIntelligence({
      roster: THREAD_INTELLIGENCE_ROSTER,
      sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
      messages: [
        syntheticMessage({
          id: 'acknowledgement-turn',
          createdAt: '2026-08-01T09:00:00.000Z',
          receivedAt: '2026-08-01T09:00:00.000Z',
        }),
      ],
      annotations: [
        annotation(
          'acknowledgement-turn',
          'customer_acknowledgement_or_confirmation',
          'non_actionable',
        ),
      ],
    });

    expect(automated.components[0]?.state).toBe('automated_or_non_actionable');
    expect(acknowledgement.components[0]?.state).toBe(
      'customer_acknowledgement_or_confirmation',
    );
  });

  it('does not let a later automated turn hide an unanswered action', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence({
      roster: THREAD_INTELLIGENCE_ROSTER,
      sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
      messages: [
        syntheticMessage({
          id: 'unanswered-action',
          createdAt: '2026-08-01T09:00:00.000Z',
          receivedAt: '2026-08-01T09:00:00.000Z',
        }),
        syntheticMessage({
          id: 'later-automated-turn',
          createdAt: '2026-08-01T10:00:00.000Z',
          receivedAt: '2026-08-01T10:00:00.000Z',
        }),
      ],
      annotations: [
        annotation('unanswered-action', 'actionable_request', 'actionable'),
        annotation(
          'later-automated-turn',
          'automated_or_non_actionable',
          'non_actionable',
        ),
      ],
    });

    expect(result.components[0]).toMatchObject({
      state: 'action_required',
      latestExternalActionableTurn: {
        messageId: 'unanswered-action',
      },
    });
  });

  it('does not let an internal handoff create a terminal work claim alone', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(internalHandoffInput);

    expect(result.components[0]).toMatchObject({
      state: 'needs_manual_adjudication',
      latestExternalActionableTurn: null,
    });
  });

  it('uses trusted event chronology rather than late creation order', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(lateResponseInput);
    const component = result.components[0];

    expect(result.components).toHaveLength(1);
    expect(component).toMatchObject({
      state: 'resolved',
      evidenceTier: 'persisted_reply',
      elapsedDuration: {
        milliseconds: 3_600_000,
        reason: null,
      },
    });
    expect(component.chronology.map((turn: { messageId: string }) => turn.messageId)).toEqual([
      'request-root',
      'late-staff',
    ]);
    expect(component.responseGaps).toEqual([
      expect.objectContaining({
        actionableMessageId: 'request-root',
        responseMessageId: 'late-staff',
        durationMs: 3_600_000,
        reason: null,
      }),
    ]);
    expect(result.graph.hardEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unique_reply_header',
          sourceMessageId: 'late-staff',
          targetMessageId: 'request-root',
        }),
      ]),
    );
  });

  it('scopes persisted-thread and reply-header hard joins to transport', async () => {
    const api = await loadIntelligence();
    const messages = [
      syntheticMessage({
        id: 'transport-a-header-parent',
        transportId: 'transport-a',
        threadId: 'cross-transport-thread',
        direction: 'outbound',
        createdAt: '2026-08-01T08:00:00.000Z',
        sentAt: '2026-08-01T08:00:00.000Z',
        from: 'internal@fixture.test',
        to: ['external@fixture.test'],
        messageId: '<cross-transport-header@fixture.test>',
      }),
      syntheticMessage({
        id: 'transport-b-header-reply',
        transportId: 'transport-b',
        threadId: 'cross-transport-thread',
        createdAt: '2026-08-01T09:00:00.000Z',
        receivedAt: '2026-08-01T09:00:00.000Z',
        from: 'other@fixture.test',
        inReplyTo: 'cross-transport-header@fixture.test',
        references: ['cross-transport-header@fixture.test'],
      }),
    ];
    const result = api.analyzeCenturionThreadIntelligence({
      roster: {
        ...THREAD_INTELLIGENCE_ROSTER,
        authorizedTransportIds: ['transport-a', 'transport-b'],
      },
      corpora: canonicalCorpora(messages),
      quoteCoverage: messages.map((message) => ({
        messageId: message.id,
        status: 'no_quote' as const,
      })),
      annotations: [
        annotation('transport-a-header-parent', 'staff_response', 'non_actionable'),
        annotation('transport-b-header-reply', 'actionable_request', 'actionable'),
      ],
    });

    expect(result.components).toHaveLength(2);
    expect(result.graph.hardEdges).toEqual([]);
  });

  it('does not resolve a later actionable follow-up from an earlier response', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence({
      roster: THREAD_INTELLIGENCE_ROSTER,
      sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
      messages: [
        syntheticMessage({
          id: 'first-action',
          createdAt: '2026-08-01T09:00:00.000Z',
          receivedAt: '2026-08-01T09:00:00.000Z',
        }),
        syntheticMessage({
          id: 'first-response',
          direction: 'outbound',
          createdAt: '2026-08-01T10:00:00.000Z',
          sentAt: '2026-08-01T10:00:00.000Z',
          from: 'internal@fixture.test',
          to: ['external@fixture.test'],
        }),
        syntheticMessage({
          id: 'follow-up-action',
          createdAt: '2026-08-01T11:00:00.000Z',
          receivedAt: '2026-08-01T11:00:00.000Z',
        }),
      ],
      annotations: [
        annotation('first-action', 'actionable_request', 'actionable'),
        annotation('first-response', 'staff_response', 'non_actionable'),
        annotation('follow-up-action', 'actionable_request', 'actionable'),
      ],
    });

    expect(result.components[0]).toMatchObject({
      state: 'action_required',
      latestExternalActionableTurn: {
        messageId: 'follow-up-action',
      },
    });
    expect(result.components[0]?.responseGaps).toEqual([
      expect.objectContaining({
        actionableMessageId: 'first-action',
        responseMessageId: 'first-response',
      }),
      expect.objectContaining({
        actionableMessageId: 'follow-up-action',
        responseMessageId: null,
      }),
    ]);
  });

  it('marks duplicate IDs manual even when hard graph components differ', async () => {
    const api = await loadIntelligence();
    expect(() =>
      api.analyzeCenturionThreadIntelligence({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({ id: 'cross-component-duplicate' }),
          syntheticMessage({
            id: 'cross-component-duplicate',
            threadId: 'duplicate-thread-b',
          }),
        ],
        annotations: [
          annotation(
            'cross-component-duplicate',
            'actionable_request',
            'actionable',
          ),
        ],
      }),
    ).toThrow('CENTURION_THREAD_STATE_DUPLICATE_MESSAGE_ID');
  });

  it('flags duplicate persisted turns instead of resolving them', async () => {
    const api = await loadIntelligence();
    expect(() => api.analyzeCenturionThreadIntelligence(duplicateInput)).toThrow(
      'CENTURION_THREAD_STATE_DUPLICATE_MESSAGE_ID',
    );
  });

  it('parses nested quote history once per attributable source', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(nestedQuoteInput);
    const component = result.components[0];

    expect(result.components).toHaveLength(1);
    expect(component.quotedEvidence).toHaveLength(1);
    expect(component.quotedEvidence[0]).toMatchObject({
      sourceMessageId: 'nested-request',
      senderRole: 'internal',
      provenance: {
        marker: 'outlook_headers',
        depth: 1,
      },
    });
  });

  it('does not multiply one quote across adjacent history markers', async () => {
    const api = await loadIntelligence();
    const evidence = api.extractCenturionQuotedEvidence({
      sourceMessageId: 'adjacent-history',
      roster: THREAD_INTELLIGENCE_ROSTER,
      textBody: [
        'On 2026-08-01, Internal <internal@fixture.test> wrote:',
        '-----Original Message-----',
        'From: Internal <internal@fixture.test>',
        'Sent: 2026-08-01T07:00:00.000Z',
        'To: External <external@fixture.test>',
        'Subject: Earlier detail',
        'Message-ID: <adjacent-history@fixture.test>',
      ].join('\n'),
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      senderRole: 'internal',
      quotedMessageId: 'adjacent-history@fixture.test',
    });
  });

  it('keeps weak subject and participant correlation outside hard components', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(
      ambiguousCorrelationInput,
    );

    expect(result.components).toHaveLength(2);
    expect(result.graph.weakCorrelation).toMatchObject({
      bucketCount: 2,
      affectedComponentCount: 2,
    });
    for (const component of result.components) {
      expect(component).toMatchObject({
        state: 'needs_manual_adjudication',
        evidenceTier: 'participant_subject_only_correlation',
        limitation: 'weak_subject_participant_correlation',
      });
      expect(component.weakCorrelationIndicators).toMatchObject({
        bucketCount: 2,
        latestActionableTurnAffected: true,
      });
    }
  });

  it('treats unauthorized source coverage as manual despite a verified sender', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(foreignTransportInput);

    expect(result.components).toHaveLength(2);
    expect(
      result.components.find((component) =>
        component.chronology.some(
          (turn) => turn.messageId === 'coverage-staff',
        ),
      ),
    ).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'source_coverage_incomplete',
      coverage: {
        complete: false,
        unauthorizedTransportIds: ['transport-b'],
      },
    });
  });

  it('surfaces bounded and unsupported quote coverage limits', async () => {
    const api = await loadIntelligence();
    const truncated = api.analyzeCenturionThreadIntelligence(
      coveredInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'truncated-quote-action',
            receivedAt: '2026-08-01T09:00:00.000Z',
            textBody: `${'x'.repeat(64 * 1024)}\nOn 2026-08-01, Internal <internal@fixture.test> wrote:`,
          }),
        ],
        annotations: [
          annotation(
            'truncated-quote-action',
            'actionable_request',
            'actionable',
          ),
        ],
      }),
    );
    const unsupported = api.analyzeCenturionThreadIntelligence(
      coveredInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'unsupported-quote-action',
            receivedAt: '2026-08-01T09:00:00.000Z',
            textBody: '> quoted source without supported headers',
          }),
        ],
        annotations: [
          annotation(
            'unsupported-quote-action',
            'actionable_request',
            'actionable',
          ),
        ],
      }),
    );
    const htmlOnly = api.analyzeCenturionThreadIntelligence(
      coveredInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: [
          syntheticMessage({
            id: 'html-only-action',
            receivedAt: '2026-08-01T09:00:00.000Z',
            textBody: null,
            htmlBody: '<blockquote>quoted history</blockquote>',
          }),
        ],
        annotations: [
          annotation('html-only-action', 'actionable_request', 'actionable'),
        ],
      }),
    );

    expect(truncated.components[0]).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'quote_text_truncated',
    });
    expect(unsupported.components[0]).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'unsupported_quote_like',
    });
    expect(htmlOnly.components[0]).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'html_only_quote_coverage',
    });
  });

  it('keeps weak-correlation accounting bounded by components', async () => {
    const api = await loadIntelligence();
    const messageCount = 24;
    const result = api.analyzeCenturionThreadIntelligence(
      coveredInput({
        roster: THREAD_INTELLIGENCE_ROSTER,
        messages: Array.from({ length: messageCount }, (_, index) =>
          syntheticMessage({
            id: `weak-turn-${index}`,
            threadId: `weak-thread-${index}`,
            receivedAt: `2026-08-01T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
            subject: 'Shared bounded subject',
          }),
        ),
        annotations: Array.from({ length: messageCount }, (_, index) =>
          annotation(`weak-turn-${index}`, 'actionable_request', 'actionable'),
        ),
      }),
    );

    expect(result.components).toHaveLength(messageCount);
    expect(result.graph.weakCorrelation).toMatchObject({
      bucketCount: 2,
      affectedComponentCount: messageCount,
    });
    expect(result.graph).not.toHaveProperty('weakCorrelations');
    for (const component of result.components) {
      expect(component.weakCorrelationIndicators).toMatchObject({
        bucketCount: 2,
        latestActionableTurnAffected: true,
      });
    }
  });

  it('keeps missing annotations and event times manual', async () => {
    const api = await loadIntelligence();
    const missingAnnotation = api.analyzeCenturionThreadIntelligence(
      missingAnnotationInput,
    );
    const missingTime = api.analyzeCenturionThreadIntelligence({
      roster: THREAD_INTELLIGENCE_ROSTER,
      sourceCoverage: THREAD_INTELLIGENCE_SOURCE_COVERAGE,
      messages: [
        syntheticMessage({
          id: 'missing-time-turn',
        }),
      ],
      annotations: [
        annotation('missing-time-turn', 'actionable_request', 'actionable'),
      ],
    });

    expect(missingAnnotation.components[0]).toMatchObject({
      state: 'needs_manual_adjudication',
      limitation: 'missing_or_ambiguous_annotation',
    });
    expect(missingTime.components[0]).toMatchObject({
      state: 'action_required',
      limitation: 'none',
      elapsedDuration: {
        milliseconds: 0,
        reason: null,
      },
    });
  });

  it('does not infer internal identity from outbound direction', async () => {
    const api = await loadIntelligence();
    const result = api.analyzeCenturionThreadIntelligence(directionOnlyInput);
    const component = result.components[0];

    expect(component.state).toBe('action_required');
    expect(component.firstVerifiedInternalEvidence).toBeNull();
    expect(component.participantRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: 'not-approved@fixture.test',
          role: 'external',
        }),
      ]),
    );
  });
});
