// Parse HMS's data-only object literal without executing it.
export function parseSavedStayNativeResponse(raw) {
  if (typeof raw !== 'string' || !raw.trim() || /^\s*</.test(raw)) throw new Error('NATIVE_RESPONSE_INVALID');
  let badEscape = false;
  const strings = raw.replace(/("(?:\\.|[^"\\])*")|'((?:\\.|[^'\\])*)'/gs, (all, double, single) => {
    if (double) return double;
    const value = single.replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/gs, (_match, escape) => {
      const values = { "'": "'", '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
      if (Object.hasOwn(values, escape)) return values[escape];
      if (escape[0] === 'u' || escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
      badEscape = true; return '';
    });
    return JSON.stringify(value);
  });
  if (badEscape) throw new Error('NATIVE_RESPONSE_INVALID');
  const json = strings.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  let payload;
  try { payload = JSON.parse(json); } catch { throw new Error('NATIVE_RESPONSE_INVALID'); }
  const data = payload?.pageData;
  const hasContent = (value) => Array.isArray(value) ? value.length > 0 : value != null && value !== false && value !== '';
  if (!data || [payload, data].some((part) => part && ((Object.hasOwn(part, 'success') && part.success !== true) ||
      hasContent(part.error) || hasContent(part.errors))) || hasContent(data.messages)) throw new Error('NATIVE_RESPONSE_INVALID');
  return data;
}
