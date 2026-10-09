import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../src/trpc/router.js';
import { patchSheetXml } from '../src/quote-proposal/patch-sheet.js';
import { patchProposalWorkbook } from '../src/quote-proposal/patch-template.js';
import { __setDbForTests } from '../src/db/client.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { mailboxAccess } from '../src/db/schema/mail.js';

const reachable = await probeTestDb();

const TEMPLATE = readFileSync(
  fileURLToPath(new URL('../fixtures/centurion-quotation-template.xlsx', import.meta.url)),
);

function sessionCaller(email = 'ropperman@legacyhotels.co.za', name = 'R Opperman') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: {
      id: 'user-ropperman',
      email,
      name,
    },
  } as never);
}

const sampleLines = [
  {
    dateLabel: '15-17 September 2026',
    qty: 2,
    roomCode: 'STQN',
    meal: 'bb' as const,
    nights: 2,
    rate: 2150,
  },
];

describe('quote proposal xlsx patch', () => {
  it('writes client header, DESCRIPTION, rates, and signer without dropping drawings or print area', () => {
    const patched = patchProposalWorkbook(TEMPLATE, {
      attention: 'David Miller',
      company: 'CIDB',
      clientEmail: 'guest@example.com',
      clientTelephone: '',
      signerName: 'R Opperman',
      signerEmail: 'ropperman@legacyhotels.co.za',
      signerTelephone: '0126433600',
      lines: [
        {
          dateLabel: '15-17 September 2026',
          qty: 2,
          description: 'Single room Bed & Breakfast',
          nights: 2,
          rate: 2150,
        },
      ],
    });
    const files = unzipSync(patched);
    expect(files['xl/drawings/drawing1.xml']).toBeTruthy();
    expect(files['xl/media/image1.png']).toBeTruthy();
    expect(new TextDecoder().decode(files['xl/workbook.xml']!)).toContain('Sheet1!$A$1:$H$69');
    const sheet = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('David Miller');
    expect(sheet).toContain('Single room Bed &amp; Breakfast');
    expect(sheet).toContain('R Opperman');
    expect(sheet).toContain('0126433600');
    expect(sheet).toContain('<v>2150</v>');
    // The patcher writes each line total as a value (2 x 2 x 2150) and does not keep the template formula.
    expect(sheet).toMatch(/<c r="H24"[^>]*><v>8600<\/v><\/c>/);
    expect(sheet).not.toContain('B24*F24*G24');
    expect(sheet).toContain('t="s"><v>1</v>');
  });

  it('keeps VAT cell as Included shared-string', () => {
    const templateSheet = new TextDecoder().decode(
      unzipSync(TEMPLATE)['xl/worksheets/sheet1.xml']!,
    );
    const patched = patchSheetXml(templateSheet, {
      attention: 'A',
      company: 'B',
      clientEmail: 'c@x.com',
      clientTelephone: '',
      signerName: 'N',
      signerEmail: 'n@x.com',
      signerTelephone: '0126433600',
      lines: [
        {
          dateLabel: '15-17 September 2026',
          qty: 1,
          description: 'Deluxe room Bed & Breakfast',
          nights: 1,
          rate: 2700,
        },
      ],
    });
    expect(patched).toMatch(/<c r="H32"[^>]*t="s"><v>1<\/v><\/c>/);
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('workstation.quoteProposalPdf (disposable DB)', () => {
  afterEach(() => {
    __setDbForTests(null);
    vi.unstubAllGlobals();
    delete process.env.GOTENBERG_URL;
  });

  it('refuses PDF for a mailbox not provisioned to the signed-in user', async () => {
    await withSeededTestDb(async (db) => {
      __setDbForTests({ db, conn: null as never });
      process.env.GOTENBERG_URL = 'http://gotenberg.test';
      await expect(
        sessionCaller().workstation.quoteProposalPdf({
          outlookEmail: 'navaai@legacyhotels.co.za',
          agency: 'CIDB',
          dateLabel: '15-17 Sep',
          lines: sampleLines,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'OUTLOOK_EMAIL_MISMATCH' } satisfies Partial<TRPCError>);
    });
  });

  it('does not use another granted mailbox when the signed-in staff selected Centurion', async () => {
    await withSeededTestDb(async (db) => {
      __setDbForTests({ db, conn: null as never });
      await db.insert(mailboxAccess).values({ id: randomUUID(), userId: 'user-ropperman',
        transportId: 'transport-nava', role: 'member' });
      await expect(sessionCaller().workstation.quoteProposalPdf({
        outlookEmail: 'navaai@legacyhotels.co.za',
        agency: 'CIDB', dateLabel: '15-17 Sep', lines: sampleLines,
      })).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'OUTLOOK_EMAIL_MISMATCH' } satisfies Partial<TRPCError>);
    });
  });

  it('converts the patched workbook through Gotenberg and stamps the session user', async () => {
    await withSeededTestDb(async (db) => {
      __setDbForTests({ db, conn: null as never });
      process.env.GOTENBERG_URL = 'http://gotenberg.test';
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe('http://gotenberg.test/forms/libreoffice/convert');
        expect(init?.method).toBe('POST');
        return new Response(Buffer.from('%PDF-1.4 test'), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await sessionCaller().workstation.quoteProposalPdf({
        outlookEmail: 'centurion@legacyhotels.co.za',
        attention: 'David Miller',
        company: 'CIDB',
        clientEmail: 'guest@example.com',
        agency: 'CIDB',
        dateLabel: '15-17 Sep',
        lines: sampleLines,
      });

      expect(res.fileName).toBe('Quote - CIDB 15-17 Sep.pdf');
      expect(Buffer.from(res.pdfBase64, 'base64').toString()).toContain('%PDF-1.4');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = fetchMock.mock.calls[0]?.[1]?.body;
      expect(body).toBeInstanceOf(FormData);
    });
  });
});
