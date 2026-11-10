/**
 * RFC 5256 REFERENCES Message-ID normalization and ancestry chain helpers.
 *
 * Normalization follows the REFERENCES threading algorithm note in RFC 5256:
 * strip angle brackets, unquote quoted local parts, then lowercase for
 * duplicate-ID comparison.
 */

/** Strip angle brackets from a raw Message-ID / In-Reply-To value. */
function stripAngles(raw: string): string {
  return raw.trim().replace(/^<+|>+$/g, '').trim();
}

/**
 * Unquote a quoted-string local part per RFC 5322 msg-id forms, e.g.
 * `"01KF8JCEOCBS0045PS"@xxx.yyy.com` → `01KF8JCEOCBS0045PS@xxx.yyy.com`.
 */
function unquoteMsgIdLocalPart(msgId: string): string {
  if (!msgId.startsWith('"')) return msgId;

  let local = '';
  let i = 1;
  while (i < msgId.length) {
    const ch = msgId[i]!;
    if (ch === '\\' && i + 1 < msgId.length) {
      local += msgId[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === '"') {
      return local + msgId.slice(i + 1);
    }
    local += ch;
    i++;
  }
  return msgId;
}

/** Strip angles, unquote local part, lowercase local@domain per RFC 5256 duplicate-ID rules. */
export function canonicalMessageId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const stripped = stripAngles(raw);
  if (!stripped) return null;
  const unquoted = unquoteMsgIdLocalPart(stripped);
  if (!unquoted) return null;
  return unquoted.toLowerCase();
}

export function messageIdsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = canonicalMessageId(a);
  const right = canonicalMessageId(b);
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return left === right;
}

/**
 * Merge In-Reply-To onto References per JWZ/RFC when both present.
 * Returns oldest→newest ancestry with the immediate parent (IRT) last.
 */
export function buildReferenceChain(
  inReplyTo: string | null,
  references: readonly string[],
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();

  for (const ref of references) {
    const canon = canonicalMessageId(ref);
    if (!canon || seen.has(canon)) continue;
    seen.add(canon);
    chain.push(canon);
  }

  const parent = canonicalMessageId(inReplyTo);
  if (!parent) return chain;

  const withoutParent = chain.filter((id) => id !== parent);
  return [...withoutParent, parent];
}
