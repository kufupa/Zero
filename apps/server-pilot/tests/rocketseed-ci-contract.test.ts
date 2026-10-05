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
const testDbHelper = readFileSync(join(serverRoot, 'tests', 'helpers', 'test-db.ts'), 'utf8');

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
      'tests/ingest-duplicate-cleanup.test.ts',
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

  it('runs transactional mail-flow suites on an ephemeral Postgres service', () => {
    const transactionalJob = workflow
      .slice(workflow.indexOf('rocketseed-transactional:'))
      .split(/\n  [a-zA-Z][\w-]*:/)[0]!;

    expect(transactionalJob).toContain('image: postgres:16');
    expect(transactionalJob).toContain('POSTGRES_HOST_AUTH_METHOD: trust');
    expect(transactionalJob).toContain(
      'DATABASE_URL="$TEST_DATABASE_URL" pnpm --dir apps/server-pilot db:migrate',
    );
    expect(transactionalJob).toContain(
      'unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS HMS_DB_TEST_REQUIRED ROCKETSEED_TRANSACTIONAL_TEST_REQUIRED',
    );
    expect(transactionalJob).toContain(
      'MAIL_TRANSPORT_MODE=fixture CONFIRM_DISPOSABLE_TEST_DB=1 ROCKETSEED_TRANSACTIONAL_TEST_REQUIRED=1 pnpm --dir apps/server-pilot exec vitest run',
    );
    expect(transactionalJob).toContain('vitest run --maxWorkers=1');
    for (const testFile of [
      'tests/rocketseed-returned-copy-reconciliation.test.ts',
      'tests/outbound-delivery-outcome.test.ts',
      'tests/outbound-claim-lease.test.ts',
      'tests/attachment-access.test.ts',
      'tests/pop3-worker.test.ts',
      'tests/candidate-attachment-cleanup-queue.test.ts',
      'tests/rehydrate-raw-mime.test.ts',
      'tests/promote-quarantine.test.ts',
    ]) {
      expect(transactionalJob).toContain(testFile);
    }
    expect(transactionalJob).not.toContain('nava-zero-mail-pilot');
    expect(transactionalJob).not.toContain('.env.production');
    expect(transactionalJob).not.toContain('VITEST_ALLOW_PILOT_RDS=1');
  });

  it('builds an unlogged disposable database URL after clearing inherited test config', () => {
    const transactionalJob = workflow
      .slice(workflow.indexOf('rocketseed-transactional:'))
      .split(/\n  [a-zA-Z][\w-]*:/)[0]!;
    const transactionalTestStep = transactionalJob.slice(
      transactionalJob.indexOf('Test transactional Rocketseed mail flow'),
    );
    const clearDbEnvironment =
      'unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS HMS_DB_TEST_REQUIRED ROCKETSEED_TRANSACTIONAL_TEST_REQUIRED';
    const runtimeUrlBuilder = "printf -v TEST_DATABASE_URL '%s%s%s%s%s%s%s%s%s%s%s'";

    expect(transactionalJob).toContain('DISPOSABLE_POSTGRES_HOST: 127.0.0.1');
    expect(transactionalJob).toContain(
      'DISPOSABLE_POSTGRES_PORT: ${{ job.services.postgres.ports[5432] }}',
    );
    expect(transactionalTestStep).toContain(clearDbEnvironment);
    expect(transactionalTestStep).toContain(runtimeUrlBuilder);
    expect(transactionalTestStep).toContain('export TEST_DATABASE_URL');
    expect(transactionalTestStep.indexOf(clearDbEnvironment)).toBeLessThan(
      transactionalTestStep.indexOf(runtimeUrlBuilder),
    );
    expect(transactionalTestStep.indexOf(runtimeUrlBuilder)).toBeLessThan(
      transactionalTestStep.indexOf('export TEST_DATABASE_URL'),
    );
    for (const component of [
      'DISPOSABLE_POSTGRES_USER',
      'DISPOSABLE_POSTGRES_HOST',
      'DISPOSABLE_POSTGRES_PORT',
      'DISPOSABLE_POSTGRES_DB',
      'DISPOSABLE_POSTGRES_SSLMODE',
    ]) {
      expect(transactionalTestStep).toContain(`$${component}`);
    }
    expect(transactionalTestStep).not.toMatch(/\bexport\s+DATABASE_URL(?:=|\b)/);
    expect(transactionalJob).not.toContain(['postgres', 'ql://'].join(''));
    expect(transactionalJob).not.toMatch(/\becho\b/);
  });

  it('fails closed when transactional Rocketseed DB setup or probe is unavailable', () => {
    expect(testDbHelper).toContain('ROCKETSEED_TRANSACTIONAL_TEST_REQUIRED');
    expect(testDbHelper).toContain('await probeTestDb()');
    expect(testDbHelper).toContain(
      'Rocketseed transactional tests require a reachable disposable DB',
    );
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
