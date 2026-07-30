import { describe, expect, it } from 'vitest';
import { createFakeModelAdapter } from '../src/ai/bedrock/fake.js';
import {
  buildCausalTriageMessages,
  hashTriageInput,
  hashTriagePrompt,
  type TriageMessageRow,
} from '../src/ai/triage-input.js';
import { buildSystemPrompt, classifyMailTriage } from '../src/ai/workflows/mail-triage.js';

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

    const promptHash = hashTriagePrompt(buildSystemPrompt());
    const inputHash = hashTriageInput(input);
    expect(promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashTriagePrompt(buildSystemPrompt())).toBe(promptHash);
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
