import { describe, expect, it } from 'vitest';
import {
  formatRehydrateSummary,
  parseRawMimeKey,
  parseRehydrateCliArgs,
} from '../src/mail/ingest/rehydrate-raw-mime';

describe('rehydrate-raw-mime helpers', () => {
  it('parseRawMimeKey extracts ingest mailbox + uidl stem', () => {
    expect(
      parseRawMimeKey(
        'raw-mime/ingest-nava-legacy/257.fv8YAORTGS8O7UKzzToFVCinLVAJ_ROLYEH5gLsOHWo_.eml',
      ),
    ).toEqual({
      key: 'raw-mime/ingest-nava-legacy/257.fv8YAORTGS8O7UKzzToFVCinLVAJ_ROLYEH5gLsOHWo_.eml',
      ingestMailboxId: 'ingest-nava-legacy',
      pop3Uidl: '257.fv8YAORTGS8O7UKzzToFVCinLVAJ_ROLYEH5gLsOHWo_',
    });
  });

  it('parseRawMimeKey rejects non raw-mime keys', () => {
    expect(parseRawMimeKey('attachments/msg/001-a.pdf')).toBeNull();
    expect(parseRawMimeKey('raw-mime/only-one-segment.eml')).toBeNull();
  });

  it('parseRehydrateCliArgs accepts dry-run, triage, limit, prefix', () => {
    expect(
      parseRehydrateCliArgs([
        '--dry-run',
        '--triage',
        '--limit',
        '5',
        '--prefix',
        'raw-mime/ingest-nava-legacy/',
      ]),
    ).toEqual({
      dryRun: true,
      triage: true,
      limit: 5,
      prefix: 'raw-mime/ingest-nava-legacy/',
    });
  });

  it('formatRehydrateSummary is compact', () => {
    expect(
      formatRehydrateSummary({
        scanned: 10,
        skippedExisting: 2,
        skippedQuarantine: 1,
        stored: 5,
        duplicate: 1,
        quarantined: 0,
        errors: 1,
        errorKeys: ['raw-mime/x/a.eml'],
        dryRunKeys: [],
      }),
    ).toContain('stored=5');
  });
});
