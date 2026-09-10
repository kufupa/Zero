/**
 * Parser for inbound Outlook / Exchange reaction notification fallback emails.
 *
 * When an Outlook user reacts to an email, external or fallback recipients
 * receive an email notification like:
 *   Subject: Re: <Original Subject>
 *   Body: 👍 John Doe reacted to your message:
 *         "<Quoted message snippet>"
 */

export interface InboundReactionInfo {
  isReaction: boolean;
  emoji: string | null;
  reactorName: string | null;
  reactorEmail: string | null;
  quotedSnippet: string | null;
}

export const OUTLOOK_REACTION_EMOJIS = ['👍', '❤️', '🎉', '😆', '😮', '😢'];

const EMOJI_TOKEN =
  '(?:[\\u{1F300}-\\u{1FAFF}]|[\\u{2600}-\\u{27BF}])(?:\\uFE0F)?(?:[\\u{1F3FB}-\\u{1F3FF}])?';
const EMOJI_REGEX = new RegExp(EMOJI_TOKEN, 'u');

// Pattern A: "👍 John Doe reacted to your message:" -> match[1]=emoji, match[2]=name
const LEADING_EMOJI_REGEX = new RegExp(
  `^\\s*(${EMOJI_TOKEN})\\s+([^\\n\\r<:]+?)\\s+reacted to your message:?`,
  'iu',
);

// Pattern B: "John Doe reacted to your message: 👍" -> match[1]=name, match[2]=emoji
const TRAILING_EMOJI_REGEX = new RegExp(
  `([^\\n\\r<:]+?)\\s+reacted to your message:?\\s*(${EMOJI_TOKEN})`,
  'iu',
);

// Pattern C: HTML container with reaction indicator
const HTML_REACTION_REGEX = new RegExp(
  `(?:id=["'](?:reaction|ms-reaction)["']|class=["'][^"']*reaction[^"']*["'])[^>]*>[\\s\\S]*?(${EMOJI_TOKEN})`,
  'iu',
);

/**
 * Strip HTML tags and entities for plaintext regex inspection.
 */
function htmlToPlainText(html: string): string {
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
 * Parse an email for Outlook reaction notifications.
 */
export function parseInboundReaction(
  subject?: string | null,
  textBody?: string | null,
  htmlBody?: string | null,
  fromAddress?: string | null,
): InboundReactionInfo {
  const notReaction: InboundReactionInfo = {
    isReaction: false,
    emoji: null,
    reactorName: null,
    reactorEmail: null,
    quotedSnippet: null,
  };

  const rawText = (textBody ?? '').trim();
  const textFromHtml = htmlBody ? htmlToPlainText(htmlBody) : '';
  const candidateText = rawText || textFromHtml;

  if (!candidateText && !htmlBody) return notReaction;

  let emoji: string | null = null;
  let reactorName: string | null = null;

  // Check Leading Emoji Pattern: "👍 John Doe reacted to your message:"
  const leadingMatch = candidateText.match(LEADING_EMOJI_REGEX);
  if (leadingMatch) {
    emoji = leadingMatch[1];
    reactorName = leadingMatch[2].trim();
  } else {
    // Check Trailing Emoji Pattern: "John Doe reacted to your message: 👍"
    const trailingMatch = candidateText.match(TRAILING_EMOJI_REGEX);
    if (trailingMatch) {
      reactorName = trailingMatch[1].trim();
      emoji = trailingMatch[2] || trailingMatch[3];
    } else if (
      candidateText.toLowerCase().includes('reacted to your message') ||
      (subject && /reacted to your message/i.test(subject))
    ) {
      // Fallback emoji search
      const emojiMatch = candidateText.match(EMOJI_REGEX);
      if (emojiMatch) {
        emoji = emojiMatch[0];
      }
      // Try to extract name before "reacted"
      const nameMatch = candidateText.match(/([^\n\r<:]+?)\s+reacted to your message/i);
      if (nameMatch) {
        reactorName = nameMatch[1].replace(EMOJI_REGEX, '').trim();
      }
    }
  }

  if (!emoji && htmlBody) {
    const htmlMatch = htmlBody.match(HTML_REACTION_REGEX);
    if (htmlMatch) {
      emoji = htmlMatch[1];
    }
  }

  if (!emoji || !candidateText.toLowerCase().includes('reacted to your message')) {
    return notReaction;
  }

  // Parse reactor email from fromAddress if available
  let reactorEmail: string | null = null;
  if (fromAddress) {
    const angleMatch = fromAddress.match(/<([^>]+)>/);
    reactorEmail = angleMatch ? angleMatch[1].trim() : fromAddress.trim();
    if (!reactorName) {
      const nameMatch = fromAddress.match(/^([^<]+)</);
      if (nameMatch) {
        reactorName = nameMatch[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  // Extract snippet after "reacted to your message:"
  let quotedSnippet: string | null = null;
  const splitIndex = candidateText.indexOf('reacted to your message:');
  if (splitIndex !== -1) {
    const remainder = candidateText.slice(splitIndex + 'reacted to your message:'.length).trim();
    if (remainder) {
      // Remove surrounding quotes
      quotedSnippet = remainder.replace(/^["'“”]\s*/, '').replace(/\s*["'“”]$/, '').trim();
      // Cap at reasonable snippet length
      if (quotedSnippet.length > 300) {
        quotedSnippet = quotedSnippet.slice(0, 300) + '...';
      }
    }
  }

  return {
    isReaction: true,
    emoji,
    reactorName: reactorName || 'Someone',
    reactorEmail,
    quotedSnippet,
  };
}
