/** Luhn PAN candidates: 13–19 digits with optional space/dash separators. `/g` is stateful. */
export const PAN_CANDIDATE_PATTERN = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;

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

/** Replace Luhn-valid card numbers. Scanned PDF bytes cannot be masked; callers skip them. */
export function maskCardNumbers(text: string): string {
  return text.replace(PAN_CANDIDATE_PATTERN, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (!isLuhnValid(digits)) return match;
    const tail = /[ -]$/.test(match) ? match.slice(-1) : '';
    return `[card ••••${digits.slice(-4)}]${tail}`;
  });
}
