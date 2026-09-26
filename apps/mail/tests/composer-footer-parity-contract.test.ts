import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../components/create/email-composer.tsx', import.meta.url),
  'utf8',
);
const replyComposerSource = readFileSync(
  new URL('../components/mail/reply-composer.tsx', import.meta.url),
  'utf8',
);

describe('composer footer parity', () => {
  it('keeps Send, Send later, Add, and formatting in DOM order in one wrapping shared action row', () => {
    const footerStart = source.indexOf('{/* Bottom Actions */}');
    const footerEnd = source.indexOf('<Dialog open={showLeaveConfirmation}', footerStart);
    const leftActionsStart = source.indexOf(
      '<div className="flex flex-wrap items-center justify-start gap-2">',
      footerStart,
    );
    const scheduleStart = source.indexOf('<ScheduleSendPicker', leftActionsStart);
    const sendStart = source.lastIndexOf('{sendButton}', scheduleStart);
    const addStart = source.indexOf('onClick={() => fileInputRef.current?.click()}', scheduleStart);
    const formattingStart = source.indexOf(
      'onClick={() => setToggleToolbar(!toggleToolbar)}',
      addStart,
    );

    expect(footerStart).toBeGreaterThanOrEqual(0);
    expect(footerEnd).toBeGreaterThan(footerStart);
    expect(leftActionsStart).toBeGreaterThan(footerStart);
    expect(sendStart).toBeGreaterThan(leftActionsStart);
    expect(scheduleStart).toBeGreaterThan(sendStart);
    expect(addStart).toBeGreaterThan(scheduleStart);
    expect(formattingStart).toBeGreaterThan(addStart);
    const footer = source.slice(footerStart, footerEnd);
    expect(footer.match(/\{sendButton\}/g) ?? []).toHaveLength(1);
    expect(footer).not.toContain('tabIndex={-1}');
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

  it('uses theme-aware foreground tokens for the Review & Send CTA content', () => {
    const sendButtonStart = source.indexOf('const sendButton =');
    const sendButtonEnd = source.indexOf('\n\n  return (', sendButtonStart);
    const sendButton = source.slice(sendButtonStart, sendButtonEnd);

    expect(sendButtonStart).toBeGreaterThanOrEqual(0);
    expect(sendButtonEnd).toBeGreaterThan(sendButtonStart);
    expect(sendButton).toContain('text-primary-foreground');
    expect(sendButton).toContain('fill-primary-foreground');
    expect(sendButton).not.toMatch(/(?:text|fill)-white\b/);
  });
});
