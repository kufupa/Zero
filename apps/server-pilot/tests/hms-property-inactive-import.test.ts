import { expect, it, vi } from 'vitest';

it('keeps Centurion routes loadable and refuses an inactive Da Vinci property', async () => {
  const registryPath = '../tooling/playwright-quote/property-registry.mjs';
  vi.resetModules();
  const registryModule = await vi.importActual<
    typeof import('../tooling/playwright-quote/property-registry.mjs')
  >(registryPath);
  const inactiveRegistry = {
    ...registryModule.PROPERTY_REGISTRY,
    properties: registryModule.PROPERTY_REGISTRY.properties.map((property) =>
      property.propertyCode === 'HRDAV' ? { ...property, active: false } : { ...property },
    ),
  };

  vi.doMock(registryPath, () => ({
    ...registryModule,
    PROPERTY_REGISTRY: inactiveRegistry,
    getPropertyRegistration: (propertyCode: string) =>
      inactiveRegistry.properties.find((property) => property.propertyCode === propertyCode) ?? null,
    getPropertyTransportIds: (propertyCode: string) =>
      inactiveRegistry.properties.find((property) => property.propertyCode === propertyCode)?.transportIds ?? [],
    resolvePropertyTransport: (transportId: string, registry = inactiveRegistry) =>
      registryModule.resolvePropertyTransport(transportId, registry),
  }));

  try {
    const readTargets = await import('../src/hms/hms-read-target.js');
    const quoteTargets = await import('../src/hms/hms-quote-target.js');
    const davinciOrigin = { toAddresses: ['davinci@legacyhotels.co.za'] };

    expect(readTargets.hmsReadTargetForTransport('transport-centurion')).toMatchObject({
      propertyCode: 'HRCEN',
    });
    expect(readTargets.isDaVinciTransport('transport-davinci')).toBe(true);
    expect(() => readTargets.hmsReadTargetForTransport('transport-davinci')).toThrow(
      expect.objectContaining({ cause: expect.objectContaining({ code: 'property_inactive' }) }),
    );
    expect(() => readTargets.hmsReadTargetForTransport(davinciOrigin)).toThrow(
      expect.objectContaining({ cause: expect.objectContaining({ code: 'property_inactive' }) }),
    );
    expect(() =>
      readTargets.readTargetForHmsJob({
        transportId: 'transport-centurion',
        origin: davinciOrigin,
        env: { HMS_DAVINCI_READS: 'on' },
      }),
    ).toThrow(expect.objectContaining({ cause: expect.objectContaining({ code: 'property_inactive' }) }));
    expect(() =>
      quoteTargets.quoteTargetForHmsJob({
        transportId: 'transport-centurion',
        origin: davinciOrigin,
        env: { HMS_DAVINCI_MAKE_QUOTE: 'on' },
      }),
    ).toThrow(expect.objectContaining({ cause: expect.objectContaining({ code: 'property_inactive' }) }));
  } finally {
    vi.doUnmock(registryPath);
    vi.resetModules();
  }
});
