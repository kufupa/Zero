/** Additive insert-only provisioner. Never deletes, never re-passwords, never rewrites grants. */
import { mailboxAccess, mailboxTransport } from './schema/mail.js';
import { account, user as userTable } from './schema/auth.js';
import { hashPassword } from 'better-auth/crypto';
import type { PilotUserSpec } from './seed.js';
import type { DB } from './client.js';
import * as seed from './seed.js';
import { sql } from 'drizzle-orm';

const hotel = (id: string, email: string, displayName: string, aliases: readonly string[]) => ({
  id,
  email,
  ownerHeaderValue: email,
  displayName,
  aliases,
});
const grant = (userId: string, transportId: string, isDefault: boolean) => ({
  userId,
  transportId,
  role: 'owner' as const,
  isDefault,
});

export const PROVISION_SPEC = {
  users: [
    { id: 'user-davinci', name: 'Da Vinci Reservations', email: seed.DAVINCI_TRANSPORT_EMAIL },
    { id: 'user-faith', name: 'Faith Khumalo', email: seed.FAITH_TRANSPORT_EMAIL },
    { id: 'user-ayanda', name: 'Ayanda Dladla', email: seed.AYANDA_TRANSPORT_EMAIL },
    { id: 'user-epick', name: 'Elizabeth Pick', email: seed.EPICK_TRANSPORT_EMAIL },
    { id: 'user-kmgidi', name: 'Khanyisile Mgidi', email: seed.KMGIDI_TRANSPORT_EMAIL },
  ],
  transports: [
    hotel(
      seed.DAVINCI_TRANSPORT_ID,
      seed.DAVINCI_TRANSPORT_EMAIL,
      seed.DAVINCI_TRANSPORT_DISPLAY_NAME,
      seed.DAVINCI_TRANSPORT_ALIASES,
    ),
    hotel(
      seed.FAITH_TRANSPORT_ID,
      seed.FAITH_TRANSPORT_EMAIL,
      seed.FAITH_TRANSPORT_DISPLAY_NAME,
      seed.FAITH_TRANSPORT_ALIASES,
    ),
    hotel(
      seed.AYANDA_TRANSPORT_ID,
      seed.AYANDA_TRANSPORT_EMAIL,
      seed.AYANDA_TRANSPORT_DISPLAY_NAME,
      seed.AYANDA_TRANSPORT_ALIASES,
    ),
    hotel(
      seed.EPICK_TRANSPORT_ID,
      seed.EPICK_TRANSPORT_EMAIL,
      seed.EPICK_TRANSPORT_DISPLAY_NAME,
      seed.EPICK_TRANSPORT_ALIASES,
    ),
    hotel(
      seed.KMGIDI_TRANSPORT_ID,
      seed.KMGIDI_TRANSPORT_EMAIL,
      seed.KMGIDI_TRANSPORT_DISPLAY_NAME,
      seed.KMGIDI_TRANSPORT_ALIASES,
    ),
  ],
  grants: [
    grant('user-davinci', seed.DAVINCI_TRANSPORT_ID, true),
    grant('user-faith', seed.FAITH_TRANSPORT_ID, true),
    grant('user-ayanda', seed.AYANDA_TRANSPORT_ID, true),
    grant('user-epick', seed.EPICK_TRANSPORT_ID, true),
    grant('user-kmgidi', seed.KMGIDI_TRANSPORT_ID, true),
    grant(seed.NAVA_USER_ID, seed.DAVINCI_TRANSPORT_ID, false),
    grant(seed.NAVA_USER_ID, seed.FAITH_TRANSPORT_ID, false),
    grant(seed.NAVA_USER_ID, seed.AYANDA_TRANSPORT_ID, false),
    grant(seed.NAVA_USER_ID, seed.EPICK_TRANSPORT_ID, false),
    grant(seed.NAVA_USER_ID, seed.KMGIDI_TRANSPORT_ID, false),
  ],
};

export type ProvisionSpec = {
  users: readonly PilotUserSpec[];
  transports: readonly ProvisionTransportSpec[];
  grants: readonly ProvisionGrantSpec[];
};
export type ProvisionTransportSpec = {
  id: string;
  email: string;
  ownerHeaderValue: string;
  displayName: string;
  aliases: readonly string[];
};
export type ProvisionGrantSpec = {
  userId: string;
  transportId: string;
  role: 'owner';
  isDefault: boolean;
};
export type ProvisionPlan = {
  usersToCreate: PilotUserSpec[];
  transportsToCreate: ProvisionTransportSpec[];
  inactiveTransports: string[];
  grantsToCreate: ProvisionGrantSpec[];
  alreadyPresent: { users: string[]; transports: string[]; grants: string[] };
  transportDrift: Array<{ id: string; field: string; expected: unknown; actual: unknown }>;
};

export const STALE_PLAN_MESSAGE = 'stale plan, re-run dry-run';

const grantRowId = (g: ProvisionGrantSpec) => `access-${g.userId}-${g.transportId}`;

function emailKey(email: string): string {
  return email.toLowerCase();
}

function resolveSpecUsers(spec: ProvisionSpec, rows: Array<{ id: string; email: string }>): {
  usersToCreate: PilotUserSpec[];
  alreadyUsers: string[];
  effectiveUserId: Map<string, string>;
} {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byEmail = new Map<string, Array<{ id: string; email: string }>>();
  for (const row of rows) {
    const key = emailKey(row.email);
    const list = byEmail.get(key) ?? [];
    list.push(row);
    byEmail.set(key, list);
  }

  const usersToCreate: PilotUserSpec[] = [];
  const alreadyUsers: string[] = [];
  const effectiveUserId = new Map<string, string>();
  const specUserIds = new Set(spec.users.map((row) => row.id));

  for (const user of spec.users) {
    const idMatch = byId.get(user.id);
    const emailMatches = byEmail.get(emailKey(user.email)) ?? [];
    if (emailMatches.length > 1) {
      throw new Error(
        `provision plan error: ${user.id} email maps to multiple existing users (${emailMatches.map((r) => r.id).join(', ')})`,
      );
    }
    const emailMatch = emailMatches[0];
    if (idMatch && emailKey(idMatch.email) !== emailKey(user.email)) {
      throw new Error(
        `provision plan error: ${user.id} exists with a different email; aborting (no grants)`,
      );
    }
    if (idMatch && emailMatch && idMatch.id !== emailMatch.id) {
      throw new Error(
        `provision plan error: ${user.id} and email point to different existing users (${idMatch.id} vs ${emailMatch.id})`,
      );
    }
    if (emailMatch && emailMatch.id !== user.id && specUserIds.has(emailMatch.id)) {
      throw new Error(
        `provision plan error: ${user.id} email resolves to a different spec user (${emailMatch.id}); aborting (no grants)`,
      );
    }
    const existing = idMatch ?? emailMatch;
    if (existing) {
      // Name is not compared: a different spec name on an existing row is not an
      // error and is never rewritten (planner is insert-only).
      alreadyUsers.push(existing.id);
      effectiveUserId.set(user.id, existing.id);
    } else {
      usersToCreate.push(user);
      effectiveUserId.set(user.id, user.id);
    }
  }

  return { usersToCreate, alreadyUsers, effectiveUserId };
}

export async function planProvision(db: DB, spec: ProvisionSpec): Promise<ProvisionPlan> {
  // id+email only — name is intentionally not selected or compared.
  const userRows = await db.select({ id: userTable.id, email: userTable.email }).from(userTable);
  const transportRows = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      isActive: mailboxTransport.isActive,
      displayName: mailboxTransport.displayName,
      ownerHeaderValue: mailboxTransport.ownerHeaderValue,
    })
    .from(mailboxTransport);
  const grantRows = await db
    .select({ userId: mailboxAccess.userId, transportId: mailboxAccess.transportId })
    .from(mailboxAccess);

  const { usersToCreate, alreadyUsers, effectiveUserId } = resolveSpecUsers(spec, userRows);
  const transportsById = new Map(transportRows.map((row) => [row.id, row]));
  const grantKeys = new Set(grantRows.map((row) => `${row.userId}\0${row.transportId}`));

  const transportsToCreate: ProvisionTransportSpec[] = [];
  const alreadyTransports: string[] = [];
  const inactiveTransports: string[] = [];
  const transportDrift: ProvisionPlan['transportDrift'] = [];
  for (const transport of spec.transports) {
    const existing = transportsById.get(transport.id);
    if (!existing) {
      transportsToCreate.push(transport);
      continue;
    }
    alreadyTransports.push(transport.id);
    if (existing.isActive === false) inactiveTransports.push(transport.id);
    for (const field of ['email', 'displayName', 'ownerHeaderValue'] as const) {
      if (transport[field] !== existing[field]) {
        transportDrift.push({
          id: transport.id,
          field,
          expected: transport[field],
          actual: existing[field],
        });
      }
    }
  }

  const grantsToCreate: ProvisionGrantSpec[] = [];
  const alreadyGrants: string[] = [];
  for (const grant of spec.grants) {
    const resolved: ProvisionGrantSpec = {
      ...grant,
      userId: effectiveUserId.get(grant.userId) ?? grant.userId,
    };
    if (grantKeys.has(`${resolved.userId}\0${resolved.transportId}`))
      alreadyGrants.push(grantRowId(resolved));
    else grantsToCreate.push(resolved);
  }

  return {
    usersToCreate,
    transportsToCreate,
    inactiveTransports,
    grantsToCreate,
    alreadyPresent: { users: alreadyUsers, transports: alreadyTransports, grants: alreadyGrants },
    transportDrift,
  };
}

function insertOrStale<T>(rows: T[]): void {
  if (rows.length === 0) throw new Error(STALE_PLAN_MESSAGE);
}

export async function applyProvision(
  db: DB,
  plan: ProvisionPlan,
  credentials: Record<string, string>,
  beforeCommit?: () => void | Promise<void>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('nava-provision'), 0)`);
    for (const spec of plan.usersToCreate) {
      const password = credentials[spec.email];
      if (!password) throw new Error(`provision missing password for ${spec.id}`);
      insertOrStale(
        await tx
          .insert(userTable)
          .values({ id: spec.id, name: spec.name, email: spec.email, emailVerified: true })
          .onConflictDoNothing({ target: userTable.id })
          .returning({ id: userTable.id }),
      );
      insertOrStale(
        await tx
          .insert(account)
          .values({
            id: seed.credentialAccountId(spec.id),
            userId: spec.id,
            accountId: spec.id,
            providerId: 'credential',
            password: await hashPassword(password),
          })
          .onConflictDoNothing({ target: account.id })
          .returning({ id: account.id }),
      );
    }
    for (const spec of plan.transportsToCreate) {
      insertOrStale(
        await tx
          .insert(mailboxTransport)
          .values({
            id: spec.id,
            email: spec.email,
            ownerHeaderValue: spec.ownerHeaderValue,
            mailboxType: 'personal',
            displayName: spec.displayName,
            isActive: true,
            sendFromConfig: { aliases: [...spec.aliases] },
          })
          .onConflictDoNothing({ target: mailboxTransport.id })
          .returning({ id: mailboxTransport.id }),
      );
      await seed.seedSpamLabel(tx, spec.id);
      await seed.seedAiManagedCategories(tx, spec.id, { onConflict: 'nothing' });
    }
    for (const grant of plan.grantsToCreate) {
      insertOrStale(
        await tx
          .insert(mailboxAccess)
          .values({
            id: grantRowId(grant),
            userId: grant.userId,
            transportId: grant.transportId,
            role: grant.role,
            isDefault: grant.isDefault,
          })
          .onConflictDoNothing({ target: mailboxAccess.id })
          .returning({ id: mailboxAccess.id }),
      );
    }
    if (beforeCommit) await beforeCommit();
  });
}

export async function applyProvisionThenWriteCredentials(
  db: DB,
  plan: ProvisionPlan,
  credentials: Record<string, string>,
  write: (payload: Record<string, { password: string }>) => void,
): Promise<void> {
  const payload: Record<string, { password: string }> = {};
  for (const user of plan.usersToCreate) {
    const password = credentials[user.email];
    if (!password) throw new Error(`provision missing password for ${user.id}`);
    payload[user.email] = { password };
  }
  await applyProvision(db, plan, credentials, () => write(payload));
}
