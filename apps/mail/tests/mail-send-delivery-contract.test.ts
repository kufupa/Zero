import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const undoSendSource = readSource('../hooks/use-undo-send.ts');
const unsubscribeSource = readSource('../lib/email-utils.client.tsx');
const voiceToolSource = readSource('../lib/elevenlabs-tools.ts');

describe('mail send delivery result contract', () => {
  it('surfaces partial SMTP delivery without a full-success toast', () => {
    expect(undoSendSource).toContain('isPartialSendResult(result)');
    expect(undoSendSource).toContain("toast.warning('Email partially delivered'");
  });

  it('keeps non-compose send consumers from claiming full delivery on partial results', () => {
    expect(unsubscribeSource).toContain('isPartialSendResult(result)');
    expect(voiceToolSource).toContain('isPartialSendResult(result)');
    expect(voiceToolSource).toContain('partial: true');
  });
});
