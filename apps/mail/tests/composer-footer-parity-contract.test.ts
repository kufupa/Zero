import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/create/email-composer.tsx', import.meta.url),
  'utf8',
);
const replyComposerSource = readFileSync(
  new URL('../components/mail/reply-composer.tsx', import.meta.url),
  'utf8',
);

describe('composer footer parity', () => {
  it('puts Send immediately before Send later in one wrapping shared left action row', () => {
    const footerStart = source.indexOf('{/* Bottom Actions */}');
    const footerEnd = source.indexOf('<Dialog open={showLeaveConfirmation}', footerStart);
    const leftActionsStart = source.indexOf(
      '<div className="flex flex-wrap items-center justify-start gap-2">',
      footerStart,
    );
    const scheduleStart = source.indexOf('<ScheduleSendPicker', leftActionsStart);
    const sendStart = source.lastIndexOf('{sendButton}', scheduleStart);

    expect(footerStart).toBeGreaterThanOrEqual(0);
    expect(footerEnd).toBeGreaterThan(footerStart);
    expect(leftActionsStart).toBeGreaterThan(footerStart);
    expect(sendStart).toBeGreaterThan(leftActionsStart);
    expect(scheduleStart).toBeGreaterThan(sendStart);
    const leftActionTag = source.slice(leftActionsStart, source.indexOf('>', leftActionsStart));
    expect(leftActionTag).toContain('flex-wrap');
    expect(source.slice(leftActionsStart, scheduleStart)).not.toContain('isReplyComposer');
    const footer = source.slice(footerStart, footerEnd);
    expect(footer.match(/\{sendButton\}/g) ?? []).toHaveLength(1);
    expect(footer).not.toContain('isReplyComposer');
    expect(source).not.toContain('isReplyComposer');
    expect(source).not.toContain('replyingTo?:');
    expect(replyComposerSource).not.toContain('replyingTo=');
  });

  it('removes disabled composer AI controls while preserving draft input shape', () => {
    expect(source).not.toContain('handleAiGenerate');
    expect(source).not.toContain('handleGenerateSubject');
    expect(source).not.toContain('aiGeneratedMessage');
    expect(source).not.toContain('ContentPreview');
    expect(source).not.toContain('Sparkles');
    expect(source.match(/aiBlocked:\s*false/g)).toHaveLength(4);
  });
});
