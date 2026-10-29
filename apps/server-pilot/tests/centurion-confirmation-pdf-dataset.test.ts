import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPdf, markLegacyNoMatchUnverified, safeInputPath } from '../scripts/build-centurion-confirmation-pdf-dataset.js';
import { confirmationNumberCandidates, extractPdfFields } from '../scripts/centurion-confirmation-pdf-fields.js';

function syntheticPdf(): Buffer {
  const stream = 'BT\n/F1 12 Tf\n72 720 Td\n(Confirmation Number: 123456-1) Tj\n0 -18 Td\n(Average Daily Rate: USD 149.00) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function sourceFor(fileName: string, sha256: string) {
  return {
    schemaVersion: 1,
    selection: {},
    attachment: { attachmentId: 'synthetic' },
    parentMessage: {},
    fromHeaderEvidence: { status: 'missing' },
    file: { status: 'available', path: fileName, sha256, pdfMagicValid: true, sizeMatchesMetadata: true },
  };
}

describe('Centurion confirmation PDF extraction', () => {
  it('extracts a valid PDF and flags changed or invalid PDF bytes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'centurion-pdf-extraction-'));
    try {
      const pdf = syntheticPdf();
      const hash = createHash('sha256').update(pdf).digest('hex');
      writeFileSync(path.join(dir, 'sample.pdf'), pdf);
      const changed = await extractPdf(sourceFor('sample.pdf', '0'.repeat(64)), dir);
      expect(changed.record.pdfExtraction).toMatchObject({ status: 'source_hash_mismatch' });
      expect(changed.record.attachment).toMatchObject({ sha256: hash, sourceSha256: '0'.repeat(64), sourceSha256Matches: false, pdfMagicValid: null, sizeMatchesMetadata: null });
      expect(changed.fields.confirmationNumber).toEqual([]);
      expect(changed.observedSha256).toBe(hash);

      const parsed = await extractPdf(sourceFor('sample.pdf', hash), dir);
      expect(parsed.record.pdfExtraction).toMatchObject({ status: 'native_text_extracted', pdfInspectorVersion: '1.25.2' });
      expect(parsed.fields.confirmationNumber).toEqual([{ value: '123456-1', pageNumber: 1, label: 'Confirmation Number' }]);
      expect(parsed.fields.averageDailyRate[0]?.value).toBe('USD 149.00');
      expect(parsed.record.attachment).toMatchObject({ sha256: hash, sourceSha256: hash, sourceSha256Matches: true, pdfMagicValid: true, sizeMatchesMetadata: true });

      const withoutSourceHash = await extractPdf(sourceFor('sample.pdf', ''), dir);
      expect(withoutSourceHash.record.attachment).toMatchObject({ sha256: hash, sourceSha256: null, sourceSha256Matches: null, pdfMagicValid: null });

      const invalid = Buffer.from('not a PDF');
      writeFileSync(path.join(dir, 'invalid.pdf'), invalid);
      const invalidHash = createHash('sha256').update(invalid).digest('hex');
      const invalidSource = sourceFor('invalid.pdf', invalidHash);
      invalidSource.file.pdfMagicValid = false;
      const failed = await extractPdf(invalidSource, dir);
      expect(failed.record.pdfExtraction).toMatchObject({ status: 'parser_failure' });
      expect(failed.record.attachment).toMatchObject({ pdfMagicValid: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
    expect(result.record.attachment).toMatchObject({ pdfMagicValid: null, sizeMatchesMetadata: null });
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
