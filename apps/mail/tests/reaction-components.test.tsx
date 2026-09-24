/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  ReactionPicker,
  OUTLOOK_REACTIONS,
} from '../components/mail/reactions/reaction-picker';
import { ReactionBadges } from '../components/mail/reactions/reaction-badges';
import type { MessageReactionGroup } from '@/types';

describe('ReactionPicker (Outlook Emojis Parity)', () => {
  it('renders trigger button and provides 6 Outlook emojis upon opening', () => {
    const handleSelect = vi.fn();
    render(
      <TooltipProvider>
        <ReactionPicker onSelectEmoji={handleSelect} activeEmojis={['👍']} />
      </TooltipProvider>,
    );

    const trigger = screen.getByRole('button', { name: /add reaction/i });
    expect(trigger).toBeDefined();

    // Click trigger to open popover
    fireEvent.click(trigger);

    // Verify all 6 Outlook reactions are rendered
    for (const { label } of OUTLOOK_REACTIONS) {
      const emojiBtn = screen.getByRole('button', { name: label });
      expect(emojiBtn).toBeDefined();
    }

    // Click on Love (Heart)
    const heartBtn = screen.getByRole('button', { name: /love/i });
    fireEvent.click(heartBtn);
    expect(handleSelect).toHaveBeenCalledWith('❤️');
  });
});

describe('ReactionBadges (Screenshot 1 Pill Badges)', () => {
  it('returns null when reactions list is empty or zero counts', () => {
    const handleToggle = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <ReactionBadges reactions={[]} onToggleReaction={handleToggle} />
      </TooltipProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders pill badges with emoji and count', () => {
    const handleToggle = vi.fn();
    const reactions: MessageReactionGroup[] = [
      {
        emoji: '👍',
        count: 2,
        hasReacted: true,
        users: [
          { userId: 'u1', email: 'alice@example.com', userName: 'Alice' },
          { userId: 'u2', email: 'bob@example.com', userName: 'Bob' },
        ],
      },
      {
        emoji: '🎉',
        count: 1,
        hasReacted: false,
        users: [{ userId: 'u3', email: 'charlie@example.com', userName: 'Charlie' }],
      },
    ];

    render(
      <TooltipProvider>
        <ReactionBadges reactions={reactions} onToggleReaction={handleToggle} />
      </TooltipProvider>,
    );

    const group = screen.getByRole('group', { name: /message reactions/i });
    expect(group).toBeDefined();

    // Check counts
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('1')).toBeDefined();

    // Click the 👍 toggle button
    const thumbsBtn = screen.getByRole('button', { name: /toggle 👍 reaction/i });
    fireEvent.click(thumbsBtn);
    expect(handleToggle).toHaveBeenCalledWith('👍');
  });
});
