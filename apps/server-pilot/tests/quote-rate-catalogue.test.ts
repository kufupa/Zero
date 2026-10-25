import { describe, expect, it } from 'vitest';
import { appRouter } from '../src/trpc/router.js';

function signedInCaller(transportId = 'transport-centurion') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: 'staff-1', email: 'staff@example.test', name: 'Staff' },
    activeTransportId: transportId,
    accessRole: 'owner',
    transportEmail: 'staff@example.test',
  } as never);
}

function anonymousCaller() {
  return appRouter.createCaller({
    auth: { api: { getSession: async () => null } } as never,
    reqHeaders: new Headers(),
  } as never);
}

describe('mailbox-scoped quote pane configuration', () => {
  it('keeps Centurion room, rate, and override choices unchanged', async () => {
    const config = await signedInCaller().quoteWorkflow.rateCatalogue();
    expect(config).toMatchObject({
      propertyCode: 'HRCEN',
      transportId: 'transport-centurion',
      roomTypes: [
        { code: 'STWN', label: 'Standard Twin' },
        { code: 'STQN', label: 'Standard Queen' },
        { code: 'SKNG', label: 'Standard King' },
        { code: 'EXKNG', label: 'Executive King' },
        { code: 'DLXTWN', label: 'Deluxe Twin' },
        { code: 'DLXQN', label: 'Deluxe Queen' },
        { code: 'DLXKNG', label: 'Deluxe King' },
        { code: 'LUXKNG', label: 'Luxury King' },
        { code: 'SUITE', label: 'Suite' },
      ],
      boards: ['room_only', 'bb', 'dinner_bb'],
      salesStrategies: [
        { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
        { code: 'GOV', label: 'Government', requestValue: 'Government' },
      ],
      overrideRateCodes: ['NCOR1B', 'NCOR2B', 'BAR', 'GNC3B', 'GNC4B'],
      eventRateCodes: ['GNC3B', 'GNC4B'],
    });
    expect(config.ratePlans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'BAR', name: 'Best Available Rate', board: 'bed_breakfast' }),
        expect.objectContaining({ code: 'NCOR1B', board: 'unknown', contract: true }),
        expect.objectContaining({ code: 'GNC3B', event: true }),
        expect.objectContaining({ code: 'NGOVB', government: true }),
      ]),
    );
  });

  it('loads Da Vinci room, plan, board, and override choices from its property profile only', async () => {
    const config = await signedInCaller('transport-davinci').quoteWorkflow.rateCatalogue();
    expect(config).toMatchObject({
      propertyCode: 'HRDAV',
      transportId: 'transport-davinci',
      roomTypes: [
        { code: 'JNRSUI', label: 'Junior Suite' },
        { code: 'EXKNGB', label: 'Executive King Balcony' },
        { code: 'EXKNGR', label: 'Executive King Round' },
        { code: 'EXKNGS', label: 'Executive King Square' },
        { code: 'DLXPAT', label: 'Deluxe Patio' },
        { code: 'DLXKNG', label: 'Deluxe King' },
        { code: 'ACCES', label: 'Accessible' },
        { code: 'STKNG', label: 'Standard King' },
        { code: 'STWN', label: 'Standard Twin' },
      ],
      boards: ['room_only', 'bb'],
      salesStrategies: [
        { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
        { code: 'PROMO', label: 'Promotions', requestValue: 'PROMO' },
        { code: 'PRESET', label: 'Preset', requestValue: 'PRESET' },
        { code: 'WS', label: 'Wholesale', requestValue: 'WS' },
        { code: 'NC', label: 'Negoticated Contracted', requestValue: 'NC' },
        { code: 'GOV', label: 'Government', requestValue: 'Government' },
        { code: 'AIR', label: 'Airline Crews', requestValue: 'AIR' },
        { code: 'DOML', label: 'Domestic Leisure', requestValue: 'DOML' },
        { code: 'OTHER', label: 'Other', requestValue: 'OTHER' },
      ],
      overrideRateCodes: ['BAR', 'BARRO', 'BLRB', 'BARDIS', 'DEF'],
      eventRateCodes: [],
    });
    expect(config.roomTypes.map(({ code }) => code)).not.toContain('STQN');
    expect(config.ratePlans.map(({ code }) => code)).toEqual(['BAR', 'BARRO', 'BLRB', 'BARDIS', 'DEF']);
  });

  it('refuses unknown and collector mailboxes instead of falling back to Centurion', async () => {
    for (const transportId of ['transport-unknown', 'transport-nava']) {
      await expect(signedInCaller(transportId).quoteWorkflow.rateCatalogue()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    }
  });

  it('requires an authenticated session', async () => {
    await expect(anonymousCaller().quoteWorkflow.rateCatalogue()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
