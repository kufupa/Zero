import { isToday, isThisMonth, differenceInCalendarMonths, isThisYear } from 'date-fns';
import { getBrowserTimezone, isValidTimezone } from './timezones';
import { formatInTimeZone } from 'date-fns-tz';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Sender } from '@/types';
import LZString from 'lz-string';

export const FOLDERS = {
  SPAM: 'spam',
  INBOX: 'inbox',
  ARCHIVE: 'archive',
  BIN: 'bin',
  DRAFT: 'draft',
  SENT: 'sent',
  SNOOZED: 'snoozed',
} as const;

export const LABELS = {
  SPAM: 'SPAM',
  INBOX: 'INBOX',
  UNREAD: 'UNREAD',
  IMPORTANT: 'IMPORTANT',
  SENT: 'SENT',
  TRASH: 'TRASH',
  SNOOZED: 'SNOOZED',
} as const;

export const FOLDER_NAMES = [
  'inbox',
  'spam',
  'bin',
  'unread',
  'starred',
  'important',
  'sent',
  'archive',
  'draft',
] as const;

export const FOLDER_TAGS: Record<string, string[]> = {
  [FOLDERS.SPAM]: [LABELS.SPAM],
  [FOLDERS.INBOX]: [LABELS.INBOX],
  [FOLDERS.ARCHIVE]: [],
  [FOLDERS.SENT]: [LABELS.SENT],
  [FOLDERS.BIN]: [LABELS.TRASH],
  [FOLDERS.SNOOZED]: [LABELS.SNOOZED],
};

export const getFolderTags = (folder: string): string[] => {
  return FOLDER_TAGS[folder] || [];
};

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const getGravatarUrl = (_email: string, _size = 80) => {
  return '';
};

export const getInitial = (name?: string, email?: string) => {
  if (name) return name.charAt(0).toUpperCase();
  if (email) return email.charAt(0).toUpperCase();
  return '?';
};

export const compressText = (text: string): string => {
  return LZString.compressToEncodedURIComponent(text);
};

export const decompressText = (compressed: string): string => {
  return LZString.decompressFromEncodedURIComponent(compressed) || '';
};

export const getCookie = (key: string): string | null => {
  const cookies = Object.fromEntries(
    document.cookie.split('; ').map((v) => v.split(/=(.*)/s).map(decodeURIComponent)),
  );
  return cookies?.[key] ?? null;
};

/**
 * Resolves the effective IANA timezone for formatting dates:
 * 1. Explicit user setting from userSettings if valid and not 'UTC'.
 * 2. Detected browser timezone from Intl.DateTimeFormat.
 * 3. Fallback to 'Africa/Johannesburg' for Nava/Legacy Hotels pilot.
 */
export const resolveEffectiveTimezone = (
  configuredTimezone?: string | null,
  options?: { fallbackIfUtc?: boolean },
): string => {
  if (configuredTimezone && isValidTimezone(configuredTimezone)) {
    if (!options?.fallbackIfUtc || configuredTimezone !== 'UTC') {
      return configuredTimezone;
    }
  }
  try {
    const browserTz =
      typeof window !== 'undefined'
        ? getBrowserTimezone()
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserTz && isValidTimezone(browserTz) && (!options?.fallbackIfUtc || browserTz !== 'UTC')) {
      return browserTz;
    }
  } catch {
    // fallback if lookup fails
  }
  return 'Africa/Johannesburg';
};

/**
 * Robust ISO date parsing that guarantees UTC anchor if missing.
 */
export const parseAndValidateDate = (
  dateInput: string | Date | number | undefined | null,
): Date | null => {
  try {
    if (!dateInput && dateInput !== 0) {
      return null;
    }
    if (dateInput instanceof Date) {
      return isNaN(dateInput.getTime()) ? null : dateInput;
    }
    if (typeof dateInput === 'number') {
      const d = new Date(dateInput);
      return isNaN(d.getTime()) ? null : d;
    }
    const trimmed = String(dateInput).trim();
    if (!trimmed) {
      return null;
    }

    // If string has T but no timezone indicator (Z or + / - offset), anchor to UTC
    const hasTimezone = /Z|[+-]\d{2}(?::?\d{2})?$/i.test(trimmed);
    const normalized = !hasTimezone && trimmed.includes('T') ? `${trimmed}Z` : trimmed;

    const dateObj = new Date(normalized);
    if (isNaN(dateObj.getTime())) {
      return null;
    }
    return dateObj;
  } catch {
    return null;
  }
};

/**
 * Header Date & Time (Outlook Screenshot 3 parity):
 * Always returns full Date AND Time, e.g. "Wed 9/9/2026 2:00 PM".
 */
export const formatMessageHeaderDate = (
  dateInput: string | Date | number | undefined | null,
  timezone?: string,
): { display: string; tooltip: string } => {
  const dateObj = parseAndValidateDate(dateInput);
  if (!dateObj) {
    return { display: '', tooltip: '' };
  }

  const tz = timezone ? resolveEffectiveTimezone(timezone) : resolveEffectiveTimezone(undefined);
  try {
    const display = formatInTimeZone(dateObj, tz, 'EEE M/d/yyyy h:mm a');
    const tooltip = formatInTimeZone(dateObj, tz, "EEEE, MMMM d, yyyy 'at' h:mm:ss a (zzz)");
    return { display, tooltip };
  } catch (error) {
    console.error('Error formatting header date', error);
    return { display: '', tooltip: '' };
  }
};

/**
 * Thread List Date Formatting (replaces .split('.')[0]):
 */
export const formatThreadListDate = (
  dateInput: string | Date | number | undefined | null,
  timezone?: string,
): string => {
  const dateObj = parseAndValidateDate(dateInput);
  if (!dateObj) {
    return '';
  }

  const tz = resolveEffectiveTimezone(timezone);
  const now = new Date();

  try {
    // If today: 2:00 PM
    if (isToday(dateObj)) {
      return formatInTimeZone(dateObj, tz, 'h:mm a');
    }
    // If within last 6 days: Wed 2:00 PM
    const daysDiff = (now.getTime() - dateObj.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff < 6 && daysDiff > 0) {
      return formatInTimeZone(dateObj, tz, 'EEE h:mm a');
    }
    // If current year: Sep 9, 2:00 PM
    if (isThisYear(dateObj)) {
      return formatInTimeZone(dateObj, tz, 'MMM d, h:mm a');
    }
    // Older: 9/9/2026
    return formatInTimeZone(dateObj, tz, 'M/d/yyyy');
  } catch (error) {
    console.error('Error formatting thread list date', error);
    return '';
  }
};

/**
 * Helper function to determine if a separate time display is needed
 * Returns false for emails from today or within last 12 hours since formatDate already shows time for these
 */
export const shouldShowSeparateTime = (dateString: string | undefined): boolean => {
  if (!dateString) return false;

  const dateObj = parseAndValidateDate(dateString);
  if (!dateObj) return false;

  const now = new Date();

  // Don't show separate time if email is from today
  if (isToday(dateObj)) return false;

  // Don't show separate time if email is within the last 12 hours
  const hoursDifference = (now.getTime() - dateObj.getTime()) / (1000 * 60 * 60);
  if (hoursDifference <= 12) return false;

  // Show separate time for older emails
  return true;
};

/**
 * Formats a date with different formatting logic based on parameters
 * Overloaded to handle both mail date formatting and notes date formatting
 */
export function formatDate(dateInput: string | Date | number, configuredTimezone?: string): string {
  const dateObj = parseAndValidateDate(dateInput);
  if (!dateObj) {
    return '';
  }

  // Notes formatting logic (when date is a Date object)
  if (dateInput instanceof Date) {
    return dateInput.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  try {
    const timezone = resolveEffectiveTimezone(configuredTimezone);
    const now = new Date();

    // If it's today, always show the time
    if (isToday(dateObj)) {
      return formatInTimeZone(dateObj, timezone, 'h:mm a');
    }

    // Calculate hours difference between now and the email date
    const hoursDifference = (now.getTime() - dateObj.getTime()) / (1000 * 60 * 60);

    // If it's not today but within the last 12 hours, show the time
    if (hoursDifference <= 12) {
      return formatInTimeZone(dateObj, timezone, 'h:mm a');
    }

    // If it's this month or last month, show the month and day
    if (isThisMonth(dateObj) || differenceInCalendarMonths(now, dateObj) === 1) {
      return formatInTimeZone(dateObj, timezone, 'MMM dd');
    }

    // Otherwise show the date in MM/DD/YY format
    return formatInTimeZone(dateObj, timezone, 'MM/dd/yy');
  } catch (error) {
    console.error('Error formatting date', error);
    return '';
  }
}

export function formatDateWithWeekdayAndTime(
  dateInput: string | Date | number,
  configuredTimezone?: string,
): string {
  const dateObj = parseAndValidateDate(dateInput);
  if (!dateObj) {
    return '';
  }

  try {
    const timezone = resolveEffectiveTimezone(configuredTimezone);
    return formatInTimeZone(dateObj, timezone, 'EEE MMMM d HH:mm');
  } catch (error) {
    console.error('Error formatting date with weekday and time', error);
    return '';
  }
}

export const formatTime = (date: string, configuredTimezone?: string) => {
  const dateObj = parseAndValidateDate(date);
  if (!dateObj) {
    return '';
  }

  try {
    const timezone = resolveEffectiveTimezone(configuredTimezone);
    return formatInTimeZone(dateObj, timezone, 'h:mm a');
  } catch (error) {
    console.error('Error formatting time', error);
    return '';
  }
};

export const cleanEmailAddress = (email: string = '') => {
  return email.replace(/[<>]/g, '').trim();
};

export const truncateFileName = (name: string, maxLength = 15) => {
  if (name.length <= maxLength) return name;
  const extIndex = name.lastIndexOf('.');
  if (extIndex !== -1 && name.length - extIndex <= 5) {
    return `${name.slice(0, maxLength - 5)}...${name.slice(extIndex)}`;
  }
  return `${name.slice(0, maxLength)}...`;
};

export const extractFilterValue = (filter: string): string => {
  if (!filter || !filter.includes(':')) return '';

  const colonIndex = filter.indexOf(':');
  const value = filter.substring(colonIndex + 1);

  return value || '';
};

export const defaultPageSize = 20;

export function createSectionId(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const getFileIcon = (mimeType: string): string => {
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '📊';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    return '📝';
  if (mimeType.includes('image')) return ''; // Empty for images as they're handled separately
  return '📎'; // Default icon
};

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

function jsonStringField(obj: JsonObject, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

export const convertJSONToHTML = (json: JsonValue): string => {
  if (!json) return '';

  // Handle different types
  if (typeof json === 'string') return json;
  if (typeof json === 'number' || typeof json === 'boolean') return json.toString();
  if (json === null) return '';

  // Handle arrays
  if (Array.isArray(json)) {
    return json.map((item) => convertJSONToHTML(item)).join('');
  }

  // Handle objects (assuming they might have specific email content structure)
  if (typeof json === 'object') {
    // Check if it's a text node
    if (json.type === 'text') {
      let text = jsonStringField(json, 'text');

      // Apply formatting if present
      if (json.bold) text = `<strong>${text}</strong>`;
      if (json.italic) text = `<em>${text}</em>`;
      if (json.underline) text = `<u>${text}</u>`;
      if (json.code) text = `<code>${text}</code>`;

      return text;
    }

    // Handle paragraph
    if (json.type === 'paragraph') {
      return `<p>${convertJSONToHTML(json.children)}</p>`;
    }

    // Handle headings
    const nodeType = jsonStringField(json, 'type');
    if (nodeType.startsWith('heading-')) {
      const level = nodeType.split('-')[1];
      return `<h${level}>${convertJSONToHTML(json.children)}</h${level}>`;
    }

    // Handle lists
    if (json.type === 'bulleted-list') {
      return `<ul>${convertJSONToHTML(json.children)}</ul>`;
    }

    if (json.type === 'numbered-list') {
      return `<ol>${convertJSONToHTML(json.children)}</ol>`;
    }

    if (json.type === 'list-item') {
      return `<li>${convertJSONToHTML(json.children)}</li>`;
    }

    // Handle links
    if (json.type === 'link') {
      return `<a href="${json.url}">${convertJSONToHTML(json.children)}</a>`;
    }

    // Handle images
    if (json.type === 'image') {
      return `<img src="${json.url}" alt="${json.alt || ''}" />`;
    }

    // Handle blockquote
    if (json.type === 'block-quote') {
      return `<blockquote>${convertJSONToHTML(json.children)}</blockquote>`;
    }

    // Handle code blocks
    if (json.type === 'code-block') {
      return `<pre><code>${convertJSONToHTML(json.children)}</code></pre>`;
    }

    // If it has children property, process it
    if (json.children) {
      return convertJSONToHTML(json.children);
    }

    // Process all other properties
    return Object.values(json)
      .map((value) => convertJSONToHTML(value))
      .join('');
  }

  return '';
};

export const getEmailLogo = (email: string) => {
  if (!import.meta.env.VITE_PUBLIC_IMAGE_API_URL) return '';
  return import.meta.env.VITE_PUBLIC_IMAGE_API_URL + email;
};

export const generateConversationId = (): string => {
  return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
};

export const contentToHTML = (content: string) => `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin: 0; padding: 0;">
${content}
</body></html>`;

export { constructOutlookReplyHtml, formatOutlookHeaderDate } from './mail/outlook-quote-formatter';
import { constructOutlookReplyHtml } from './mail/outlook-quote-formatter';

export const constructReplyBody = (
  arg1: string | any,
  arg2?: string | Date | number,
  originalSender?: Sender | null,
  otherRecipients?: Sender[] | null,
  quotedMessage?: string | null,
  subject?: string | null,
  timezone?: string,
  ccRecipients?: Sender[] | null,
) => {
  if (arg1 && typeof arg1 === 'object' && ('sender' in arg1 || 'decodedBody' in arg1)) {
    const tz = typeof arg2 === 'string' ? arg2 : undefined;
    const body = typeof originalSender === 'string' ? (originalSender as string) : '';
    return constructOutlookReplyHtml(arg1, {
      isForward: false,
      userTimezone: tz,
      formattedMessage: body,
    });
  }

  return constructOutlookReplyHtml({
    formattedMessage: typeof arg1 === 'string' ? arg1 : '',
    originalDate: arg2 ?? '',
    originalSender,
    toRecipients: otherRecipients || [],
    ccRecipients,
    subject: subject || originalSender?.subject,
    quotedMessage: quotedMessage || '',
    isForward: false,
    timezone,
  });
};

export const constructForwardBody = (
  arg1: string | any,
  arg2?: string | Date | number,
  originalSender?: Sender | null,
  otherRecipients?: Sender[] | null,
  quotedMessage?: string | null,
  subject?: string | null,
  timezone?: string,
  ccRecipients?: Sender[] | null,
) => {
  if (arg1 && typeof arg1 === 'object' && ('sender' in arg1 || 'decodedBody' in arg1)) {
    const tz = typeof arg2 === 'string' ? arg2 : undefined;
    const body = typeof originalSender === 'string' ? (originalSender as string) : '';
    return constructOutlookReplyHtml(arg1, {
      isForward: true,
      userTimezone: tz,
      formattedMessage: body,
    });
  }

  return constructOutlookReplyHtml({
    formattedMessage: typeof arg1 === 'string' ? arg1 : '',
    originalDate: arg2 ?? '',
    originalSender,
    toRecipients: otherRecipients || [],
    ccRecipients,
    subject: subject || originalSender?.subject,
    quotedMessage: quotedMessage || '',
    isForward: true,
    timezone,
  });
};

export const getMainSearchTerm = (searchQuery: string): string => {
  // Don't highlight terms if this is a date-based search
  const datePatterns = [
    /emails?\s+from\s+(\w+)\s+(\d{4})/i, // "emails from [month] [year]"
    /emails?\s+from\s+(\w+)/i, // "emails from [month]"
    /emails?\s+from\s+(\d{4})/i, // "emails from [year]"
    /emails?\s+from\s+last\s+(\w+)/i, // "emails from last [time period]"
    /emails?\s+from\s+(\d+)\s+(\w+)\s+ago/i, // "emails from [X] [time period] ago"
  ];

  // If it's a date-based search, don't highlight anything
  for (const pattern of datePatterns) {
    if (searchQuery.match(pattern)) {
      return '';
    }
  }

  // Handle other natural language queries
  const naturalLanguageMatches = {
    'emails from': /emails?\s+from\s+(\w+)/i,
    'mail from': /mail\s+from\s+(\w+)/i,
    from: /\bfrom\s+(\w+)/i,
    to: /\bto\s+(\w+)/i,
    about: /\babout\s+(\w+)/i,
    regarding: /\bregarding\s+(\w+)/i,
  };

  // Try to match natural language patterns
  for (const [, pattern] of Object.entries(naturalLanguageMatches)) {
    const match = searchQuery.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  // If no natural language match, remove search operators and date-related terms
  const cleanedQuery = searchQuery
    .replace(/\b(from|to|subject|has|in|after|before):\s*/gi, '')
    .replace(/\b(is|has):\s*/gi, '')
    .replace(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
      '',
    )
    .replace(/\b\d{4}\b/g, '') // Remove 4-digit years
    .replace(/["']/g, '')
    .trim();

  // Split by spaces and get the first meaningful term
  const terms = cleanedQuery.split(/\s+/);
  return terms[0] || '';
};

export function parseNaturalLanguageSearch(query: string): string {
  // Common search patterns
  const patterns = [
    // From pattern
    {
      regex: /^from\s+([^:\s]+)/i,
      transform: (match: string[]) => `from:${match[1]}`,
    },
    // To pattern
    {
      regex: /^to\s+([^:\s]+)/i,
      transform: (match: string[]) => `to:${match[1]}`,
    },
    // Subject pattern
    {
      regex: /^subject\s+([^:\s]+)/i,
      transform: (match: string[]) => `subject:${match[1]}`,
    },
    // Has attachment pattern
    {
      regex: /^has\s+(attachment|file)/i,
      transform: () => 'has:attachment',
    },
    // Is pattern (unread, read, starred)
    {
      regex: /^is\s+(unread|read|starred)/i,
      transform: (match: string[]) => `is:${match[1]}`,
    },
  ];

  // Check if query matches any pattern
  for (const pattern of patterns) {
    const match = query.match(pattern.regex);
    if (match) {
      return pattern.transform(match);
    }
  }

  return query;
}

export function parseNaturalLanguageDate(query: string): { from?: Date; to?: Date } | null {
  const now = new Date();
  const currentYear = now.getFullYear();

  // Common date patterns
  const patterns = [
    // "emails from [month] [year]"
    {
      regex: /(?:emails?|mail)\s+from\s+(\w+)\s+(\d{4})/i,
      transform: (match: string[]) => {
        const monthNames = [
          'january',
          'february',
          'march',
          'april',
          'may',
          'june',
          'july',
          'august',
          'september',
          'october',
          'november',
          'december',
        ];
        const monthIndex = monthNames.findIndex((m) =>
          m.toLowerCase().startsWith(match[1]?.toLowerCase() ?? ''),
        );
        if (monthIndex === -1) return null;

        const year = parseInt(match[2] ?? currentYear.toString());
        const from = new Date(year, monthIndex, 1);
        const to = new Date(year, monthIndex + 1, 0); // Last day of the month
        return { from, to };
      },
    },
    // "emails from [month]" (assumes current year)
    {
      regex: /(?:emails?|mail)\s+from\s+(\w+)/i,
      transform: (match: string[]) => {
        const monthNames = [
          'january',
          'february',
          'march',
          'april',
          'may',
          'june',
          'july',
          'august',
          'september',
          'october',
          'november',
          'december',
        ];
        const monthIndex = monthNames.findIndex((m) =>
          m.toLowerCase().startsWith(match[1]?.toLowerCase() ?? ''),
        );
        if (monthIndex === -1) return null;

        const from = new Date(currentYear, monthIndex, 1);
        const to = new Date(currentYear, monthIndex + 1, 0); // Last day of the month
        return { from, to };
      },
    },
  ];

  // Check if query matches any pattern
  for (const pattern of patterns) {
    const match = query.match(pattern.regex);
    if (match) {
      const result = pattern.transform(match);
      if (result) {
        return result;
      }
    }
  }

  return null;
}

export const categorySearchValues = [
  'is:important NOT is:sent NOT is:draft',
  'NOT is:draft (is:inbox OR (is:sent AND to:me))',
  'is:personal NOT is:sent NOT is:draft',
  'is:updates NOT is:sent NOT is:draft',
  'is:promotions NOT is:sent NOT is:draft',
  'is:unread NOT is:sent NOT is:draft',
];

export const cleanSearchValue = (q: string): string => {
  const escapedValues = categorySearchValues.map((value) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  return q
    .replace(new RegExp(escapedValues.join('|'), 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const withExponentialBackoff = async <T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  initialDelay = 1000,
  maxDelay = 10000,
): Promise<T> => {
  let retries = 0;
  let delayMs = initialDelay;

  while (true) {
    try {
      return await operation();
    } catch (error: unknown) {
      const apiError = error as { code?: unknown; errors?: unknown };
      const errorEntries = Array.isArray(apiError.errors) ? apiError.errors : [];
      const firstError = errorEntries[0] as Record<string, unknown> | undefined;
      const reason = typeof firstError?.reason === 'string' ? firstError.reason : undefined;

      if (retries >= maxRetries) {
        throw error;
      }

      const isRateLimit =
        apiError.code === 429 ||
        reason === 'rateLimitExceeded' ||
        reason === 'userRateLimitExceeded';

      if (!isRateLimit) {
        throw error;
      }

      await delay(delayMs);

      delayMs = Math.min(delayMs * 2 + Math.random() * 1000, maxDelay);
      retries++;
    }
  }
};


