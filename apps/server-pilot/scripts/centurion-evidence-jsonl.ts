/** Private pure parser: never supply a path; source provenance and integrity are validated elsewhere. */
export type SnapshotJsonlResult =
  | { ok: true; records: unknown[] }
  | { ok: false; error: { code: 'INVALID_INPUT' | 'INVALID_UTF8' | 'INVALID_JSONL' } };
const failure = (code: 'INVALID_INPUT' | 'INVALID_UTF8' | 'INVALID_JSONL'): SnapshotJsonlResult => ({ ok: false, error: { code } });

/** Normalize JSON number notation to compare the exact decimal value, not its spelling. */
function decimalKey(raw: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) throw new Error();
  let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '');
  if (!digits) return '0';
  const withoutTrailing = digits.replace(/0+$/, '');
  const exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length) + BigInt(digits.length - withoutTrailing.length);
  digits = withoutTrailing;
  return `${match[1]}${digits}:${exponent}`;
}

/** JSON.parse alone silently discards duplicate keys and can round or overflow numbers. */
function retainsJsonValues(line: string): boolean {
  const objects: Array<Set<string> | null> = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '{') objects.push(new Set());
    else if (ch === '[') objects.push(null);
    else if (ch === '}' || ch === ']') objects.pop();
    else if (ch === '"') {
      const start = i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') break;
        i++;
      }
      let next = i + 1;
      while (next < line.length && /[\x20\t\r\n]/.test(line[next]!)) next++;
      if (line[next] === ':') {
        const keys = objects[objects.length - 1];
        const key = JSON.parse(line.slice(start, i + 1)) as string;
        if (!keys || keys.has(key)) return false;
        keys.add(key);
      }
    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      while (i + 1 < line.length && /[0-9eE+.-]/.test(line[i + 1]!)) i++;
      const raw = line.slice(start, i + 1);
      const value = Number(raw);
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
          decimalKey(raw) !== decimalKey(String(value))) return false;
    }
  }
  return true;
}

/**
 * Parse exact UTF-8 JSONL framing, preserving record values and order. The successful
 * result is private source data, never a model-visible status. No schema, checksum,
 * source identity, capture time, window membership, or provenance is inferred here.
 * Pass `records` unchanged to buildEvidenceSources with caller-verified metadata.
 */
export function parseEvidenceSnapshotJsonl(input: unknown): SnapshotJsonlResult {
  let text: string;
  try {
    if (typeof input === 'string') {
      // Reject literal unpaired UTF-16 surrogates rather than replacing source text.
      if (Buffer.from(input, 'utf8').toString('utf8') !== input) return failure('INVALID_UTF8');
      text = input;
    } else if (input instanceof Uint8Array) {
      // Shared backing memory could change while decoded, so fail closed.
      if (typeof SharedArrayBuffer !== 'undefined' && input.buffer instanceof SharedArrayBuffer) return failure('INVALID_INPUT');
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
      catch { return failure('INVALID_UTF8'); }
    } else return failure('INVALID_INPUT');
  } catch { return failure('INVALID_INPUT'); }
  try {
    if (!text) return failure('INVALID_JSONL');
    const records: unknown[] = [];
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      const line = text.slice(start, end);
      if (!line.trim()) return failure('INVALID_JSONL');
      const record: unknown = JSON.parse(line);
      if (!retainsJsonValues(line)) return failure('INVALID_JSONL');
      records.push(record);
      if (newline === -1) break;
      start = newline + 1;
    }
    return { ok: true, records };
  } catch { return failure('INVALID_JSONL'); }
}
