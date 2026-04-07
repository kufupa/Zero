import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { centurionCorpusFileSchema } from '../src/lib/demo-mail/centurion-corpus.schema';
import { getCenturionDemoThread, loadCenturionCorpus } from '../src/lib/demo-mail/index';
import { centurionThreadToGetResponse } from '../src/lib/demo-mail/map-to-thread-response';

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsonPath = join(__dirname, '../src/lib/demo-mail/centurion-threads.json');

describe('centurion corpus', () => {
  it('parses centurion-threads.json', () => {
    const raw = readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(raw) as unknown;
    const parsed = centurionCorpusFileSchema.safeParse(data);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format(), null, 2)).toBe(
      true,
    );
    if (parsed.success) {
      expect(parsed.data.threads.length).toBeGreaterThanOrEqual(15);
    }
  });

  it('maps each thread to a valid get payload', () => {
    const { threads } = loadCenturionCorpus();
    for (const t of threads) {
      const res = centurionThreadToGetResponse(t);
      expect(res.latest && !res.latest.isDraft).toBe(true);
      expect(res.messages.length).toBeGreaterThan(0);
      const draft = res.messages.filter((m) => m.isDraft);
      expect(draft.length).toBeLessThanOrEqual(1);
      if (t.draft.bodyText.trim().length > 0) {
        expect(draft.length).toBe(1);
      }
    }
  });

  it('lookup by id works', () => {
    const { threads } = loadCenturionCorpus();
    const first = getCenturionDemoThread(threads[0].id);
    expect(first).not.toBeNull();
  });
});
