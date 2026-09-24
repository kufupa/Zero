/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QuoteHistoryExpander } from '../components/create/quote-history-expander';
import { ReactionPicker } from '../components/mail/reactions/reaction-picker';
import { ReactionBadges } from '../components/mail/reactions/reaction-badges';
import { ReactionBanner } from '../components/mail/reactions/reaction-banner';
import { constructOutlookReplyHtml } from '../lib/mail/outlook-quote-formatter';
import { formatMessageHeaderDate } from '../lib/utils';
import type { ParsedMessage } from '@/types';

// Stable timezone mock
vi.mock('../hooks/use-timezone', () => ({
  useTimezone: () => 'Africa/Johannesburg',
}));

describe('Suite 4 & 5: Cross-Feature Integration & Theme/Accessibility Battery', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const fullMessage: ParsedMessage = {
    id: 'msg-integrated-100',
    title: 'Booking Inquiry - Centurion Suite',
    subject: 'Booking Inquiry - Centurion Suite',
    tags: [],
    sender: { name: 'VIP Guest', email: 'vip@travel.com' },
    to: [{ name: 'Centurion Hotel', email: 'centurion@legacyhotel.com' }],
    cc: [{ name: 'Concierge', email: 'concierge@legacyhotel.com' }],
    bcc: null,
    tls: true,
    receivedOn: '2026-09-09T14:30:00.000Z',
    unread: false,
    body: 'Can we arrange airport transfer for 3pm?',
    decodedBody: '<p>Can we arrange airport transfer for 3pm?</p>',
    processedHtml: '<p>Can we arrange airport transfer for 3pm?</p>',
    blobUrl: '',
    reactions: [
      {
        emoji: '👍',
        count: 1,
        hasReacted: true,
        users: [{ email: 'staff@legacyhotel.com', userName: 'Front Desk' }],
      },
    ],
  };

  describe('Suite 4: End-to-End User Flow', () => {
    it('integrates timezone formatting, wire quoting, and compose expansion seamlessly', () => {
      // 1. Check header date in South Africa time (14:30 UTC -> 4:30 PM SAST)
      const headerDate = formatMessageHeaderDate(fullMessage.receivedOn, 'Africa/Johannesburg');
      expect(headerDate.display).toBe('Wed 9/9/2026 4:30 PM');

      // 2. Construct reply HTML with Outlook styling
      const replyHtml = constructOutlookReplyHtml(fullMessage, {
        isForward: false,
        userTimezone: 'Africa/Johannesburg',
      });
      expect(replyHtml).toContain('id="divRplyFwdMsg"');
      expect(replyHtml).toContain('Wednesday, September 9, 2026 4:30 PM');
      expect(replyHtml).toContain('VIP Guest &lt;vip@travel.com&gt;');

      // 3. Mount QuoteHistoryExpander in Composer with stateful wrapper
      const onExclude = vi.fn();
      function ExpanderHarness() {
        const [excluded, setExcluded] = useState(false);
        return (
          <TooltipProvider>
            <QuoteHistoryExpander
              replyToMessage={fullMessage}
              isExcluded={excluded}
              onExcludeChange={(val) => {
                setExcluded(val);
                onExclude(val);
              }}
            />
          </TooltipProvider>
        );
      }

      render(<ExpanderHarness />);

      // Verify collapsed initial state with Outlook tooltip
      const expandBtn = screen.getByRole('button', {
        name: /expand header and show message history/i,
      });
      expect(expandBtn).toBeDefined();

      // Expand history
      fireEvent.click(expandBtn);
      expect(screen.getByText(/Message History/i)).toBeDefined();
      expect(screen.getByText(/VIP Guest/)).toBeDefined();

      // Click "Remove quote"
      const removeBtn = screen.getByRole('button', { name: /remove quote/i });
      fireEvent.click(removeBtn);
      expect(onExclude).toHaveBeenCalledWith(true);

      // Verify Undo button restores quote
      const undoBtn = screen.getByRole('button', { name: /undo/i });
      fireEvent.click(undoBtn);
      expect(onExclude).toHaveBeenCalledWith(false);
    });
  });

  describe('Suite 5: Visual Accessibility & Theme Compliance', () => {
    it('verifies ARIA roles across all reaction and quoting components', () => {
      render(
        <TooltipProvider>
          <div>
            <ReactionBanner
              emoji="👍"
              reactorName="General Manager"
              quotedSnippet="Approved"
            />
            <ReactionBadges
              reactions={fullMessage.reactions}
              onToggleReaction={vi.fn()}
            />
            <ReactionPicker
              onSelectEmoji={vi.fn()}
              activeEmojis={['👍']}
            />
          </div>
        </TooltipProvider>,
      );

      // Banner role
      const banner = screen.getByRole('status');
      expect(banner).toBeDefined();
      expect(banner.getAttribute('aria-label')).toContain('General Manager reacted with 👍');

      // Badges group role
      const badgesGroup = screen.getByRole('group', { name: /message reactions/i });
      expect(badgesGroup).toBeDefined();

      // Picker button
      const pickerBtn = screen.getByRole('button', { name: /add reaction/i });
      expect(pickerBtn).toBeDefined();
    });

    it('verifies keyboard interaction with expander button via Enter and Space', () => {
      render(
        <TooltipProvider>
          <QuoteHistoryExpander replyToMessage={fullMessage} />
        </TooltipProvider>,
      );

      const expandBtn = screen.getByRole('button', {
        name: /expand header and show message history/i,
      });

      // Press Enter to expand
      fireEvent.keyDown(expandBtn, { key: 'Enter', code: 'Enter' });
      expect(screen.getByText(/Message History/i)).toBeDefined();

      // Press Space on "Hide history"
      const hideBtn = screen.getByRole('button', { name: /hide history/i });
      fireEvent.keyDown(hideBtn, { key: ' ', code: 'Space' });
      expect(screen.queryByText(/Message History/i)).toBeNull();
    });
  });
});
