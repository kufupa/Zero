import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../../../../../apps/server-pilot/src/db/client.ts';

vi.mock('../src/ai/shadow-evaluation.js', () => ({
  enqueueShadowPrediction: vi.fn(),
  rematchShadowPredictions: vi.fn(),
}));

import {
  enqueueShadowPrediction,
  rematchShadowPredictions,
} from '../../../../../apps/server-pilot/src/ai/shadow-evaluation.js';
import { runPersistShadowSideEffects } from '../../../../../apps/server-pilot/src/mail/ingest/store.ts';

describe('persist shadow after commit', () => {
  const db = {} as DB;

  beforeEach(() => {
    vi.mocked(enqueueShadowPrediction).mockReset();
    vi.mocked(rematchShadowPredictions).mockReset();
  });

  it('keeps persist success when shadow admission table is missing', async () => {
    vi.mocked(enqueueShadowPrediction).mockRejectedValue(
      new Error('relation "ai_shadow_admission" does not exist'),
    );

    await expect(
      runPersistShadowSideEffects({
        db,
        isHotelSent: false,
        transportId: 'transport-centurion',
        threadId: 'thread-shadow-gate',
        triggerMessageId: 'message-shadow-gate',
      }),
    ).resolves.toEqual({ kind: 'failed' });
  });

  it('keeps persist success when rematch throws after hotel-sent commit', async () => {
    vi.mocked(rematchShadowPredictions).mockRejectedValue(
      new Error('relation "ai_shadow_prediction" does not exist'),
    );

    await expect(
      runPersistShadowSideEffects({
        db,
        isHotelSent: true,
        transportId: 'transport-centurion',
        threadId: 'thread-shadow-rematch',
        triggerMessageId: 'message-shadow-rematch',
      }),
    ).resolves.toEqual({ kind: 'failed' });
  });
});
