import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPssnelHdrStructure } from '../src/hms/pssnel-hdr-structure.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  'fixtures/hms/pssnel-hdr-structure.live-faithful.v1.json',
);

/**
 * Synthetic HDR body shaped like Wave A3 live open (~28kB structure):
 * field names + toolbar labels + grid col names only — no row PII.
 */
function liveFaithfulHdrBody(): string {
  const meta = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    fieldNamesSample: string[];
    toolbarSample: string[];
    gridCols: string[];
    hdrBytesHint: number;
  };
  const core = JSON.stringify({
    pageData: {
      success: true,
      functionName: 'PSSNEL',
      toolbar: meta.toolbarSample.map((label) => ({ label, itemId: 'tb' })),
      fields: meta.fieldNamesSample.map((name) => ({ name, xtype: 'textfield' })),
      grid: {
        GRIDRESULT: {
          type: 'LIST.DATA_ONLY.STORED',
          GRID: {
            COLUMNS: meta.gridCols.map((name) => ({ name, header: name })),
            DATA: [],
          },
        },
      },
    },
  });
  // Pad to live-ish byte size without inventing PII values.
  const pad = ' '.repeat(Math.max(0, meta.hdrBytesHint - Buffer.byteLength(core)));
  return core + pad;
}

describe('extractPssnelHdrStructure (live-faithful Wave A3)', () => {
  it('recovers grid/toolbar/field markers from sanitized live dump shape', () => {
    const body = liveFaithfulHdrBody();
    const got = extractPssnelHdrStructure(body);
    expect(got.envelopeRecognized).toBe(true);
    expect(got.hasSentEmailToolbar).toBe(true);
    expect(got.hdrBytes).toBeGreaterThan(20_000);
    expect(got.gridCols).toEqual(
      expect.arrayContaining([
        'property',
        'emailtype',
        'account',
        'accountname',
        'subject',
        'emailaddress',
        'attachment',
        'userid',
        'error',
      ]),
    );
    expect(got.toolbarSample).toEqual(
      expect.arrayContaining([
        'All Sent Email',
        'Email Type',
        'Email Address',
        'Attachment',
      ]),
    );
    expect(got.fieldNamesSample).toEqual(
      expect.arrayContaining(['property', 'emailtype', 'subject', 'emailaddress']),
    );
    const serialized = JSON.stringify(got);
    expect(serialized).not.toMatch(/@example\.com/i);
    expect(serialized).not.toMatch(/Reservation confirmation/i);
  });

  it('fails closed on empty / login-looking body', () => {
    const empty = extractPssnelHdrStructure('<html><title>Sign in</title></html>');
    expect(empty.envelopeRecognized).toBe(false);
    expect(empty.hasSentEmailToolbar).toBe(false);
    expect(empty.gridCols).toEqual([]);
  });
});
