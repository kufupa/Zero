export type ParsedRecipientToken = {
  email: string;
  name?: string;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const canonicalizeEmail = (email: string): string => email.trim().toLowerCase();

const hasUnclosedAngleAhead = (value: string, startIndex: number): boolean => {
  let inQuotes = false;

  for (let i = startIndex; i < value.length; i += 1) {
    const char = value[i];

    if (char === '"' && value[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      continue;
    }

    if (inQuotes) continue;

    if (char === ';' || char === ',') {
      return false;
    }

    if (char === '<') {
      return true;
    }
  }

  return false;
};

export const splitRecipientField = (value: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = 0;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];

    if (char === '"' && value[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes) {
      if (char === '<') {
        inAngle += 1;
      } else if (char === '>' && inAngle > 0) {
        inAngle -= 1;
      } else if ((char === ',' || char === ';') && inAngle === 0) {
        if (char === ',' && !current.includes('<') && hasUnclosedAngleAhead(value, i + 1)) {
          current += char;
          continue;
        }

        const token = current.trim();
        if (token) tokens.push(token);
        current = '';
        continue;
      }
    }

    current += char;
  }

  const finalToken = current.trim();
  if (finalToken) tokens.push(finalToken);
  return tokens;
};

export const parseRecipientToken = (value: string): ParsedRecipientToken | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(.*)\s*<\s*([^<>]+)\s*>$/);
  if (!match) {
    return EMAIL_REGEX.test(canonicalizeEmail(trimmed)) ? { email: canonicalizeEmail(trimmed) } : null;
  }

  const name = match[1]?.trim();
  const email = match[2]?.trim() ?? '';

  if (!EMAIL_REGEX.test(canonicalizeEmail(email))) return null;

  return {
    email: canonicalizeEmail(email),
    ...(name ? { name } : {}),
  };
};

