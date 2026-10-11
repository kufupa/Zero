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
/** A phone-like run: optional + or (, digits with spaces, dots, dashes or brackets between them. */
const PHONE_CANDIDATE = /(?<![\w+])\+?\(?\d[\d\s().-]{6,}\d(?!\w)/g;

/**
 * Replace e-mail addresses with [email] and phone numbers with [phone]. A phone number is 9 to 15 digits and starts
 * with + or 0, so amounts, dates and confirmation numbers stay. Run maskCardNumbers first (see maskMailText).
 */
export function maskContactDetails(text: string): string {
  return text.replace(EMAIL_ADDRESS, '[email]').replace(PHONE_CANDIDATE, (match) => {
    const digits = match.replace(/\D/g, '');
    const phoneLike =
      digits.length >= 9 &&
      digits.length <= 15 &&
      (match.startsWith('+') || digits.startsWith('0'));
    return phoneLike ? '[phone]' : match;
  });
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
