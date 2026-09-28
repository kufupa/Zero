import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  persistStagehandCapture,
  projectStagehandResponseRecord,
} from '../src/hms/stagehand-capture-persistence.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('Stagehand capture persistence', () => {
  it('keeps valid financial responses when one diagnostic record is rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-stagehand-persistence-'));
    const path = join(root, 'network.json');
    const secret = 'SYNTH-RESPONSE-CREDENTIAL';
    try {
      const result = await persistStagehandCapture(
        path,
        [
          {
            kind: 'response',
            path: '/web/base/OSLEDG',
            body: JSON.stringify({ amount: '125.00', currency: 'ZAR', token: secret }),
          },
          {
            kind: 'pageerror',
            at: '2099-01-15T00:00:00.000Z',
            message: 'SYNTH-RAW-DIAGNOSTIC',
          },
        ],
        'response-body',
      );

      expect(result).toMatchObject({
        ok: false,
        partial: true,
        rejectedCount: 1,
        reason: 'UNSAFE_SECRET_CONTENT',
      });
      const persisted = JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, unknown>>;
      expect(persisted).toHaveLength(2);
      expect(persisted[0]).toMatchObject({
        kind: 'response',
        path: '/web/base/OSLEDG',
      });
      expect(String(persisted[0]?.body)).toContain('"amount":"125.00"');
      expect(String(persisted[0]?.body)).toContain('"currency":"ZAR"');
      expect(JSON.stringify(persisted)).not.toContain(secret);
      expect(persisted[1]).toEqual({
        captureRedaction: {
          ok: false,
          code: 'CAPTURE_REDACTION_REQUIRED',
          index: 1,
          reason: 'UNSAFE_SECRET_CONTENT',
        },
      });
      expect(JSON.stringify(persisted)).not.toContain('SYNTH-RAW-DIAGNOSTIC');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves generic artifact fail-closed persistence without raw fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-stagehand-persistence-'));
    const path = join(root, 'command-error.json');
    const secret = 'SYNTH-RAW-COMMAND-ERROR';
    try {
      const result = await persistStagehandCapture(path, { message: secret }, 'message');

      expect(result).toMatchObject({
        ok: false,
        partial: false,
        rejectedCount: 1,
        reason: 'UNSAFE_SECRET_CONTENT',
      });
      const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      expect(persisted).toEqual({
        captureRedaction: {
          ok: false,
          code: 'CAPTURE_REDACTION_REQUIRED',
          reason: 'UNSAFE_SECRET_CONTENT',
        },
      });
      expect(JSON.stringify(persisted)).not.toContain(secret);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records separate source and canonical hashes for an accepted response body', () => {
    const secret = 'SYNTH-RESPONSE-TOKEN';
    const bodyRaw = ` { "amount": "125.00", "token": "${secret}" }\n`;
    const projection = projectStagehandResponseRecord(bodyRaw);

    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(projection.body).toContain('"amount":"125.00"');
    expect(projection.body).not.toContain(secret);
    expect(projection.originalBodySha256).toBe(sha256(bodyRaw));
    expect(projection.storedBodySha256).toBe(sha256(projection.body));
    expect(projection.storedBodySha256).not.toBe(projection.originalBodySha256);
    expect(JSON.stringify(projection)).not.toContain(secret);
  });

  it('retains only a raw hash and safe unavailable metadata for unsupported response text', () => {
    const bodyRaw = 'SYNTH-UNSUPPORTED-BODY';
    const projection = projectStagehandResponseRecord(bodyRaw);

    expect(projection).toEqual({
      ok: false,
      bodyUnavailable: true,
      bodyRedaction: 'UNSAFE_SECRET_CONTENT',
      originalBodySha256: sha256(bodyRaw),
    });
    expect('storedBodySha256' in projection).toBe(false);
    expect(JSON.stringify(projection)).not.toContain(bodyRaw);
  });
});
