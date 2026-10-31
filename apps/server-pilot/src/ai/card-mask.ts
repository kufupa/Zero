/** Luhn PAN candidates: 13–19 digits with optional space/dash separators. `/g` is stateful. */
export const PAN_CANDIDATE_PATTERN = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;

/**
 * A security-code label and its 3–4 digit value: "CVV: 123", "CVC 1234", "security code 123". Only the value goes.
 * The gap never crosses a bracket, so a masked card token that follows a label stays whole. It may cross up to two
 * line breaks, as extracted PDF text puts a form label and its value on separate lines, but a later line holds no
 * letters before the value: a blank CVV field never takes the next line's labelled date, phone or reference.
 */
const SECURITY_CODE =
  /\b(cvv2?|cvc2?|cvn|csc|security\s+code)\b([^\d\n[\]]{0,16}?(?:\n[^\da-z\n[\]]{0,16}?){0,2})\d{3,4}(?!\d)/gi;

/**
 * A date-shaped group (2027-05-12, 12.05.2027, 12/05/2027) or a line break. A card or phone span never crosses one: a
 * date beside a card or phone stays, and a phone on one line is not joined to the next.
 */
const DATE_OR_BREAK = /((?<!\d)(?:\d{4}[-./]\d{2}[-./]\d{2}|\d{2}[-./]\d{2}[-./]\d{4})(?!\d)|\r\n|\n|\r)/;

export function isLuhnValid(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Replace Luhn-valid card numbers and security codes. A card span stops at a date, so 2027-11-01 2027-11-03 stays.
 * This masks text only, not original PDF/image bytes. Only the digits after a security-code label are replaced, so the label still says what was there.
 */
export function maskCardNumbers(text: string): string {
  return text
    .split(DATE_OR_BREAK)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(PAN_CANDIDATE_PATTERN, (match) => {
            const digits = match.replace(/[ -]/g, '');
            if (!isLuhnValid(digits)) return match;
            const tail = /[ -]$/.test(match) ? match.slice(-1) : '';
            return `[card ••••${digits.slice(-4)}]${tail}`;
          }),
    )
    .join('')
    .replace(SECURITY_CODE, (_match, label: string, gap: string) => `${label}${gap}[code masked]`);
}

/** Mask common card groupings across lines without joining unrelated room numbers. */
export function maskIncomingCardNumbers(text: string): string {
  const date = /((?<!\d)(?:(?:19\d{2}|20\d{2}|21\d{2}|2200)[-./]\d{2}[-./]\d{2}|\d{1,2}[-./]\d{1,2}[-./](?:19\d{2}|20\d{2}|21\d{2}|2200))(?!\d))/;
  const separator = '[ \\t\\r\\n-]{1,8}';
  // ponytail: common printed groupings only; unusual line splits need a stronger masker.
  const formats = [[4, 4, 4, 4], [4, 6, 5], [4, 4, 4, 4, 3], [4, 4, 4, 1]];
  const patterns = formats.map((groups) => new RegExp(`(?<!\\d)${groups.map((size) => `\\d{${size}}`).join(separator)}(?!\\d)`, 'g'));
  const mask = (match: string) => {
    const digits = match.replace(/\D/g, '');
    return isLuhnValid(digits) ? `[card ••••${digits.slice(-4)}]` : match;
  };
  return text.split(date).map((part, index) => {
    if (index % 2 === 1) return part;
    const contiguous = part.replace(/(?<!\d)\d{13,19}(?!\d)/g, mask);
    return maskCardNumbers(patterns.reduce((value, pattern) => value.replace(pattern, mask), contiguous));
  }).join('');
}

const EMAIL_ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;
/*
 * A phone span is digit groups joined by spaces or tabs, one dash or dot, or a closing bracket, with an optional leading +
 * and brackets around a group. Its edges are the text edge, whitespace, a bracket or closing punctuation, or a dash that
 * follows or precedes a word (Cell-082…). A digit, letter, dash or dot touching it otherwise means it is part of a longer
 * token, such as a reference. Joins are never across a line break.
 */
const EDGE_BEFORE = '(?:(?<![^\\s()[\\].,;:!?])|(?<=[A-Za-z]-))';
const EDGE_AFTER = '(?:(?![^\\s()[\\].,;:!?])|(?=-[A-Za-z]))';
const PHONE_SPAN = new RegExp(
  `${EDGE_BEFORE}\\+?\\(?\\d+\\)?(?:(?:[ \\t]+|[.-]|(?<=\\)))\\(?\\d+\\)?)*${EDGE_AFTER}`,
  'g',
);
const DIGIT_GROUP = /\+?\(?\d+\)?/g;
const digitsOf = (text: string) => text.replace(/\D/g, '');

/**
 * Masks the phone digits of one span. A single group of 7 or more digits is a phone on its own. In a span of several
 * groups, a window that starts with + or a trunk 0 and totals 9 to 15 digits is a phone. The rest of the span stays as
 * written, so 57291630-1 (no such window) is kept.
 */
function maskSpan(span: string): string {
  const groups = [...span.matchAll(DIGIT_GROUP)];
  if (groups.length === 1) return digitsOf(span).length >= 7 ? '[phone]' : span;
  const counts = groups.map((group) => digitsOf(group[0]).length);
  const phone = counts.map(() => false);
  groups.forEach((group, start) => {
    if (!/^\+|^\(?0/.test(group[0])) return;
    let total = 0;
    for (let end = start; end < groups.length; end += 1) {
      total += counts[end]!;
      if (total < 9) continue;
      if (total <= 15) for (let index = start; index <= end; index += 1) phone[index] = true;
      return;
    }
  });
  let out = '';
  let cursor = 0;
  for (let index = 0; index < groups.length; index += 1) {
    if (!phone[index]) continue;
    let last = index;
    while (last + 1 < groups.length && phone[last + 1]) last += 1;
    out += `${span.slice(cursor, groups[index]!.index)}[phone]`;
    cursor = groups[last]!.index! + groups[last]![0].length;
    index = last;
  }
  return out + span.slice(cursor);
}

/**
 * Replace e-mail addresses with [email] and phone numbers with [phone]. A phone is a single run of 7 or more digits, or a
 * span of digit groups that totals 9 to 15 digits from a + or a trunk 0. Mixed separators count: 082 555-1234,
 * (021) 555-1234 and +27 82 555-1234. A span stops at a date or a line break. Amounts, dates and dashed references such as
 * 57291630-1 stay. Run maskCardNumbers first (see maskMailText).
 */
export function maskContactDetails(text: string): string {
  return text
    .replace(EMAIL_ADDRESS, '[email]')
    .split(DATE_OR_BREAK)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(PHONE_SPAN, maskSpan)))
    .join('');
}

/** Every mail string that leaves the database for labelling or evals: card numbers, security codes, addresses, phones. */
export function maskMailText(text: string): string {
  return maskContactDetails(maskCardNumbers(text));
}

/** maskMailText on every string inside a JSON value (a payload, a label value). Keys are kept. */
export function maskMailValue(value: unknown): unknown {
  if (typeof value === 'string') return maskMailText(value);
  if (Array.isArray(value)) return value.map(maskMailValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, maskMailValue(inner)]),
    );
  }
  return value;
}
