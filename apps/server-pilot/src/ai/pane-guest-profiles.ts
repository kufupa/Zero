import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { assertHmsReadOriginAllowed, CENTURION_HMS_READ_TARGET } from '../hms/hms-read-target.js';
import { currentPaneHmsSourceThread, type PaneHmsSource } from './pane-hms-source.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { isGuestSurname } from './pane-stay-lookup.js';

type LookupInput = PaneHmsSource & { threadId: string; sourceHash: string; lastName: string; db?: DB };
const profile = z.object({ nativeId: z.string().regex(/^\d{1,30}$/).nullable(),
  firstName: z.string().max(200).nullable(), lastName: z.string().max(200).nullable(),
  city: z.string().max(200).nullable(), country: z.string().max(200).nullable() }).strict();
const lookupResult = z.object({ status: z.literal('ok'), candidates: z.array(profile).max(50),
  moreAvailable: z.boolean() }).strict();
type Result = z.infer<typeof lookupResult> | { status: 'refused'; reason: string };

export const paneGuestProfileLoaders: { search: null | ((lastName: string) => Promise<unknown>) } = { search: null };

/** A fresh HRCEN read, bound to the selected inbound and current mailbox access on both sides. */
export async function lookupPaneGuestProfiles(input: LookupInput): Promise<Result> {
  const name = input.lastName.trim();
  if (!isGuestSurname(name)) return { status: 'refused', reason: 'invalid_name' };
  const expected = CENTURION_HMS_READ_TARGET;
  const matches = (target: typeof expected) => target.propertyCode === expected.propertyCode &&
    target.origin === expected.origin && target.secretId === expected.secretId &&
    target.browserSlot === expected.browserSlot && target.installationEnvName === expected.installationEnvName;
  const resolved = paneStayHmsTargetForTransport(input.transportId);
  if (!resolved.ok || !matches(resolved.target)) return { status: 'refused', reason: 'property_unavailable' };
  const db = input.db ?? getDb();
  const sourceCurrent = async () => (await currentPaneHmsSourceThread(db, input)) === input.threadId;
  const originAllowed = async () => {
    try { return matches(await assertHmsReadOriginAllowed({ transportId: input.transportId,
      threadId: input.threadId, messageId: input.sourceMessageId })); } catch { return false; }
  };
  if (!await sourceCurrent()) return { status: 'refused', reason: 'source_unavailable' };
  if (!await originAllowed()) return { status: 'refused', reason: 'property_unavailable' };
  try {
    const search = paneGuestProfileLoaders.search ?? (await import(
      new URL('../../tooling/hms-cloud/pane-guest-profiles.mjs', import.meta.url).href
    ) as { searchGuestProfilesForPane: (surname: string) => Promise<unknown> }).searchGuestProfilesForPane;
    const result = lookupResult.safeParse(await search(name));
    if (!await sourceCurrent() || !await originAllowed()) return { status: 'refused', reason: 'source_changed' };
    return result.success ? result.data : { status: 'refused', reason: 'lookup_unavailable' };
  } catch { return { status: 'refused', reason: 'lookup_unavailable' }; }
}
