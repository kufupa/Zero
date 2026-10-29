import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPropertyReadLock, type PropertyReadConnection } from '../src/hms/property-read-lock.js';
import { createSlotSession } from '../src/hms/slot-session.js';
import { main as amendStayMain, withLeasedWritePage as amendStayLease } from '../tooling/playwright-quote/amend-stay.mjs';
import { parseAttachArgs } from '../tooling/playwright-quote/attach-document.mjs';
import { main as attachDocumentMain, withLeasedWritePage as attachDocumentLease } from '../tooling/playwright-quote/attach-document.mjs';
import { main as cancelLabStayMain, withLeasedWritePage as cancelLabStayLease } from '../tooling/playwright-quote/cancel-lab-stay.mjs';
import { main as cancelStayMain, withLeasedWritePage as cancelStayLease } from '../tooling/playwright-quote/cancel-stay.mjs';
import {
  parseCreateProperty,
  main as createLabStayMain,
  withLeasedWritePage as createLabStayLease,
} from '../tooling/playwright-quote/create-lab-stay.mjs';
import { parseStayProperty } from '../tooling/playwright-quote/property-profile.mjs';
import {
  resetSharedReadCliLease,
  sharedReadCliLease,
  withReadCliPage,
} from '../tooling/playwright-quote/read-cli-lease.mjs';
import {
  WRITE_CLI_TOOLS,
  withWriteCliPage,
} from '../tooling/playwright-quote/write-cli-lease.mjs';
import { describe, expect, it, vi } from 'vitest';

const GENERIC_PROPERTY = 'HTLAA';
const LOCK_TENANT = 'tenant-generic';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLING = join(ROOT, 'tooling/playwright-quote');

const OMITTED_ARGV = {
  'create-lab-stay': ['--request', 'x.json'],
  'amend-stay': ['--request', 'x.json', '--mode', 'preview', '--out', '/tmp'],
  'cancel-stay': ['--confirmation', '1-1', '--arrival', '2027-09-14', '--mode', 'preview', '--out', '/tmp'],
  'cancel-lab-stay': [],
  'attach-document': [
    '--confirmation',
    '1-1',
    '--arrival',
    '2027-09-14',
    '--file',
    'x.pdf',
    '--document-name',
    'x.pdf',
    '--out',
    '/tmp',
  ],
} as const;

const SHARED_LEASES = [
  createLabStayLease,
  amendStayLease,
  cancelStayLease,
  cancelLabStayLease,
  attachDocumentLease,
];

function sourceOf(name: string) {
  return readFileSync(join(TOOLING, name), 'utf8');
}

function secretFor(propertyCode: string) {
  return {
    loginUrl: 'https://example.invalid/login',
    username: 'user',
    password: 'secret',
    expectedTenant: `tenant-${propertyCode}`,
    expectedPropertyCode: propertyCode,
    expectedPropertyName: `Hotel ${propertyCode}`,
  };
}

function lockConnection(): PropertyReadConnection {
  return {
    query: vi.fn(async (sql: string) =>
      sql.includes('pg_try_advisory_lock') ? [{ pg_try_advisory_lock: true }] : undefined,
    ),
    close: vi.fn(async () => undefined),
  };
}

describe('write CLI session lease', () => {
  it('omitted property refuses before page creation or write', async () => {
    expect(parseCreateProperty([])).toMatchObject({ ok: false, error: 'PROPERTY_REQUIRED', exitCode: 2 });
    expect(parseCreateProperty(['--property', 'HTLZZ'])).toMatchObject({
      ok: false,
      error: 'PROPERTY_UNKNOWN',
      exitCode: 2,
    });
    expect(parseStayProperty(OMITTED_ARGV['cancel-stay'])).toMatchObject({
      ok: false,
      error: 'PROPERTY_REQUIRED',
      exitCode: 2,
    });
    expect(parseStayProperty(OMITTED_ARGV['amend-stay'])).toMatchObject({
      ok: false,
      error: 'PROPERTY_REQUIRED',
      exitCode: 2,
    });
    expect(parseAttachArgs(OMITTED_ARGV['attach-document'])).toMatchObject({
      ok: false,
      error: 'PROPERTY_REQUIRED',
      exitCode: 2,
    });

    const previousExit = process.exitCode;
    try {
      expect(await createLabStayMain(OMITTED_ARGV['create-lab-stay'])).toBe(2);
      expect(await createLabStayMain(['--property', 'HRCEN', '--request', 'x.json'])).toBe(2);
      expect(await amendStayMain(OMITTED_ARGV['amend-stay'])).toBe(2);
      expect(await cancelStayMain(OMITTED_ARGV['cancel-stay'])).toBe(2);
      expect(await cancelLabStayMain(OMITTED_ARGV['cancel-lab-stay'])).toBe(2);
      expect(await attachDocumentMain(OMITTED_ARGV['attach-document'])).toBe(2);
    } finally {
      process.exitCode = previousExit;
    }

    expect(WRITE_CLI_TOOLS).toEqual([
      'create-lab-stay',
      'amend-stay',
      'cancel-stay',
      'cancel-lab-stay',
      'attach-document',
    ]);
    for (const name of WRITE_CLI_TOOLS) {
      expect(sourceOf(`${name}.mjs`)).toContain('withWriteCliPage');
    }
    for (const lease of SHARED_LEASES) expect(lease).toBe(withWriteCliPage);
    expect(withWriteCliPage).toBe(withReadCliPage);

    const page = { id: 'persistent-page' };
    const newPage = vi.fn(async () => ({ id: 'fresh-page' }));
    const loginPage = vi.fn(async () => {
      throw new Error('login must not run when the shell is already authenticated');
    });
    const run = vi.fn(async () => 'hms-write');
    const lookupProperty = (code: string) =>
      code === GENERIC_PROPERTY ? { propertyCode: GENERIC_PROPERTY } : null;
    const context = { pages: () => [page], newPage };
    const session = createSlotSession({
      owner: { login: async () => {}, wipeProfile: async () => {} },
    });
    await session.recover();
    resetSharedReadCliLease();
    const lease = sharedReadCliLease({
      lookupProperty,
      loginPage,
      authenticatedShell: async (candidate: { id: string }) => candidate === page,
    });
    const lock = createPropertyReadLock({
      tenantId: LOCK_TENANT,
      propertyCode: GENERIC_PROPERTY,
      connectionFactory: async () => lockConnection(),
    });
    const omitted = {
      secret: secretFor(GENERIC_PROPERTY),
      session,
      lease,
      lookupProperty,
      context,
    };

    await expect(withWriteCliPage({ ...omitted, propertyCode: '' }, run)).rejects.toMatchObject({
      name: 'SlotLeaseRefusedError',
      code: 'property_unknown',
      payload: undefined,
    });
    await expect(withWriteCliPage({ ...omitted }, run)).rejects.toMatchObject({
      code: 'property_unknown',
      payload: undefined,
    });
    await expect(withWriteCliPage({ ...omitted, propertyCode: 'HTLZZ' }, run)).rejects.toMatchObject({
      code: 'property_unknown',
      payload: undefined,
    });
    expect(newPage).not.toHaveBeenCalled();
    expect(loginPage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    const pages = await lock.withLock(async (connection) => {
      const seen: unknown[] = [];
      for (let i = 0; i < 2; i += 1) {
        seen.push(
          await withWriteCliPage(
            {
              propertyCode: GENERIC_PROPERTY,
              tenantId: LOCK_TENANT,
              secret: secretFor(GENERIC_PROPERTY),
              session,
              lease,
              lookupProperty,
              lockConnection: connection,
              lockKey: lock.key,
              context,
            },
            async ({ page: leased }: { page: { id: string } }) => leased,
          ),
        );
      }
      return seen;
    });

    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).toBe(page);
    expect(newPage).not.toHaveBeenCalled();
    expect(loginPage).not.toHaveBeenCalled();
  });
});
