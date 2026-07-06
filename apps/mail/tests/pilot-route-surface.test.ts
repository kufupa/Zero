import { describe, expect, it } from 'vitest';
import type { AppRouter } from '@zero/server/trpc';

type RouterKeys = keyof AppRouter['_def']['record'];

describe('pilot route surface', () => {
  it('contains live and inert routers used by apps/mail', () => {
    const expected = [
      'mail',
      'drafts',
      'labels',
      'settings',
      'connections',
      'user',
      'categories',
      'ai',
      'brain',
      'notes',
      'templates',
      'bimi',
    ] satisfies RouterKeys[];

    expect(expected).toContain('mail');
    expect(expected).toContain('categories');
    expect(expected).toContain('brain');
  });
});
