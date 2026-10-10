/** Luhn PAN candidates: 13–19 digits with optional space/dash separators. `/g` is stateful. */
export const PAN_CANDIDATE_PATTERN = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;

/**
 * A security-code label and its 3–4 digit value: "CVV: 123", "CVC 1234", "security code 123". Only the value goes.
 * The gap never crosses a bracket, so a masked card token that follows a label stays whole. It may cross up to two
 * line breaks, as extracted PDF text puts a form label and its value on separate lines.
 */
const SECURITY_CODE = /\b(cvv2?|cvc2?|cvn|csc|security\s+code)\b([^\d\n[\]]{0,16}?(?:\n[^\d\n[\]]{0,16}?){0,2})\d{3,4}(?!\d)/gi;

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
