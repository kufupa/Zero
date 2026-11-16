/**
 * Settings router: per-user settings CRUD.
 *
 * Settings are keyed by `userId` (not transport). The frontend `useSettings`
 * hook calls `settings.get` (no input) and `settings.save(settings)`. We
 * upsert a `userSettings` row for the caller.
 */
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { privateProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { userSettings } from '../../db/schema/app.js';
import {
  userSettingsSchema,
  defaultUserSettings,
} from '../../lib/schemas.js';

export const settingsSaveInput = userSettingsSchema.partial();

/**
 * Remembered CMS confirmation recipient, per user and property. Stored in
 * `user_settings.settings.cmsRecipientDefaults[propertyCode]`. The key is kept
 * out of `userSettingsSchema`, so `settings.save` strips it and never clobbers it.
 */
const cmsPropertyInput = z.object({ propertyCode: z.string().regex(/^[A-Z0-9]{2,16}$/) }).strict();
const cmsRecipientDefaultInput = cmsPropertyInput.extend({
  address: z.string().trim().max(255).email().nullable(),
}).strict();

export const settingsRouter = tRouter({
  get: privateProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, ctx.sessionUser.id))
      .limit(1);
    if (rows.length === 0) {
      // No row yet -> return defaults; the frontend normalizes anyway.
      return { id: null, settings: defaultUserSettings };
    }
    const row = rows[0]!;
    return { id: row.id, settings: row.settings };
  }),

  save: privateProcedure
    .input(settingsSaveInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const userId = ctx.sessionUser.id;
      const id = `settings-${userId}`;
      const base = { ...defaultUserSettings, ...input };
      await db
        .insert(userSettings)
        .values({
          id,
          userId,
          settings: base,
        })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: {
            settings: sql`coalesce(${userSettings.settings}, ${JSON.stringify(defaultUserSettings)}::jsonb) || ${JSON.stringify(input)}::jsonb`,
            updatedAt: new Date(),
          },
        });
      return { success: true as const };
    }),

  cmsRecipientDefault: privateProcedure
    .input(cmsPropertyInput)
    .query(async ({ input, ctx }) => {
      const rows = await getDb()
        .select({ settings: userSettings.settings })
        .from(userSettings)
        .where(eq(userSettings.userId, ctx.sessionUser.id))
        .limit(1);
      const stored = (rows[0]?.settings as Record<string, unknown> | undefined)?.cmsRecipientDefaults;
      const address = stored && typeof stored === 'object' && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)[input.propertyCode] : undefined;
      return { address: typeof address === 'string' && address ? address : null };
    }),

  setCmsRecipientDefault: privateProcedure
    .input(cmsRecipientDefaultInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const userId = ctx.sessionUser.id;
      const current = sql`coalesce(${userSettings.settings}, ${JSON.stringify(defaultUserSettings)}::jsonb)`;
      if (input.address === null) {
        await db.update(userSettings)
          .set({ settings: sql`${current} #- array['cmsRecipientDefaults', ${input.propertyCode}::text]`, updatedAt: new Date() })
          .where(eq(userSettings.userId, userId));
        return { address: null };
      }
      const address = input.address;
      await db
        .insert(userSettings)
        .values({ id: `settings-${userId}`, userId,
          settings: { ...defaultUserSettings, cmsRecipientDefaults: { [input.propertyCode]: address } } as typeof defaultUserSettings })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: {
            settings: sql`jsonb_set(${current}, '{cmsRecipientDefaults}',
              coalesce(${current} -> 'cmsRecipientDefaults', '{}'::jsonb) || jsonb_build_object(${input.propertyCode}::text, ${address}::text), true)`,
            updatedAt: new Date(),
          },
        });
      return { address };
    }),
});

void sql;
