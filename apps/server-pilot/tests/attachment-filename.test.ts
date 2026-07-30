import { describe, expect, it } from 'vitest';
import { formatContentDispositionFilename } from '../src/mail/attachment-filename.js';

describe('formatContentDispositionFilename', () => {
  it('strips quotes from evil".pdf', () => {
    const result = formatContentDispositionFilename('evil".pdf');
    expect(result).toBe('attachment; filename="evil.pdf"');
    expect(result).not.toContain('""');
  });

  it('strips CR/LF from invoice\\r\\n.pdf', () => {
    const result = formatContentDispositionFilename('invoice\r\n.pdf');
    expect(result).toBe('attachment; filename="invoice.pdf"');
    expect(result).not.toMatch(/[\r\n]/);
  });

  it('escapes an interior backslash in the quoted fallback', () => {
    const result = formatContentDispositionFilename('folder\\invoice.pdf');
    expect(result).toBe('attachment; filename="folder\\\\invoice.pdf"');
  });

  it('escapes a trailing backslash before the generated closing quote', () => {
    const result = formatContentDispositionFilename('invoice.pdf\\');
    expect(result).toBe('attachment; filename="invoice.pdf\\\\"');
  });

  it('uses RFC 5987 for non-ASCII filenames', () => {
    const result = formatContentDispositionFilename('café.pdf');
    expect(result).toContain("filename*=UTF-8''");
    expect(result).toMatch(/^attachment; filename="[ -~]+"; filename\*=UTF-8''/);
    expect(result).toContain('%C3%A9.pdf');
  });

  it('falls back when sanitization leaves an empty name', () => {
    const result = formatContentDispositionFilename('"\r\n"');
    expect(result).toBe('attachment; filename="attachment"');
  });
});
