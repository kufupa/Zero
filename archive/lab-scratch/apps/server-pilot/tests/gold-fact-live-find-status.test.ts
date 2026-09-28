import { describe, expect, it } from 'vitest';
import {
  classifyOsressResponse,
  isBrowserClosedFindError,
  isOsressSessionPoison,
  statusForOsressFind,
} from '../scripts/gold-fact-live-find-status.mjs';

describe('gold-fact live find status', () => {
  it('never labels loadLocalized 813 stub as not_found', () => {
    const responseClass = classifyOsressResponse(
      'loadLocalizedPage(allcookies);',
      'no_pagedata',
    );
    expect(responseClass).toBe('loadLocalized');
    expect(
      statusForOsressFind({
        parse: 'no_pagedata',
        corrOutcome: 'not_found',
        responseClass,
        hasRoomType: false,
      }),
    ).toBe('loadLocalized');
  });

  it('keeps honest empty GRID as not_found when pageData ok', () => {
    expect(
      statusForOsressFind({
        parse: 'ok',
        corrOutcome: 'not_found',
        responseClass: 'pagedata',
        hasRoomType: false,
      }),
    ).toBe('not_found');
  });

  it('detects poison dumps for retry', () => {
    expect(
      isOsressSessionPoison({
        parse: 'no_pagedata',
        responseClass: 'loadLocalized',
        searchBytes: 813,
        ms: 70,
        status: 'loadLocalized',
      }),
    ).toBe(true);
    expect(
      isOsressSessionPoison({
        parse: 'ok',
        responseClass: 'pagedata',
        searchBytes: 1300,
        ms: 800,
        status: 'partial',
      }),
    ).toBe(false);
  });

  it('detects parallel-find browser-closed race', () => {
    expect(
      isBrowserClosedFindError(
        new Error('apiRequestContext.post: Target page, context or browser has been closed'),
      ),
    ).toBe(true);
    expect(isBrowserClosedFindError(new Error('timeout 60000ms exceeded'))).toBe(false);
  });
});
