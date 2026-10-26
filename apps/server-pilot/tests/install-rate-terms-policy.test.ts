import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaffQuoteRatePolicyDocumentReader } from '../src/ai/staff-quote-installation.js';
import {
  installRateTermsPolicy,
  parseInstallRateTermsArgs,
  type OutboundPdfCandidate,
} from '../scripts/install-rate-terms-policy.js';

vi.mock('../src/mail/artifacts/read-artifact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mail/artifacts/read-artifact.js')>();
  return {
    ...actual,
    extractEmbeddedPdfText: vi.fn(async () => ({
      data: {
        reason: 'text',
        text:
          'Da Vinci Hotel and Suites\nWe have pleasure in confirming your reservation at Da Vinci Hotel and Suites for the following guest.\n1. All rates are quoted in ZAR and include Value Added Tax (VAT) at the prevailing rate.\n2. Average Rate per night includes the 1% Tourism Levy per room per night.',
      },
    })),
  };
});

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const DAVINCI_TEXT = [
  'Da Vinci Hotel and Suites',
  'We have pleasure in confirming your reservation at Da Vinci Hotel and Suites for the following guest.',
  '1. All rates are quoted in ZAR and include Value Added Tax (VAT) at the prevailing rate.',
  '2. Average Rate per night includes the 1% Tourism Levy per room per night.',
].join('\n');
const CENTURION_TEXT = [
  'The Centurion Hotel',
  'We have pleasure in confirming your reservation at The Centurion Hotel, Centurion for the following guest.',
  '1. All rates are quoted in ZAR and include Value Added Tax (VAT) at the prevailing rate.',
  '2. Average Rate per night includes the 1% Tourism Levy per room per night.',
].join('\n');

function pdf(text: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${text}\n%%EOF\n`);
}

function candidate(
  ownerRef: string,
  attachmentId: string,
  eventAt: string,
): OutboundPdfCandidate {
  return {
    id: `msg-${attachmentId}`,
    transportId: ownerRef,
    threadId: `thread-${attachmentId}`,
    direction: 'outbound',
    eventAt,
    attachmentId,
    s3Key: `attachments/msg-${attachmentId}/letter.pdf`,
    contentType: 'application/pdf',
    byteSize: 0,
    inline: false,
  };
}

function policyStub(ownerRef: string, propertyCode: string) {
  return {
    version: 'source-native-invoice-rate-policy-v1' as const,
    ownerRef,
    propertyCode,
    documents: [],
  };
}

describe('install-rate-terms-policy', () => {
  let dir = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('builds a source-backed hotel_rate_terms document that the staff reader accepts for that owner and refuses for another, with no HRCEN fallback', async () => {
    expect(() =>
      parseInstallRateTermsArgs(['--owner-ref', 'transport-davinci', '--apply']),
    ).toThrow(/property/i);
    expect(
      parseInstallRateTermsArgs([
        '--property',
        'HRDAV',
        '--owner-ref',
        'transport-davinci',
        '--apply',
      ]).propertyCode,
    ).toBe('HRDAV');

    dir = join(repo, '.private', 'install-rate-terms-policy-test', randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const davinciPolicy = join(dir, 'policy-transport-davinci.json');
    const faithPolicy = join(dir, 'policy-transport-faith.json');
    const invoiceCorpus = join(dir, 'invoice-seed.jsonl');
    const invoiceRow = {
      id: 'invoice-msg',
      transportId: 'transport-davinci',
      direction: 'outbound',
      threadId: 'thread-inv',
      eventAt: '2026-08-01T10:00:00.000Z',
      attachmentDescriptors: [
        {
          id: 'inv-att',
          messageId: 'invoice-msg',
          s3Key: 'attachments/invoice-msg/inv.pdf',
          contentType: 'application/pdf',
          byteSize: 32,
        },
      ],
    };
    await writeFile(invoiceCorpus, `${JSON.stringify(invoiceRow)}\n`, { mode: 0o600 });
    await writeFile(
      davinciPolicy,
      JSON.stringify({
        ...policyStub('transport-davinci', 'HRDAV'),
        corpusPaths: [relative(repo, invoiceCorpus)],
        documents: [
          {
            kind: 'family_invoice',
            ref: 'invoice-seed',
            propertyCode: 'HRDAV',
            ownerRef: 'transport-davinci',
            messageId: 'invoice-msg',
            threadId: 'thread-inv',
            messageAt: '2026-08-01T10:00:00.000Z',
            attachmentId: 'inv-att',
            sourceHash: 'a'.repeat(64),
            path: relative(repo, join(dir, 'missing-invoice.pdf')),
            locator: { s3Key: 'attachments/invoice-msg/inv.pdf', byteSize: 32 },
            authoredDate: '2026-08-01',
            rateCode: 'SYNDB',
            board: 'dinner_bed_breakfast',
          },
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(faithPolicy, JSON.stringify(policyStub('transport-faith', 'HRDAV')), {
      mode: 0o600,
    });

    const davinciPdf = pdf(DAVINCI_TEXT);
    const newerPdf = pdf(`${DAVINCI_TEXT}\n`);
    const centurionPdf = pdf(CENTURION_TEXT);
    const davinciRow = {
      ...candidate('transport-davinci', 'davinci-letter', '2026-09-01T10:00:00.000Z'),
      byteSize: davinciPdf.length,
    };
    const newerRow = {
      ...candidate('transport-davinci', 'davinci-letter-2', '2026-10-10T10:00:00.000Z'),
      byteSize: newerPdf.length,
    };
    const centurionRow = {
      ...candidate('transport-davinci', 'centurion-letter', '2026-10-01T10:00:00.000Z'),
      byteSize: centurionPdf.length,
    };
    const bytes = new Map([
      [davinciRow.s3Key, davinciPdf],
      [newerRow.s3Key, newerPdf],
      [centurionRow.s3Key, centurionPdf],
    ]);
    const texts = new Map([
      [davinciRow.attachmentId, DAVINCI_TEXT],
      [newerRow.attachmentId, DAVINCI_TEXT],
      [centurionRow.attachmentId, CENTURION_TEXT],
    ]);

    await expect(
      installRateTermsPolicy({
        propertyCode: 'HRZZZ',
        ownerRef: 'transport-davinci',
        alsoOwnerRefs: [],
        apply: true,
        repoRoot: repo,
        outputDir: dir,
        policyPathForOwnerRef: async () => davinciPolicy,
        listOutboundPdfs: async () => [],
        getPdfBytes: async () => null,
        extractText: async () => null,
        now: () => new Date('2026-10-20T00:00:00.000Z'),
      }),
    ).rejects.toThrow('rate_terms_property_unknown');

    const result = await installRateTermsPolicy({
      propertyCode: 'HRDAV',
      ownerRef: 'transport-davinci',
      alsoOwnerRefs: ['transport-faith'],
      apply: true,
      repoRoot: repo,
      outputDir: dir,
      policyPathForOwnerRef: async (ownerRef) =>
        ownerRef === 'transport-faith' ? faithPolicy : davinciPolicy,
      listOutboundPdfs: async (ownerRef) =>
        ownerRef === 'transport-davinci' ? [centurionRow, davinciRow] : [],
      getPdfBytes: async (key) => bytes.get(key) ?? null,
      extractText: async (_body, attachmentId) => texts.get(attachmentId) ?? null,
      now: () => new Date('2026-10-20T00:00:00.000Z'),
    });

    expect(result.installed).toEqual(['transport-davinci']);
    expect(result.skipped).toEqual([
      { ownerRef: 'transport-faith', reason: 'no_letter_from_transport' },
    ]);
    expect(result.sourceHash).toBe(createHash('sha256').update(davinciPdf).digest('hex'));

    const readPolicy = async () =>
      JSON.parse(await readFile(davinciPolicy, 'utf8')) as {
        propertyCode: string;
        ownerRef: string;
        corpusPaths: string[];
        documents: Array<{
          kind?: string;
          ownerRef: string;
          attachmentId: string;
          propertyCode: string;
          messageId: string;
        }>;
      };
    const policy = await readPolicy();
    expect(policy.propertyCode).toBe('HRDAV');
    expect(policy.ownerRef).toBe('transport-davinci');
    expect(policy.documents.map((item) => item.kind)).toEqual(['family_invoice', 'hotel_rate_terms']);
    expect(policy.documents[1]).toMatchObject({
      ownerRef: 'transport-davinci',
      attachmentId: 'davinci-letter',
      propertyCode: 'HRDAV',
    });
    expect(policy.corpusPaths).toHaveLength(1);
    expect(policy.corpusPaths[0]?.startsWith(`${relative(repo, dir)}/transport-davinci-`)).toBe(
      true,
    );
    expect(policy.corpusPaths[0]?.endsWith('.jsonl')).toBe(true);
    expect(policy.corpusPaths.join(' ')).not.toMatch(/HRCEN|centurion-nine-day|reservationist-backtest/i);
    const firstCorpus = await readFile(join(repo, policy.corpusPaths[0]!), 'utf8');
    expect(firstCorpus).toContain('"id":"invoice-msg"');
    expect(firstCorpus).toContain('"id":"msg-davinci-letter"');

    const deps = {
      propertyCode: 'HRDAV',
      ownerRef: 'transport-davinci',
      alsoOwnerRefs: [] as string[],
      apply: true,
      repoRoot: repo,
      outputDir: dir,
      policyPathForOwnerRef: async () => davinciPolicy,
      listOutboundPdfs: async () => [newerRow, centurionRow, davinciRow],
      getPdfBytes: async (key: string) => bytes.get(key) ?? null,
      extractText: async (_body: Buffer, attachmentId: string) => texts.get(attachmentId) ?? null,
      now: () => new Date('2026-10-20T00:00:00.000Z'),
    };
    await installRateTermsPolicy(deps);
    const refreshed = await readPolicy();
    expect(refreshed.documents.map((item) => [item.kind, item.attachmentId])).toEqual([
      ['family_invoice', 'inv-att'],
      ['hotel_rate_terms', 'davinci-letter-2'],
    ]);
    const refreshedCorpus = await readFile(join(repo, refreshed.corpusPaths[0]!), 'utf8');
    expect(refreshedCorpus).toContain('"id":"invoice-msg"');
    expect(refreshedCorpus).toContain('"id":"msg-davinci-letter-2"');
    expect(refreshedCorpus).not.toContain('"id":"msg-davinci-letter"');
    expect(refreshed.documents[1]?.messageId).toBe('msg-davinci-letter-2');

    const faithInstalled = JSON.parse(await readFile(faithPolicy, 'utf8')) as { documents: unknown[] };
    expect(faithInstalled.documents).toEqual([]);

    const family = { propertyCode: 'HRDAV', rateCode: 'BAR', board: 'breakfast' as const };
    const authorize = async () => true;
    const accepted = await createStaffQuoteRatePolicyDocumentReader({
      configurationPath: davinciPolicy,
      authorizeContext: authorize,
    })(
      {
        signal: AbortSignal.timeout(15_000),
        input: {
          propertyCode: 'HRDAV',
          authorizationScope: { ownerRef: 'transport-davinci', threadId: 'current-thread' },
          clock: { causalAt: '2026-10-21T00:00:00.000Z', sourceMode: 'current_read' },
        },
      } as never,
      family,
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      kind: 'hotel_rate_terms',
      ownerRef: 'transport-davinci',
      propertyCode: 'HRDAV',
      attachmentId: 'davinci-letter-2',
    });

    await expect(
      createStaffQuoteRatePolicyDocumentReader({
        configurationPath: davinciPolicy,
        authorizeContext: authorize,
      })(
        {
          signal: AbortSignal.timeout(15_000),
          input: {
            propertyCode: 'HRDAV',
            authorizationScope: { ownerRef: 'transport-faith', threadId: 'current-thread' },
            clock: { causalAt: '2026-10-21T00:00:00.000Z', sourceMode: 'current_read' },
          },
        } as never,
        family,
      ),
    ).rejects.toThrow('staff_quote_policy_scope_invalid');
  });
});
