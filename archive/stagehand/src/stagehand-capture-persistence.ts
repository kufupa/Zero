import { createHash } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import {
  redactStagehandCapture,
  type StagehandCaptureKind,
} from './stagehand-capture-redaction.js';

const CAPTURE_REDACTION_REQUIRED = 'CAPTURE_REDACTION_REQUIRED';

export type StagehandCapturePersistenceResult = {
  ok: boolean;
  partial: boolean;
  rejectedCount: number;
  redactedPaths?: string[];
  reason?: string;
};

export type StagehandResponseRecordProjection =
  | {
      ok: true;
      body: string;
      originalBodySha256: string;
      storedBodySha256: string;
      redactedPaths: string[];
    }
  | {
      ok: false;
      bodyUnavailable: true;
      bodyRedaction: string;
      originalBodySha256: string;
    };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function captureFailure(reason: string, index?: number): Record<string, unknown> {
  return {
    captureRedaction: {
      ok: false,
      code: CAPTURE_REDACTION_REQUIRED,
      ...(index === undefined ? {} : { index }),
      reason,
    },
  };
}

/**
 * Project one original response body into the exact canonical representation
 * that may be stored. The source hash is computed before redaction; an
 * unsupported body has no stored hash because no canonical body was accepted.
 */
export function projectStagehandResponseRecord(bodyRaw: string): StagehandResponseRecordProjection {
  const originalBodySha256 = sha256(bodyRaw);
  const redacted = redactStagehandCapture(bodyRaw, 'response-body');
  if (!redacted.ok) {
    return {
      ok: false,
      bodyUnavailable: true,
      bodyRedaction: redacted.reason,
      originalBodySha256,
    };
  }
  return {
    ok: true,
    body: redacted.value,
    originalBodySha256,
    storedBodySha256: sha256(redacted.value),
    redactedPaths: redacted.redactedPaths,
  };
}

/**
 * Persist one private trial artifact only after the shared fail-closed
 * projection has accepted it. The returned status is useful to tests and
 * diagnostics; callers must never fall back to the original value.
 */
export async function persistStagehandCapture(
  path: string,
  data: unknown,
  kind: StagehandCaptureKind,
): Promise<StagehandCapturePersistenceResult> {
  if (kind === 'response-body' && Array.isArray(data)) {
    const persisted: unknown[] = [];
    const redactedPaths = new Set<string>();
    let rejectedCount = 0;
    let reason: string | undefined;
    for (const [index, record] of data.entries()) {
      const redacted = redactStagehandCapture(record, kind);
      if (!redacted.ok) {
        rejectedCount += 1;
        reason ??= redacted.reason;
        persisted.push(captureFailure(redacted.reason, index));
        continue;
      }
      persisted.push(redacted.value);
      for (const path of redacted.redactedPaths) {
        redactedPaths.add(`$[${index}]${path.slice(1)}`);
      }
    }
    await writeFile(path, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    await chmod(path, 0o600);
    return {
      ok: rejectedCount === 0,
      partial: rejectedCount > 0 && rejectedCount < data.length,
      rejectedCount,
      redactedPaths: [...redactedPaths].sort(),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  const redacted = redactStagehandCapture(data, kind);
  const persisted = redacted.ok
    ? redacted.value
    : captureFailure(redacted.reason);
  await writeFile(path, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
  return redacted.ok
    ? { ok: true, partial: false, rejectedCount: 0, redactedPaths: redacted.redactedPaths }
    : { ok: false, partial: false, rejectedCount: 1, reason: redacted.reason };
}
