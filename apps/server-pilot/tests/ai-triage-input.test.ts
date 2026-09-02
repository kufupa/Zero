import { describe, expect, it } from 'vitest';
import { createFakeModelAdapter } from '../src/ai/bedrock/fake.js';
import {
  buildCausalTriageMessages,
  hashTriageInput,
  hashTriagePrompt,
  type TriageMessageRow,
} from '../src/ai/triage-input.js';
import { refineTriageOutput } from '../src/ai/triage.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  classifyMailTriage,
  classifyWorkflowMailTriage,
} from '../src/ai/workflows/mail-triage.js';

function row(
  partial: Partial<TriageMessageRow> & Pick<TriageMessageRow, 'id' | 'createdAt'>,
): TriageMessageRow {
  return {
    from: partial.from ?? `${partial.id}@example.com`,
    subject: partial.subject,
    body: partial.body ?? `body-${partial.id}`,
    direction: partial.direction ?? 'inbound',
    receivedAt: partial.receivedAt ?? null,
    sentAt: partial.sentAt ?? null,
    ...partial,
  };
}

describe('buildCausalTriageMessages', () => {
  it('sorts and cuts off by (createdAt, id), includes one trigger', () => {
    const t0 = new Date('2026-07-01T10:00:00.000Z');
    const t1 = new Date('2026-07-01T10:00:00.000Z');
    const t2 = new Date('2026-07-01T11:00:00.000Z');
    const rows = [
      row({ id: 'm-b', createdAt: t1, body: 'same-ts-b' }),
      row({ id: 'm-a', createdAt: t0, body: 'same-ts-a' }),
      row({ id: 'm-future', createdAt: t2, body: 'future' }),
      row({ id: 'm-trigger', createdAt: t1, body: 'trigger', direction: 'outbound' }),
    ];

    const causal = buildCausalTriageMessages(rows, 'm-trigger');
    expect(causal.map((m) => m.id)).toEqual(['m-a', 'm-b', 'm-trigger']);
    expect(causal.filter((m) => m.id === 'm-trigger')).toHaveLength(1);
    expect(causal.some((m) => m.id === 'm-future')).toBe(false);
  });

  it('excludes future messages even when future mail has older sender Date', () => {
    const triggerCreated = new Date('2026-07-01T12:00:00.000Z');
    const futureCreated = new Date('2026-07-01T13:00:00.000Z');
    const olderSenderDate = new Date('2026-06-01T00:00:00.000Z');

    const rows = [
      row({
        id: 'm-trigger',
        createdAt: triggerCreated,
        receivedAt: triggerCreated,
        sentAt: null,
        body: 'trigger',
      }),
      row({
        id: 'm-future',
        createdAt: futureCreated,
        receivedAt: olderSenderDate,
        sentAt: olderSenderDate,
        body: 'future-with-old-sender-date',
      }),
    ];

    const causal = buildCausalTriageMessages(rows, 'm-trigger');
    expect(causal.map((m) => m.id)).toEqual(['m-trigger']);
  });

  it('throws when trigger message is missing', () => {
    expect(() =>
      buildCausalTriageMessages(
        [row({ id: 'm1', createdAt: new Date('2026-07-01T00:00:00.000Z') })],
        'missing',
      ),
    ).toThrow(/trigger/i);
  });
});

describe('triage provenance hashes', () => {
  it('requires ISO asOf and yields stable prompt/input hashes', async () => {
    const messages = buildCausalTriageMessages(
      [
        row({
          id: 'm1',
          createdAt: new Date('2026-07-01T10:00:00.000Z'),
          body: 'Need 20 rooms for a group booking',
          subject: 'Group quote',
          to: ['centurion@legacyhotels.co.za'],
          cc: ['reservations@legacyhotels.co.za'],
        }),
      ],
      'm1',
    );
    const input = {
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      triggerMessageId: 'm1',
      messages,
      asOf: '2026-07-01T12:00:00.000Z',
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v5',
    };

    expect(() =>
      hashTriageInput({ ...input, asOf: 'not-iso' }),
    ).toThrow(/asOf/i);

    const userPrompt = buildUserPrompt({
      triggerMessageId: input.triggerMessageId,
      asOf: input.asOf,
      messages,
    });
    const promptHash = hashTriagePrompt(buildSystemPrompt(), userPrompt, input.promptVersion);
    const inputHash = hashTriageInput(input);
    expect(promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashTriagePrompt(buildSystemPrompt(), userPrompt, input.promptVersion)).toBe(promptHash);
    expect(hashTriageInput(input)).toBe(inputHash);

    const adapter = createFakeModelAdapter();
    const classification = await classifyMailTriage(input, adapter);
    expect(classification.promptHash).toBe(promptHash);
    expect(classification.inputHash).toBe(inputHash);
    expect(classification.modelId).toBe(input.modelId);
    expect(classification.rawOutput).toMatchObject({ category: expect.any(String) });
    expect(classification.output).toMatchObject({
      category: 'groups-events',
      rationale: expect.any(String),
      policyFlags: expect.any(Array),
    });
    expect(classification.usage.totalTokens).toBeGreaterThan(0);
  });

  it('hashes causal recipients and thread signals so classification inputs cannot collide', () => {
    const base = {
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      triggerMessageId: 'm1',
      messages: [
        row({
          id: 'm1',
          createdAt: new Date('2026-07-01T10:00:00.000Z'),
          body: 'Need a room',
          to: ['centurion@legacyhotels.co.za'],
          cc: ['reservations@legacyhotels.co.za'],
          bcc: [],
        }),
      ],
      asOf: '2026-07-01T12:00:00.000Z',
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v6',
      threadSignals: { legacyHotelsOutboundResponse: false },
    };

    const recipientHash = hashTriageInput({
      ...base,
      messages: [{ ...base.messages[0]!, to: ['different-recipient@example.com'] }],
    });
    const signalHash = hashTriageInput({
      ...base,
      threadSignals: { legacyHotelsOutboundResponse: true },
    });

    expect(recipientHash).not.toBe(hashTriageInput(base));
    expect(signalHash).not.toBe(hashTriageInput(base));
    expect(hashTriageInput(base)).toBe(hashTriageInput(base));
  });

  it('prompt hash covers dynamic user prompt while remaining deterministic', () => {
    const system = buildSystemPrompt();
    expect(hashTriagePrompt(system, 'recipient: one@example.com')).not.toBe(
      hashTriagePrompt(system, 'recipient: two@example.com'),
    );
    expect(hashTriagePrompt(system, 'same prompt', 'triage-v5')).not.toBe(
      hashTriagePrompt(system, 'same prompt', 'triage-v6'),
    );
    const hash = hashTriagePrompt(system, 'same prompt');
    expect(hashTriagePrompt(system, 'same prompt')).toBe(hash);
  });

  it('conversation metrics stay out of hashTriageInput and user prompt', async () => {
    const messages = buildCausalTriageMessages(
      [
        row({
          id: 'm1',
          createdAt: new Date('2026-07-01T10:00:00.000Z'),
          body: 'Please find attached quotation for your requested dates.',
          subject: 'Re: quote',
        }),
      ],
      'm1',
    );
    const input = {
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      triggerMessageId: 'm1',
      messages,
      asOf: '2026-07-01T12:00:00.000Z',
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v6',
    };
    const hashBefore = hashTriageInput(input);
    const userPrompt = buildUserPrompt({
      triggerMessageId: input.triggerMessageId,
      asOf: input.asOf,
      messages,
    });
    expect(userPrompt).not.toMatch(/conversationResponded/);
    expect(userPrompt).not.toMatch(/conversationSignalReasons/);

    const classification = await classifyWorkflowMailTriage(input, createFakeModelAdapter());
    expect(classification.conversationMetrics).toMatchObject({
      conversationResponded: true,
      conversationSignalReasons: ['quoted_hotel_phrase'],
    });
    expect(hashTriageInput(input)).toBe(hashBefore);
  });

  it('conversationResponded in metrics does not change spam refine', () => {
    const spamOutput = {
      primaryFolder: 'unknown-review' as const,
      priority: 'P4' as const,
      urgent: false,
      overlays: { booking: false, quote: false, payment: false },
      isSpam: true,
      suggestedTools: [] as string[],
      sourceScope: 'external' as const,
      automationState: 'unknown' as const,
      humanAction: 'review_required' as const,
      confidence: 0.9,
      rationale: 'cold vendor pitch',
      policyFlags: [] as string[],
      abstainReason: null,
    };
    const withQuotedBody = refineTriageOutput(
      {
        from: 'vendor@spam.example.com',
        subject: 'Special offer',
        body: 'Please find attached quotation for your requested dates.',
        asOf: '2026-07-01T12:00:00.000Z',
      },
      spamOutput,
    );
    const withoutQuotedBody = refineTriageOutput(
      {
        from: 'vendor@spam.example.com',
        subject: 'Special offer',
        body: 'Buy our product now.',
        asOf: '2026-07-01T12:00:00.000Z',
      },
      spamOutput,
    );
    expect(withQuotedBody.isSpam).toBe(true);
    expect(withoutQuotedBody.isSpam).toBe(true);
    expect(withQuotedBody.policyFlags).toEqual(withoutQuotedBody.policyFlags);
  });

  it('classifyMailTriage uses input.modelId not process.env.AI_MODEL_ID', async () => {
    const prev = process.env.AI_MODEL_ID;
    process.env.AI_MODEL_ID = 'should-not-be-used';
    try {
      const messages = [
        row({
          id: 'm1',
          createdAt: new Date('2026-07-01T10:00:00.000Z'),
          body: 'Need a room tonight',
        }),
      ];
      const classification = await classifyMailTriage(
        {
          transportId: 't',
          threadId: 'th',
          triggerMessageId: 'm1',
          messages,
          asOf: '2026-07-01T12:00:00.000Z',
          modelId: 'pinned-model-from-run',
          promptVersion: 'triage-v5',
        },
        createFakeModelAdapter(),
      );
      expect(classification.modelId).toBe('pinned-model-from-run');
    } finally {
      if (prev === undefined) delete process.env.AI_MODEL_ID;
      else process.env.AI_MODEL_ID = prev;
    }
  });
});
