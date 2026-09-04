import { describe, expect, it } from 'vitest';
import {
  MAX_CATCHUP_FILE_BYTES,
  ALLOWED_CATCHUP_EXTENSIONS,
  validateCatchupFile,
  computeUploadProgress,
} from '../lib/catchup-upload-client';

describe('catchup upload client validation and helpers', () => {
  it('defines max 50 GB limit and allowed extensions', () => {
    expect(MAX_CATCHUP_FILE_BYTES).toBe(53687091200);
    expect(ALLOWED_CATCHUP_EXTENSIONS).toEqual(['.pst', '.zip', '.msg']);
  });

  it('validates allowed extensions and sizes', () => {
    expect(validateCatchupFile({ name: 'archive.pst', size: 1024 })).toEqual({ valid: true });
    expect(validateCatchupFile({ name: 'sent.ZIP', size: 100 * 1024 * 1024 })).toEqual({ valid: true });
    expect(validateCatchupFile({ name: 'message.msg', size: 5000 })).toEqual({ valid: true });
    expect(validateCatchupFile({ name: 'huge.pst', size: MAX_CATCHUP_FILE_BYTES })).toEqual({ valid: true });
  });

  it('rejects disallowed extensions', () => {
    const res = validateCatchupFile({ name: 'notes.pdf', size: 1024 });
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toMatch(/Allowed formats: \.pst, \.zip, \.msg/i);
    }
  });

  it('rejects empty or oversized files', () => {
    const emptyRes = validateCatchupFile({ name: 'empty.pst', size: 0 });
    expect(emptyRes.valid).toBe(false);

    const overRes = validateCatchupFile({ name: 'too-big.pst', size: MAX_CATCHUP_FILE_BYTES + 1 });
    expect(overRes.valid).toBe(false);
    if (!overRes.valid) {
      expect(overRes.error).toMatch(/exceeds maximum 50 GB limit/i);
    }
  });

  it('computes percentage and byte progress formatted string', () => {
    const half = computeUploadProgress(50 * 1024 * 1024, 100 * 1024 * 1024);
    expect(half.percent).toBe(50);
    expect(half.formattedUploaded).toBe('50 MB');
    expect(half.formattedTotal).toBe('100 MB');

    const zero = computeUploadProgress(0, 1000);
    expect(zero.percent).toBe(0);

    const complete = computeUploadProgress(1000, 1000);
    expect(complete.percent).toBe(100);
  });
});
