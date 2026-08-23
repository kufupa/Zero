import { describe, expect, it } from 'vitest';
import { trpcMailProcedureNamesFromUrl } from './e2e/read-only-mail-procedure-audit';

describe('read-only mail procedure URL audit', () => {
  it('classifies valid mail procedures without reading request payloads', () => {
    expect(
      trpcMailProcedureNamesFromUrl(
        'https://nava.legacyhotels.co.za/trpc/mail.get,mail.listThreads?batch=1',
      ),
    ).toEqual({
      procedures: ['mail.get', 'mail.listThreads'],
      hasUnclassifiedMailSurface: false,
    });
    expect(
      trpcMailProcedureNamesFromUrl(
        'https://nava.legacyhotels.co.za/trpc/drafts.create%2Cmail.get?batch=1',
      ),
    ).toEqual({
      procedures: ['drafts.create', 'mail.get'],
      hasUnclassifiedMailSurface: false,
    });
  });

  it('fails closed for malformed or undecodable mail procedure paths', () => {
    for (const url of [
      'https://nava.legacyhotels.co.za/trpc/mail.get%ZZ',
      'https://nava.legacyhotels.co.za/trpc/mail.get,mail.not-valid',
      'https://nava.legacyhotels.co.za/trpc/mail%2Fget',
      'not a URL /trpc/drafts/create',
    ]) {
      expect(trpcMailProcedureNamesFromUrl(url)).toMatchObject({
        hasUnclassifiedMailSurface: true,
      });
    }
  });
});
