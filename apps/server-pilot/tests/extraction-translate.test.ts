import { describe, expect, it } from 'vitest';
import {
  splitSegments,
  TRANSLATE_DEADLINE_MS,
  TRANSLATE_RULES,
  translateInboundBody,
} from '../src/ai/extraction/translate.js';
import { AE2_TEXT, echoTranslation, fakeModel, hangingResponder } from './fixtures/inbound-extraction.js';

const CARD_DIGITS = /4111[ -]?1111[ -]?1111[ -]?1111/;

describe('splitSegments', () => {
  it('splits on blank lines, trims each part, and drops empty parts', () => {
    expect(splitSegments('One.\n\n\nTwo.\r\n\r\n  Three.  \n\n')).toEqual({
      segments: ['One.', 'Two.', 'Three.'],
      truncated: false,
    });
  });

  it('caps one segment at 2000 characters and marks the result truncated', () => {
    const { segments, truncated } = splitSegments('x'.repeat(2500));
    expect(segments[0]).toHaveLength(2000);
    expect(truncated).toBe(true);
  });

  it('drops the tail past 12000 characters and marks the result truncated', () => {
    const body = Array.from({ length: 7 }, () => 'y'.repeat(2000)).join('\n\n');
    const { segments, truncated } = splitSegments(body);
    expect(segments).toHaveLength(6);
    expect(truncated).toBe(true);
  });
});

describe('translateInboundBody', () => {
  it('stores aligned clean and literal segments for a French body', async () => {
    const model = fakeModel(echoTranslation);
    const done = await translateInboundBody({
      adapter: model.adapter,
      bodyText: AE2_TEXT,
      sourceLanguage: 'fr',
    });
    const count = splitSegments(AE2_TEXT).segments.length;
    expect(done?.translation).toEqual({
      status: 'succeeded',
      sourceLanguage: 'fr',
      truncated: false,
      segments: Array.from({ length: count }, (_, index) => ({
        clean: `Clean ${index + 1}`,
        literal: `Literal ${index + 1}`,
      })),
    });
    expect(done?.usage.modelId).toBe('gpt-6-luna');
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.systemPrompt).toBe(TRANSLATE_RULES);
  });

  it('makes no call for a body with no text', async () => {
    const model = fakeModel(echoTranslation);
    const done = await translateInboundBody({
      adapter: model.adapter,
      bodyText: '  \n\n  ',
      sourceLanguage: 'fr',
    });
    expect(done).toBeNull();
    expect(model.calls).toHaveLength(0);
  });

  it('masks card digits before the model call and in the returned text', async () => {
    const model = fakeModel(() => ({
      segments: [{ clean: 'Card 4111111111111111', literal: 'Carte 4111 1111 1111 1111' }],
    }));
    const done = await translateInboundBody({
      adapter: model.adapter,
      bodyText: 'Carte 4111 1111 1111 1111 utilisée.',
      sourceLanguage: 'fr',
    });
    expect(model.calls[0]?.userPrompt).not.toMatch(CARD_DIGITS);
    expect(model.calls[0]?.userPrompt).toContain('[card ••••1111]');
    expect(JSON.stringify(done)).not.toMatch(CARD_DIGITS);
  });

  it('stores failed with misaligned when the segment count differs', async () => {
    const model = fakeModel(() => ({ segments: [{ clean: 'Only one', literal: 'Only one' }] }));
    const done = await translateInboundBody({
      adapter: model.adapter,
      bodyText: AE2_TEXT,
      sourceLanguage: 'fr',
    });
    expect(done?.translation).toMatchObject({ status: 'failed', reason: 'misaligned' });
  });

  it('stores failed with invalid_output when the output does not match the schema', async () => {
    const model = fakeModel(() => ({ segments: 'not a list' }));
    const done = await translateInboundBody({
      adapter: model.adapter,
      bodyText: 'Bonjour.',
      sourceLanguage: 'fr',
    });
    expect(done?.translation).toMatchObject({ status: 'failed', reason: 'invalid_output' });
  });

  it('ends a call that never answers at its deadline and stores failed with timeout', async () => {
    const model = fakeModel(hangingResponder);
    const started = Date.now();
    const done = await translateInboundBody({
      adapter: model.adapter,
      bodyText: 'Bonjour.',
      sourceLanguage: 'fr',
      deadlineMs: 30,
    });
    expect(done?.translation).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives the call its own translation deadline when none is passed', async () => {
    const model = fakeModel(echoTranslation);
    const before = Date.now();
    await translateInboundBody({ adapter: model.adapter, bodyText: 'Bonjour.', sourceLanguage: 'fr' });
    const deadlineAt = model.calls[0]?.deadlineAt ?? 0;
    expect(deadlineAt - before).toBeGreaterThanOrEqual(TRANSLATE_DEADLINE_MS - 1_000);
    expect(deadlineAt - before).toBeLessThanOrEqual(TRANSLATE_DEADLINE_MS + 1_000);
  });
});
