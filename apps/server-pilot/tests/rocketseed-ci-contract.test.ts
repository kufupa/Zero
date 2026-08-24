import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const serverRoot = join(repoRoot, 'apps', 'server-pilot');
const serverPackage = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string | undefined>;
};
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const mailRoute = readFileSync(join(serverRoot, 'src', 'trpc', 'routes', 'mail.ts'), 'utf8');
const inlineRoute = readFileSync(join(serverRoot, 'src', 'http', 'inline-attachment.ts'), 'utf8');
const cidImages = readFileSync(join(serverRoot, 'src', 'mail', 'cid-images.ts'), 'utf8');

describe('Rocketseed CI contract', () => {
  it('runs only the focused DB-free Rocketseed suite', () => {
    const script = serverPackage.scripts['test:rocketseed'];

    expect(script).toBeTypeOf('string');
    for (const testFile of [
      'tests/transport-mode.test.ts',
      'tests/fixture-loopback.test.ts',
      'tests/worker-mode.test.ts',
      'tests/rocketseed-returned-copy.test.ts',
      'tests/rocketseed-returned-copy-correlation.test.ts',
      'tests/cid-images.test.ts',
      'tests/sanitize-email-html.test.ts',
      'tests/safe-inline-image.test.ts',
      'tests/inline-attachment-http.test.ts',
      'tests/rocketseed-flow.test.ts',
      'tests/rocketseed-ci-contract.test.ts',
    ]) {
      expect(script).toContain(testFile);
    }
    expect(script).not.toContain('rocketseed-returned-copy-reconciliation.test.ts');
    expect(script).not.toContain('playwright');
    expect(script).not.toContain('test-db');
  });

  it('runs focused tests with DB variables cleared and builds both applications', () => {
    expect(workflow).toContain(
      'unset DATABASE_URL TEST_DATABASE_URL CONFIRM_DISPOSABLE_TEST_DB VITEST_ALLOW_PILOT_RDS',
    );
    expect(workflow).toContain('export MAIL_TRANSPORT_MODE=fixture');
    expect(workflow).toContain('pnpm --dir apps/server-pilot run test:rocketseed');
    expect(workflow).toContain('pnpm --dir apps/server-pilot build');
    expect(workflow).toContain('pnpm --dir apps/mail build');
    expect(workflow).not.toContain('.env.production');
    expect(workflow).not.toContain('VITEST_ALLOW_PILOT_RDS=1');
  });

  it('loads isInline metadata for CID projection and inline authorization', () => {
    const processEmailContent = mailRoute.slice(
      mailRoute.indexOf('processEmailContent:'),
      mailRoute.indexOf('verifyEmail:'),
    );
    const loadAuthorizedAttachment = inlineRoute.slice(
      inlineRoute.indexOf('export async function loadAuthorizedAttachment'),
      inlineRoute.indexOf('export function createInlineAttachmentHandler'),
    );

    expect(processEmailContent).toContain('isInline: attachment.isInline');
    expect(loadAuthorizedAttachment).toContain('isInline: attachment.isInline');
    expect(cidImages).toContain('MAX_INLINE_IMAGE_BYTES');
    expect(inlineRoute).toContain('MAX_INLINE_IMAGE_BYTES');
  });
});
