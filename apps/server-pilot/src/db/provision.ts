/** Additive insert-only provisioner. Never deletes, never re-passwords, never rewrites grants. */
import { mailboxAccess, mailboxTransport } from './schema/mail.js';
import { account, user as userTable } from './schema/auth.js';
import { hashPassword } from 'better-auth/crypto';
import type { PilotUserSpec } from './seed.js';
import type { DB } from './client.js';
import * as seed from './seed.js';

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
    { id: 'user-davinci', name: 'Da Vinci', email: seed.DAVINCI_TRANSPORT_EMAIL },
    { id: 'user-faith', name: 'Faith', email: seed.FAITH_TRANSPORT_EMAIL },
    { id: 'user-ayanda', name: 'Ayanda', email: seed.AYANDA_TRANSPORT_EMAIL },
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
  ],
  grants: [
    grant('user-davinci', seed.DAVINCI_TRANSPORT_ID, true),
    grant('user-faith', seed.FAITH_TRANSPORT_ID, true),
    grant('user-ayanda', seed.AYANDA_TRANSPORT_ID, true),
    grant(seed.NAVA_USER_ID, seed.DAVINCI_TRANSPORT_ID, false),
    grant(seed.NAVA_USER_ID, seed.FAITH_TRANSPORT_ID, false),
    grant(seed.NAVA_USER_ID, seed.AYANDA_TRANSPORT_ID, false),
  ],
};

export type ProvisionSpec = typeof PROVISION_SPEC;
export type ProvisionTransportSpec = ProvisionSpec['transports'][number];
export type ProvisionGrantSpec = ProvisionSpec['grants'][number];
export type ProvisionPlan = {
  usersToCreate: PilotUserSpec[];
  transportsToCreate: ProvisionTransportSpec[];
  transportsToActivate: string[];
  grantsToCreate: ProvisionGrantSpec[];
  alreadyPresent: { users: string[]; transports: string[]; grants: string[] };
  transportDrift: Array<{ id: string; field: string; expected: unknown; actual: unknown }>;
};

const grantRowId = (g: ProvisionGrantSpec) => `access-${g.userId}-${g.transportId}`;

export async function planProvision(db: DB, spec: ProvisionSpec): Promise<ProvisionPlan> {
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

  const userIds = new Set(userRows.map((row) => row.id));
  const userEmails = new Set(userRows.map((row) => row.email));
  const transportsById = new Map(transportRows.map((row) => [row.id, row]));
  const grantKeys = new Set(grantRows.map((row) => `${row.userId}\0${row.transportId}`));

  const usersToCreate: PilotUserSpec[] = [];
  const alreadyUsers: string[] = [];
  for (const user of spec.users) {
    if (userIds.has(user.id) || userEmails.has(user.email)) alreadyUsers.push(user.id);
    else usersToCreate.push(user);
  }

  const transportsToCreate: ProvisionTransportSpec[] = [];
  const alreadyTransports: string[] = [];
  const transportsToActivate: string[] = [];
  const transportDrift: ProvisionPlan['transportDrift'] = [];
  for (const transport of spec.transports) {
    const existing = transportsById.get(transport.id);
    if (!existing) {
      transportsToCreate.push(transport);
      continue;
    }
    alreadyTransports.push(transport.id);
    if (existing.isActive === false) transportsToActivate.push(transport.id);
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
    if (grantKeys.has(`${grant.userId}\0${grant.transportId}`))
      alreadyGrants.push(grantRowId(grant));
    else grantsToCreate.push(grant);
  }

  return {
    usersToCreate,
    transportsToCreate,
    transportsToActivate,
    grantsToCreate,
    alreadyPresent: { users: alreadyUsers, transports: alreadyTransports, grants: alreadyGrants },
    transportDrift,
  };
}

export async function applyProvision(
  db: DB,
  plan: ProvisionPlan,
  credentials: Record<string, string>,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const spec of plan.usersToCreate) {
      const password = credentials[spec.email];
      if (!password) throw new Error(`provision missing password for ${spec.id}`);
      await tx
        .insert(userTable)
        .values({ id: spec.id, name: spec.name, email: spec.email, emailVerified: true })
        .onConflictDoNothing({ target: userTable.id });
      await tx
        .insert(account)
        .values({
          id: seed.credentialAccountId(spec.id),
          userId: spec.id,
          accountId: spec.id,
          providerId: 'credential',
          password: await hashPassword(password),
        })
        .onConflictDoNothing({ target: account.id });
    }
    for (const spec of plan.transportsToCreate) {
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
        .onConflictDoNothing({ target: mailboxTransport.id });
      await seed.seedSpamLabel(tx, spec.id);
      await seed.seedAiManagedCategories(tx, spec.id);
    }
    for (const grant of plan.grantsToCreate) {
      await tx
        .insert(mailboxAccess)
        .values({
          id: grantRowId(grant),
          userId: grant.userId,
          transportId: grant.transportId,
          role: grant.role,
          isDefault: grant.isDefault,
        })
        .onConflictDoNothing({ target: mailboxAccess.id });
    }
  });
}
