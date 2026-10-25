import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { quotePaneConfigForProperty } from '../src/hms/rate-catalogue.js';
import { buildQuoteProposalPdf } from '../src/quote-proposal/proposal-pdf.js';
import { validateProfile } from '../tooling/playwright-quote/property-profile.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/property-registry-hrfake.json', import.meta.url), 'utf8'),
);

it('isolates an injected HRFAKE target and refuses unknown or unsupported outputs', async () => {
  const registryPath = '../tooling/playwright-quote/property-registry.mjs';
  vi.resetModules();
  const registryModule = await vi.importActual<
    typeof import('../tooling/playwright-quote/property-registry.mjs')
  >(registryPath);
  const registry = {
    ...registryModule.PROPERTY_REGISTRY,
    properties: [...registryModule.PROPERTY_REGISTRY.properties, fixture.property],
  };
  registryModule.validatePropertyRegistry(registry);

  const resolved = registryModule.resolvePropertyTransport(fixture.property.mailboxTransportId, registry);
  expect(resolved).toMatchObject({
    kind: 'property',
    property: {
      propertyCode: 'HRFAKE',
      transportIds: ['transport-hrfake', 'transport-hrfake-sales'],
      browserSlot: 'davinci',
    },
  });
  const profile = validateProfile(fixture.profile, 'HRFAKE');
  expect(Object.keys(profile.rooms)).toEqual(['FAKEQ', 'FAKET']);
  expect(Object.keys(profile.ratePlans)).toEqual(['FAKEBB', 'FAKERO', 'FAKEEV']);
  expect(profile.boards).toEqual(['room_only', 'bb', 'dinner_bb']);

  vi.doMock(registryPath, () => ({
    ...registryModule,
    PROPERTY_REGISTRY: registry,
    getPropertyRegistration: (propertyCode: string) =>
      registry.properties.find((property) => property.propertyCode === propertyCode) ?? null,
    getPropertyTransportIds: (propertyCode: string) =>
      registry.properties.find((property) => property.propertyCode === propertyCode)?.transportIds ?? [],
    resolvePropertyTransport: (transportId: string, source = registry) =>
      registryModule.resolvePropertyTransport(transportId, source),
  }));

  try {
    const targets = await import('../src/hms/hms-read-target.js');
    const target = targets.hmsReadTargetForTransport(fixture.property.mailboxTransportId);
    expect(target).toMatchObject({
      propertyCode: 'HRFAKE',
      secretId: 'test-only/hrfake',
      browserSlot: 'davinci',
      installationEnvName: 'RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRFAKE',
    });
    const queued = await targets.resolveHmsReadJobTarget({
      transportId: fixture.property.mailboxTransportId,
      threadId: 'fixture-thread',
      messageId: 'fixture-message',
      env: {},
    });
    expect(queued).toMatchObject({ ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' });
    const jobMetrics = {
      ...targets.hmsReadAuditMetrics({ actorKind: 'user', actorUserId: 'fixture-user', target }),
      ...targets.hmsReadTargetJobMetrics(target),
    };
    expect(jobMetrics).toMatchObject({
      propertyCode: 'HRFAKE',
      slotId: 'davinci',
      hmsReadTarget: { propertyCode: 'HRFAKE', secretId: 'test-only/hrfake' },
    });
    expect(() => targets.hmsReadTargetForTransport('transport-unmapped')).toThrow(
      expect.objectContaining({ cause: expect.objectContaining({ code: 'property_unknown' }) }),
    );

    const paneConfig = await quotePaneConfigForProperty('HRFAKE', fixture.property.mailboxTransportId);
    expect(paneConfig).toBeNull();
    await expect(
      buildQuoteProposalPdf(
        {
          attention: 'Fixture guest', company: 'Fixture agency', clientEmail: 'guest@example.invalid',
          clientTelephone: '000', agency: 'Fixture agency', dateLabel: '1 Nov 2026', propertyCode: 'HRFAKE',
          lines: [{ dateLabel: '1 Nov 2026', qty: 1, roomCode: 'FAKEQ', meal: 'bb', nights: 1, rate: 100 }],
        },
        { name: 'Fixture staff', email: 'staff@example.invalid' },
        'unused',
      ),
    ).rejects.toThrow('unknown_quote_property:HRFAKE');

    for (const output of [resolved, profile, target, queued, jobMetrics, paneConfig]) {
      expect(JSON.stringify(output)).not.toContain('HRCEN');
    }
  } finally {
    vi.doUnmock(registryPath);
    vi.resetModules();
  }
});
