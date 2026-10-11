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
 * Replace Luhn-valid card numbers and security codes. Scanned PDF bytes cannot be masked; callers skip them.
 * Only the digits after a security-code label are replaced, so the label still says what was there.
 */
export function maskCardNumbers(text: string): string {
  return text
    .replace(PAN_CANDIDATE_PATTERN, (match) => {
      const digits = match.replace(/[ -]/g, '');
      if (!isLuhnValid(digits)) return match;
      const tail = /[ -]$/.test(match) ? match.slice(-1) : '';
      return `[card ••••${digits.slice(-4)}]${tail}`;
    })
    .replace(SECURITY_CODE, (_match, label: string, gap: string) => `${label}${gap}[code masked]`);
}

const EMAIL_ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;
/*
 * The number patterns match only where a number stands on its own: the text edge, whitespace, a bracket or closing
 * punctuation sits on each side. A digit, dash or dot touching it means it is part of a longer token, such as the date
 * 2027-05-12 or the reference 57291630-1. Groups join by spaces or tabs only, never across a newline.
 */
const EDGE_BEFORE = '(?<![^\\s()[\\].,;:!?])';
const EDGE_AFTER = '(?![^\\s()[\\].,;:!?])';
/** Dashed or dotted digits, such as 082-555-1234 or 2027-05-12. Masked only at 9 to 15 digits starting with 0 or +. */
const DASHED_NUMBER = new RegExp(`${EDGE_BEFORE}\\+?\\d+(?:[-.]\\d+)+${EDGE_AFTER}`, 'g');
/** Digit groups joined by spaces, such as 0825551234, 082 555 1234 or +27 (0)82 555 1234. */
const SPACED_NUMBER = new RegExp(
  `${EDGE_BEFORE}\\+?\\(?\\d+\\)?(?:(?:[ \\t]+|(?<=\\)))\\+?\\(?\\d+\\)?)*${EDGE_AFTER}`,
  'g',
);
const DIGIT_GROUP = /\+?\(?\d+\)?/g;

const digitsOf = (text: string) => text.replace(/\D/g, '');

/**
 * Masks the phone parts of one run of digit groups. A group of 7 or more digits is a phone on its own. Otherwise a
 * window that starts with + or a trunk 0 and totals 9 to 15 digits is one, so a year or a day beside it stays.
 */
function maskDigitGroups(run: string): string {
  const groups = [...run.matchAll(DIGIT_GROUP)];
  const counts = groups.map((group) => digitsOf(group[0]).length);
  const phone = counts.map((count) => count >= 7);
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
    out += `${run.slice(cursor, groups[index]!.index)}[phone]`;
    cursor = groups[last]!.index! + groups[last]![0].length;
    index = last;
  }
  return out + run.slice(cursor);
}

/**
 * Replace e-mail addresses with [email] and phone numbers with [phone]. A phone number is a run of 7 or more digits on its
 * own, or spaced or dashed digits of 9 to 15 that start with + or 0. Amounts, dates and dashed references such as
 * 57291630-1 stay. Run maskCardNumbers first (see maskMailText).
 */
export function maskContactDetails(text: string): string {
  return text
    .replace(EMAIL_ADDRESS, '[email]')
    .replace(DASHED_NUMBER, (match) => {
      const digits = digitsOf(match);
      const phoneLike =
        digits.length >= 9 && digits.length <= 15 && (match.startsWith('+') || digits.startsWith('0'));
      return phoneLike ? '[phone]' : match;
    })
    .replace(SPACED_NUMBER, maskDigitGroups);
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
