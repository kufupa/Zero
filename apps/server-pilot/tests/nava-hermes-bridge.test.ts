import { describe, expect, it } from 'vitest';
import { cleanHermesReply, extractHermesSessionId } from '../src/ops/nava-hermes-bridge.ts';

describe('cleanHermesReply', () => {
  it('strips session banner lines', () => {
    expect(cleanHermesReply('session_id: abc\nHello operator')).toBe('Hello operator');
  });

  it('keeps final answer and drops Reasoning / Clarifying scratch', () => {
    const raw = [
      '┌─ Reasoning ──────────────────────────────────────────────────────────────────┐',
      '**Clarifying quarantine signals**',
      '',
      'I need to provide a concise answer in one sentence. The user is asking for clarity',
      ' on the quarantine signals related to security filtering. I’ll make sure to keep it short and clear!**Clarifying quarantine signals**',
      '',
      'I need to provide a concise answer in one sentence. I’ll make sure to keep it short and clear!',
      'Because quarantine indicates a security-screening state—not that a message is unsolicited or irrelevant—so Nava keeps it human-locked without an authoritative verdict.',
    ].join('\n');

    expect(cleanHermesReply(raw)).toBe(
      'Because quarantine indicates a security-screening state—not that a message is unsolicited or irrelevant—so Nava keeps it human-locked without an authoritative verdict.',
    );
  });

  it('keeps multi-paragraph answers when no Reasoning dump', () => {
    const raw = [
      'Build read-only triage first.',
      '',
      'Then route uncertain threads to the human-lock queue.',
    ].join('\n');
    expect(cleanHermesReply(raw)).toContain('human-lock queue');
    expect(cleanHermesReply(raw)).toContain('Build read-only triage first.');
  });

  it('strips staged investor phrasing from seed replies', () => {
    expect(cleanHermesReply('NAVA_LIVE_OK — loaded. Ask one investor question.')).toBe(
      'NAVA_LIVE_OK — loaded. Ask the next question.',
    );
  });
});

describe('extractHermesSessionId', () => {
  it('reads session_id from stderr', () => {
    expect(extractHermesSessionId('session_id: 20260827_184814_b001bb\n')).toBe(
      '20260827_184814_b001bb',
    );
  });
});
