import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

describe('server-pilot package contract', () => {
  it(
    'exports modules apps/mail imports via package.json exports map',
    async () => {
      await expect(import('@zero/server/trpc')).resolves.toBeDefined();
      await expect(import('@zero/server/auth')).resolves.toBeDefined();
      await expect(import('@zero/server/auth-providers')).resolves.toBeDefined();
      await expect(import('@zero/server/schemas')).resolves.toBeDefined();
    },
    15_000,
  );

  it('package.json exports map includes mail-facing entrypoints', () => {
    expect(pkg.exports).toMatchObject({
      './trpc': expect.any(String),
      './auth': expect.any(String),
      './auth-providers': expect.any(String),
      './schemas': expect.any(String),
    });
  });

  it('exposes AppRouter type and appRouter value from /trpc', async () => {
    const mod = await import('@zero/server/trpc');
    expect(mod.appRouter).toBeDefined();
    expect(typeof mod.router).toBe('function');
  });

  it('exposes Auth type builder from /auth', async () => {
    const mod = await import('@zero/server/auth');
    expect(typeof mod.createAuth).toBe('function');
  });

  it('exposes EnvVarInfo shape and authProviders from /auth-providers', async () => {
    const mod = await import('@zero/server/auth-providers');
    expect(Array.isArray(mod.authProviders({}))).toBe(true);
    expect(Array.isArray(mod.customProviders)).toBe(true);
    expect(typeof mod.getSocialProviders).toBe('function');
  });

  it('exposes schema constants from /schemas', async () => {
    const mod = await import('@zero/server/schemas');
    expect(mod.userSettingsSchema).toBeDefined();
    expect(mod.defaultUserSettings).toBeDefined();
    expect(Array.isArray(mod.defaultMailCategories)).toBe(true);
    expect(mod.mailCategorySchema).toBeDefined();
    expect(mod.createDraftData).toBeDefined();
    expect(mod.serializedFileSchema).toBeDefined();
    expect(typeof mod.deserializeFiles).toBe('function');
  });
});
