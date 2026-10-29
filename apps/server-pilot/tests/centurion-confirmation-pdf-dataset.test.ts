import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPdf, markLegacyNoMatchUnverified, safeInputPath } from '../scripts/build-centurion-confirmation-pdf-dataset.js';
import { confirmationNumberCandidates, extractPdfFields } from '../scripts/centurion-confirmation-pdf-fields.js';

describe('Centurion confirmation PDF extraction', () => {
  it('marks legacy no-match evidence unverified without changing other statuses', async () => {
    const legacy = markLegacyNoMatchUnverified({ status: 'no_match', headerSha256: 'a'.repeat(64) });
    expect(legacy).toEqual({ status: 'unverified', initialStatus: 'no_match', headerSha256: 'a'.repeat(64) });
    expect(markLegacyNoMatchUnverified({ status: 'missing' })).toEqual({ status: 'missing' });
    const result = await extractPdf({
      schemaVersion: 1,
      selection: {},
      attachment: { attachmentId: 'synthetic' },
      parentMessage: {},
      fromHeaderEvidence: legacy,
      file: { status: 'not_available' },
    }, tmpdir());
    expect(result.record.qualification).toMatchObject({ fromHeaderPrefix: null, fromHeaderEvidence: legacy });
  });

  it('extracts Markdown-emphasized fields sharing a line', () => {
    const fields = extractPdfFields([
      {
        page: 0,
        markdown:
          '| **Guest Name:** Sample Guest | **Confirmation Number:** 123456-1 | **Arrival Date:** 01 Jan 2027 | **Departure Date:** 03 Jan 2027 |',
      },
    ]);

    expect(fields.guestName).toEqual([
      { value: 'Sample Guest', pageNumber: 1, label: 'Guest Name' },
    ]);
    expect(fields.confirmationNumber).toEqual([
      { value: '123456-1', pageNumber: 1, label: 'Confirmation Number' },
    ]);
    expect(fields.arrivalDate[0]?.value).toBe('01 Jan 2027');
    expect(fields.departureDate[0]?.value).toBe('03 Jan 2027');
  });

  it('rejects PDF paths that escape the input directory through a symlink', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'centurion-pdf-path-'));
    try {
      const root = path.join(dir, 'input');
      const outside = path.join(dir, 'outside.pdf');
      mkdirSync(root);
      writeFileSync(outside, 'synthetic');
      symlinkSync(outside, path.join(root, 'escape.pdf'));
      await expect(safeInputPath(root, 'escape.pdf')).rejects.toThrow('input_path_invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves parent recipient arrays when building a record', async () => {
    const result = await extractPdf({
      schemaVersion: 1,
      selection: {},
      attachment: { attachmentId: 'synthetic' },
      parentMessage: {
        messageDbId: 'message-a',
        toAddresses: ['guest@example.test'],
        ccAddresses: ['staff@example.test'],
        bccAddresses: [],
      },
      fromHeaderEvidence: { status: 'missing' },
      file: { status: 'not_available' },
    }, tmpdir());
    expect(result.record.parentMessage).toMatchObject({
      to: ['guest@example.test'],
      cc: ['staff@example.test'],
      bcc: [],
    });
  });

  it('normalizes exact confirmation-ID tokens for cross-thread lookup', () => {
    const fields = extractPdfFields([
      {
        page: 2,
        markdown:
          '**Confirmation Number:** No. 123456-1 / 76543210\n**Average Daily Rate:** USD 149.00\n**Total Accommodation for stay:** USD 298.00 Proforma',
      },
    ]);

    expect(confirmationNumberCandidates(fields)).toEqual([
      { value: '123456-1', pageNumber: 3 },
      { value: '76543210', pageNumber: 3 },
    ]);
    expect(fields.averageDailyRate[0]?.value).toBe('USD 149.00');
    expect(fields.totalAccommodation[0]?.value).toBe('USD 298.00');
  });
});
