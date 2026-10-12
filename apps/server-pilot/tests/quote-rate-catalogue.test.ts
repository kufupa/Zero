import { describe, expect, it } from 'vitest';
import { appRouter } from '../src/trpc/router.js';

function signedInCaller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: 'staff-1', email: 'staff@example.test', name: 'Staff' },
  } as never);
}

function anonymousCaller() {
  return appRouter.createCaller({
    auth: { api: { getSession: async () => null } } as never,
    reqHeaders: new Headers(),
  } as never);
}

describe('Centurion quote rate catalogue route', () => {
  it('returns the known static codes and their labels/boards without a database read', async () => {
    const catalogue = await signedInCaller().quoteWorkflow.rateCatalogue();
    expect(catalogue.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'BAR', 'BARRO', 'DBB', 'DBBX', 'NCOR1B', 'NCOR2B', 'GNC3B', 'GNC4B',
        'BCO1B', 'BCO2B', 'BBP', 'BWKPB', 'NGOVB',
      ]),
    );
    expect(catalogue.find(({ code }) => code === 'BAR')).toMatchObject({
      name: 'Best Available Rate',
      board: 'bed_breakfast',
    });
    expect(catalogue.find(({ code }) => code === 'NCOR1B')).toMatchObject({
      board: 'unknown',
      contract: true,
    });
    expect(catalogue.find(({ code }) => code === 'GNC3B')).toMatchObject({ event: true });
    expect(catalogue.find(({ code }) => code === 'NGOVB')).toMatchObject({ government: true });
  });

  it('requires an authenticated session', async () => {
    await expect(anonymousCaller().quoteWorkflow.rateCatalogue()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
