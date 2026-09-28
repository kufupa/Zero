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

// Pattern A: "[EXT] FWD: 👍 John Doe reacted to your message:" or "👍 John Doe reacted to:"
const LEADING_EMOJI_REGEX = new RegExp(
  `^\\s*(?:\\[[^\\]]+\\]\\s*)*(?:(?:RE|FWD|FW):\\s*)*(${EMOJI_TOKEN})\\s+([^\\n\\r<:]+?)\\s+reacted to(?: your message)?:?`,
  'iu',
);

// Pattern B: "John Doe reacted to your message: 👍" or "John Doe reacted 👍 to your message:"
const TRAILING_EMOJI_REGEX = new RegExp(
  `(?:\\[[^\\]]+\\]\\s*)*(?:(?:RE|FWD|FW):\\s*)*([^\\n\\r<:]+?)\\s+reacted\\s+(${EMOJI_TOKEN})\\s+to(?: your message)?:?|([^\\n\\r<:]+?)\\s+reacted to(?: your message)?:?\\s*(${EMOJI_TOKEN})`,
  'iu',
);



/**
 * Strip HTML tags and entities for plaintext regex inspection.
 */
export function htmlToPlainText(html: string): string {
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
  const bodyText = rawText || textFromHtml;
  const candidateText = [subject?.trim(), bodyText].filter(Boolean).join('\n');

  if (!candidateText) return notReaction;

  let emoji: string | null = null;
  let reactorName: string | null = null;

  // Check Leading Emoji Pattern: "[EXT] 👍 John Doe reacted to your message:"
  const leadingMatch = candidateText.match(LEADING_EMOJI_REGEX);
  let trailingMatch: RegExpMatchArray | null = null;
  if (leadingMatch) {
    emoji = leadingMatch[1];
    reactorName = leadingMatch[2].trim();
  } else {
    // Check Trailing Emoji Pattern: "John Doe reacted to your message: 👍" or "John Doe reacted 👍 to your message:"
    trailingMatch = candidateText.match(TRAILING_EMOJI_REGEX);
    if (trailingMatch) {
      reactorName = (trailingMatch[1] || trailingMatch[3])?.trim() || null;
      emoji = trailingMatch[2] || trailingMatch[4] || null;
    } else if (
      candidateText.toLowerCase().includes('reacted to')
    ) {
      // Fallback emoji search
      const emojiMatch = candidateText.match(EMOJI_REGEX);
      if (emojiMatch) {
        emoji = emojiMatch[0];
      }
      // Try to extract name before "reacted"
      const nameMatch = candidateText.match(/([^\n\r<:]+?)\s+reacted to/i);
      if (nameMatch) {
        reactorName = nameMatch[1].replace(EMOJI_REGEX, '').trim();
      }
    }
  }

  if (!emoji) {
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

  // Extract snippet after "reacted to your message:" or "reacted to:"
  let quotedSnippet: string | null = null;
  const subjectMatch = subject ? subject.match(/reacted to(?: your message)?:?\s*(.*)$/i) : null;
  const bodyMatch = bodyText.match(/reacted to(?: your message)?:?\s*([\s\S]*)$/i);
  let rawSnippetCandidate: string | null = null;

  if (subjectMatch && subjectMatch[1]?.trim()) {
    rawSnippetCandidate = subjectMatch[1].trim();
  } else if (bodyMatch && bodyMatch[1]?.trim()) {
    rawSnippetCandidate = bodyMatch[1].trim();
  } else if (subjectMatch && bodyText) {
    rawSnippetCandidate = bodyText;
  }

  if (rawSnippetCandidate) {
    let remainder = rawSnippetCandidate.trim();
    if (emoji && remainder.startsWith(emoji)) {
      remainder = remainder.slice(emoji.length).trim();
    }
    const quotedMatch = remainder.match(/^["'“”]([\s\S]+?)["'“”]/);
    if (quotedMatch) {
      quotedSnippet = quotedMatch[1].trim();
    } else {
      quotedSnippet = remainder.replace(/^["'“”]\s*/, '').replace(/\s*["'“”]$/, '').trim();
    }
    if (quotedSnippet && quotedSnippet.length > 300) {
      quotedSnippet = quotedSnippet.slice(0, 300) + '...';
    }
    if (!quotedSnippet) {
      quotedSnippet = null;
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

export const parseInboundReactionEmail = parseInboundReaction;
