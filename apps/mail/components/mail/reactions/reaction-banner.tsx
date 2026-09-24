import React from 'react';
import type { ParsedMessage } from '@/types';
import { cn } from '@/lib/utils';

export interface ReactionBannerInfo {
  isReaction: boolean;
  emoji: string;
  reactorName: string;
  quotedSnippet?: string;
}

const EMOJI_TOKEN =
  '(?:[\\u{1F300}-\\u{1FAFF}]|[\\u{2600}-\\u{27BF}])(?:\\uFE0F)?(?:[\\u{1F3FB}-\\u{1F3FF}])?';

const LEADING_EMOJI_REGEX = new RegExp(
  `^\\s*(${EMOJI_TOKEN})\\s+([^\\n\\r<:]+?)\\s+reacted to your message:?`,
  'iu',
);

const TRAILING_EMOJI_REGEX = new RegExp(
  `([^\\n\\r<:]+?)\\s+reacted to your message:?\\s*(${EMOJI_TOKEN})`,
  'iu',
);

/**
 * Strips HTML tags and entities for plaintext scanning.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .trim();
}

/**
 * Inspects a message to see if it is an Outlook fallback reaction notification.
 */
export function detectReactionNotification(emailData: ParsedMessage): ReactionBannerInfo | null {
  const text = (emailData.body ?? '').trim();
  const htmlText = emailData.decodedBody ? stripHtml(emailData.decodedBody) : '';
  const candidate = text || htmlText;

  if (!candidate || !candidate.toLowerCase().includes('reacted to your message')) {
    return null;
  }

  let emoji: string | null = null;
  let reactorName: string | null = null;

  const leading = candidate.match(LEADING_EMOJI_REGEX);
  if (leading) {
    emoji = leading[1];
    reactorName = leading[2].trim();
  } else {
    const trailing = candidate.match(TRAILING_EMOJI_REGEX);
    if (trailing) {
      reactorName = trailing[1].trim();
      emoji = trailing[2];
    }
  }

  if (!emoji) return null;

  // Fallback to sender name if regex missed it
  if (!reactorName) {
    reactorName = emailData.sender.name || emailData.sender.email;
  }

  // Quoted snippet extraction
  let quotedSnippet: string | undefined;
  const marker = 'reacted to your message:';
  const idx = candidate.indexOf(marker);
  if (idx !== -1) {
    const rest = candidate.slice(idx + marker.length).trim();
    if (rest) {
      quotedSnippet = rest.replace(/^["'“”]\s*/, '').replace(/\s*["'“”]$/, '').trim();
      if (quotedSnippet.length > 250) {
        quotedSnippet = quotedSnippet.slice(0, 250) + '...';
      }
    }
  }

  return {
    isReaction: true,
    emoji,
    reactorName,
    quotedSnippet,
  };
}

interface ReactionBannerProps {
  emoji: string;
  reactorName: string;
  quotedSnippet?: string;
  className?: string;
}

/**
 * Warm amber callout banner matching Microsoft Outlook reaction notifications (Screenshot 2).
 */
export const ReactionBanner: React.FC<ReactionBannerProps> = ({
  emoji,
  reactorName,
  quotedSnippet,
  className,
}) => {
  return (
    <div
      role="status"
      aria-label={`${reactorName} reacted with ${emoji} to your message`}
      className={cn(
        'my-3 flex items-start gap-3 rounded-md border border-[#FDE68A] bg-[#FFF4CE] p-3 text-sm text-[#78350F] shadow-sm dark:border-[#785416] dark:bg-[#3D3114] dark:text-[#FDE68A]',
        className,
      )}
    >
      <span className="select-none text-2xl leading-none" aria-hidden="true">
        {emoji}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          <span className="font-semibold text-[#92400E] dark:text-[#FBBF24]">{reactorName}</span>{' '}
          reacted to your message:
        </div>
        {quotedSnippet && (
          <blockquote className="mt-1.5 border-l-2 border-[#F59E0B] pl-2.5 text-xs italic text-[#92400E] line-clamp-3 dark:border-[#B45309] dark:text-[#FCD34D]">
            {quotedSnippet}
          </blockquote>
        )}
      </div>
    </div>
  );
};

export default ReactionBanner;
