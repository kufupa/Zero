// Read-only browser guard shared by the find runner and its batch CLI.

const MUTATION_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;
const MUTATION_PATH = /save|delete|cancel|duplicate|checkin|checkout|crs/i;

export function shouldAbortReadOnlyRequest({ method, url }) {
  const requestMethod = String(method ?? '').toUpperCase();
  if (!MUTATION_METHOD.test(requestMethod)) return false;
  if (requestMethod !== 'POST') return true;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return true;
  }
  return MUTATION_PATH.test(pathname);
}

export async function installReadOnlyGuard(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (shouldAbortReadOnlyRequest({ method: request.method(), url: request.url() })) {
      await route.abort();
      return;
    }
    await route.continue();
  });
}
