import { describe, expect, it } from 'vitest';
import {
  COMPOSE_ATTACHMENT_ACCEPT,
  partitionComposeAttachmentFiles,
} from '../lib/compose-attachment-policy';

function createFile(name: string, type: string): File {
  return new File(['contents'], name, { type });
}

describe('compose attachment policy', () => {
  it('exports the existing picker accept policy', () => {
    expect(COMPOSE_ATTACHMENT_ACCEPT).toBe(
      'image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt',
    );
  });

  it('accepts every image MIME type', () => {
    const files = [
      createFile('photo.webp', 'image/webp'),
      createFile('drawing.svg', 'image/svg+xml'),
    ];

    expect(partitionComposeAttachmentFiles(files)).toEqual({
      accepted: files,
      rejected: [],
    });
  });

  it('accepts supported document MIME types', () => {
    const files = [
      createFile('document.pdf', 'application/pdf'),
      createFile('legacy.doc', 'application/msword'),
      createFile(
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
      createFile('legacy.xls', 'application/vnd.ms-excel'),
      createFile(
        'report.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
      createFile('notes.txt', 'text/plain'),
    ];

    expect(partitionComposeAttachmentFiles(files)).toEqual({
      accepted: files,
      rejected: [],
    });
  });

  it('falls back to allowed extensions for empty or generic MIME types', () => {
    const files = [
      createFile('INVOICE.PDF', ''),
      createFile('LETTER.DoCx', 'application/octet-stream'),
      createFile('LEDGER.XLS', ''),
      createFile('BUDGET.xLsX', 'application/octet-stream'),
      createFile('NOTES.Txt', ''),
    ];

    expect(partitionComposeAttachmentFiles(files)).toEqual({
      accepted: files,
      rejected: [],
    });
  });

  it('rejects allowed extensions with non-generic unsupported MIME types', () => {
    const payload = createFile('payload.pdf', 'application/x-msdownload');

    expect(partitionComposeAttachmentFiles([payload])).toEqual({
      accepted: [],
      rejected: [payload],
    });
  });

  it('preserves each partition order and rejects unsupported files', () => {
    const acceptedText = createFile('first.txt', 'text/plain');
    const rejectedArchive = createFile('archive.zip', 'application/octet-stream');
    const acceptedImage = createFile('second.gif', 'image/gif');
    const rejectedBinary = createFile('payload.bin', '');
    const acceptedPdf = createFile('third.pdf', 'application/pdf');
    const candidates = [
      acceptedText,
      rejectedArchive,
      acceptedImage,
      rejectedBinary,
      acceptedPdf,
    ];

    expect(partitionComposeAttachmentFiles(candidates)).toEqual({
      accepted: [acceptedText, acceptedImage, acceptedPdf],
      rejected: [rejectedArchive, rejectedBinary],
    });
    expect(candidates).toEqual([
      acceptedText,
      rejectedArchive,
      acceptedImage,
      rejectedBinary,
      acceptedPdf,
    ]);
  });
});
