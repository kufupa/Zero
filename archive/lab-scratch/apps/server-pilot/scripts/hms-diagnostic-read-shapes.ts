/** Pure diagnostic helpers. Never import a CLI to share these: bundling makes
 * every import.meta.url entrypoint guard refer to the same output file. */
export function diagnosticLocaleBootstrap(body: string) {
  const recognized =
    body.length < 2_000 &&
    /loadLocalizedPage/i.test(body) &&
    /langform/i.test(body) &&
    /ewslanguage/i.test(body);
  const form = recognized ? (body.match(/<form\b[^>]*>/i)?.[0] ?? '') : '';
  const action = form.match(/\baction\s*=\s*["']([^"']*)["']/i)?.[1];
  let actionPath: string | null = null;
  if (action) {
    try {
      const path = new URL(action, 'https://invalid.example/web/base/').pathname;
      actionPath = /^\/web\/base\/[A-Za-z0-9_.-]{1,80}$/.test(path) ? path : '[other]';
    } catch {
      actionPath = '[invalid]';
    }
  }
  const method = form.match(/\bmethod\s*=\s*["'](GET|POST)["']/i)?.[1]?.toUpperCase() ?? null;
  return {
    recognized,
    actionPath,
    method,
    readsCookie: recognized && /document\.cookie/.test(body),
    submitsForm: recognized && /\.submit\s*\(/.test(body),
  };
}
