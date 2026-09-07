import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_CHIP_SCROLLPORT_CLASS,
  ATTACHMENT_CHIP_TRACK_CLASS,
  MAIL_DISPLAY_ROOT_CLASS,
  MAIL_DISPLAY_BODY_SHELL_CLASS,
  SCROLL_AREA_FLEX_MIN_W_CLASS,
  SCROLL_AREA_VIEWPORT_CONTENT_CLASS,
} from '../lib/attachment-chip-scroll';
import { readFileSync } from 'node:fs';

/**
 * Contract for Outlook-like one-row chip H-scroll.
 * Same-node `flex-nowrap` + `overflow-x-auto` does not shrink under flex parents —
 * outer scrollport + inner w-max track is required.
 */
describe('attachment chip scrollport contract', () => {
  it('scrollport owns overflow-x and can shrink (min-w-0); not a flex track', () => {
    expect(ATTACHMENT_CHIP_SCROLLPORT_CLASS).toMatch(/overflow-x-auto/);
    expect(ATTACHMENT_CHIP_SCROLLPORT_CLASS).toMatch(/min-w-0/);
    expect(ATTACHMENT_CHIP_SCROLLPORT_CLASS).toMatch(/\bw-full\b/);
    expect(ATTACHMENT_CHIP_SCROLLPORT_CLASS).not.toMatch(/flex-nowrap/);
    expect(ATTACHMENT_CHIP_SCROLLPORT_CLASS).not.toMatch(/\bw-max\b/);
  });

  it('track is w-max flex-nowrap and does not own overflow-x', () => {
    expect(ATTACHMENT_CHIP_TRACK_CLASS).toMatch(/\bflex\b/);
    expect(ATTACHMENT_CHIP_TRACK_CLASS).toMatch(/flex-nowrap/);
    expect(ATTACHMENT_CHIP_TRACK_CLASS).toMatch(/\bw-max\b/);
    expect(ATTACHMENT_CHIP_TRACK_CLASS).not.toMatch(/overflow-x/);
  });

  it('MailDisplay root clips x without overflow-hidden eating chip scrollbar', () => {
    expect(MAIL_DISPLAY_ROOT_CLASS).toMatch(/min-w-0/);
    expect(MAIL_DISPLAY_ROOT_CLASS).toMatch(/overflow-x-clip/);
    expect(MAIL_DISPLAY_ROOT_CLASS).not.toMatch(/overflow-hidden/);
  });

  it('MailDisplay body shell scrolls y and clips x with min-w-0', () => {
    expect(MAIL_DISPLAY_BODY_SHELL_CLASS).toMatch(/min-w-0/);
    expect(MAIL_DISPLAY_BODY_SHELL_CLASS).toMatch(/overflow-y-auto/);
    expect(MAIL_DISPLAY_BODY_SHELL_CLASS).toMatch(/overflow-x-clip/);
  });

  it('ScrollArea flex children advertise min-w-0 so chip scrollports can shrink', () => {
    expect(SCROLL_AREA_FLEX_MIN_W_CLASS).toMatch(/min-w-0/);
  });

  it('ScrollArea Viewport overrides Radix display:table child so wide mail cannot inflate pane', () => {
    expect(SCROLL_AREA_VIEWPORT_CONTENT_CLASS).toMatch(/\[&>div\]:!block/);
    expect(SCROLL_AREA_VIEWPORT_CONTENT_CLASS).toMatch(/\[&>div\]:min-w-0/);
    expect(SCROLL_AREA_VIEWPORT_CONTENT_CLASS).toMatch(/\[&>div\]:max-w-full/);
    const scrollAreaSource = readFileSync(
      new URL('../components/ui/scroll-area.tsx', import.meta.url),
      'utf8',
    );
    expect(scrollAreaSource).toContain('SCROLL_AREA_VIEWPORT_CONTENT_CLASS');
  });
});
