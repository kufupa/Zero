// @vitest-environment happy-dom
import { uniqueVerifiedFiles } from '../hooks/draft-artifact-files';
import { webcrypto } from 'node:crypto';
import { expect, it } from 'vitest';
it('same name and length with different bytes does not suppress verified file', async () => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  const file = (body: string) =>
    ({
      name: 'quote.pdf',
      size: body.length,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    }) as File;
  const verified = file('%PDF-B'),
    old = file('%PDF-A');
  expect(await uniqueVerifiedFiles([old], [verified])).toEqual([verified]);
  expect(await uniqueVerifiedFiles([verified], [verified])).toEqual([]);
});
