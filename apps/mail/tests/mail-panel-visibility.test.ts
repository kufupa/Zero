import { describe, expect, it } from 'vitest';
import {
  shouldShowDesktopListPanel,
  shouldShowDesktopThreadPanel,
  shouldShowMailSplitHandle,
} from '../lib/mail/mail-panel-visibility';

describe('mail panel visibility', () => {
  describe('shouldShowDesktopThreadPanel', () => {
    it('never shows desktop thread below md', () => {
      expect(
        shouldShowDesktopThreadPanel({
          isDesktop: false,
          isWideSplit: false,
          threadId: 't1',
        }),
      ).toBe(false);
    });

    it('mid-width with threadId shows thread', () => {
      expect(
        shouldShowDesktopThreadPanel({
          isDesktop: true,
          isWideSplit: false,
          threadId: 't1',
        }),
      ).toBe(true);
    });

    it('mid-width without threadId hides thread (close-to-inbox)', () => {
      expect(
        shouldShowDesktopThreadPanel({
          isDesktop: true,
          isWideSplit: false,
          threadId: null,
        }),
      ).toBe(false);
    });

    it('wide split always shows thread even with null selection', () => {
      expect(
        shouldShowDesktopThreadPanel({
          isDesktop: true,
          isWideSplit: true,
          threadId: null,
        }),
      ).toBe(true);
    });
  });

  describe('shouldShowDesktopListPanel', () => {
    it('never shows desktop list below md', () => {
      expect(
        shouldShowDesktopListPanel({
          isDesktop: false,
          isWideSplit: false,
          threadId: null,
        }),
      ).toBe(false);
    });

    it('mid-width with threadId hides list', () => {
      expect(
        shouldShowDesktopListPanel({
          isDesktop: true,
          isWideSplit: false,
          threadId: 't1',
        }),
      ).toBe(false);
    });

    it('mid-width without threadId shows list', () => {
      expect(
        shouldShowDesktopListPanel({
          isDesktop: true,
          isWideSplit: false,
          threadId: null,
        }),
      ).toBe(true);
    });

    it('wide split always shows list', () => {
      expect(
        shouldShowDesktopListPanel({
          isDesktop: true,
          isWideSplit: true,
          threadId: 't1',
        }),
      ).toBe(true);
    });
  });

  describe('shouldShowMailSplitHandle', () => {
    it('hides handle when not wide split', () => {
      expect(
        shouldShowMailSplitHandle({
          isWideSplit: false,
          listCollapsed: false,
          threadMounted: true,
          listMounted: true,
        }),
      ).toBe(false);
    });

    it('hides handle when list collapsed', () => {
      expect(
        shouldShowMailSplitHandle({
          isWideSplit: true,
          listCollapsed: true,
          threadMounted: true,
          listMounted: true,
        }),
      ).toBe(false);
    });

    it('hides handle when only one panel mounted', () => {
      expect(
        shouldShowMailSplitHandle({
          isWideSplit: true,
          listCollapsed: false,
          threadMounted: true,
          listMounted: false,
        }),
      ).toBe(false);
    });

    it('shows handle when wide split and both panels expanded', () => {
      expect(
        shouldShowMailSplitHandle({
          isWideSplit: true,
          listCollapsed: false,
          threadMounted: true,
          listMounted: true,
        }),
      ).toBe(true);
    });
  });
});
