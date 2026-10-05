import {
  issueEnrollment,
  revokeDevice,
  wrappingKey,
  approveReadRoot,
  revokeReadRoot,
  getApprovedReadRoots,
} from '../src/outlook-security/device.js';
import { provisionApprovedFolder } from '../src/outlook-security/authorization.js';
import { outlookApprovedFolder } from '../src/db/schema/outlook-authorization.js';
import { setSourcePendingByteLimit } from '../src/outlook-sync/quota.js';
import { mailboxTransport } from '../src/db/schema/mail.js';
import { closeDb, getDb } from '../src/db/client.js';
import { user } from '../src/db/schema/auth.js';
import { and, eq } from 'drizzle-orm';

// Run from a restricted server shell; never expose operator actions via HTTP.
async function main(args: string[]) {
  wrappingKey(process.env.NAVA_OUTLOOK_DEVICE_WRAPPING_KEY);
  const db = getDb();
  if (
    args[0] === 'set-sync-quota' &&
    args.length === 15 &&
    args[1] === '--source-id' &&
    args[3] === '--device-id' &&
    args[5] === '--staff-email' &&
    args[7] === '--transport-email' &&
    args[9] === '--store-id' &&
    args[11] === '--root-entry-id' &&
    args[13] === '--limit-bytes'
  ) {
    const staff = await db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.email, args[6]), eq(user.emailVerified, true)))
      .limit(2);
    const transport = await db
      .select({ id: mailboxTransport.id })
      .from(mailboxTransport)
      .where(and(eq(mailboxTransport.email, args[8]), eq(mailboxTransport.isActive, true)))
      .limit(2);
    if (staff.length !== 1 || transport.length !== 1)
      throw new Error('Exact named staff and transport required');
    const result = await setSourcePendingByteLimit(db, {
      sourceId: args[2],
      deviceId: args[4],
      userId: staff[0].id,
      transportId: transport[0].id,
      storeId: args[10],
      rootEntryId: args[12],
      limitBytes: Number(args[14]),
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (
    args[0] === 'issue' &&
    args.length >= 7 &&
    (args.length - 3) % 4 === 0 &&
    args[1] === '--store-id'
  ) {
    const storeId = args[2];
    const grants: { userId: string; transportId: string }[] = [];
    for (let offset = 3; offset < args.length; offset += 4) {
      if (args[offset] !== '--staff-email' || args[offset + 2] !== '--transport-email')
        throw new Error('Invalid operator grant arguments');
      const staff = await db
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.email, args[offset + 1]), eq(user.emailVerified, true)))
        .limit(2);
      const transport = await db
        .select({ id: mailboxTransport.id })
        .from(mailboxTransport)
        .where(eq(mailboxTransport.email, args[offset + 3]))
        .limit(2);
      if (staff.length !== 1 || transport.length !== 1)
        throw new Error('Verified named staff or mailbox transport not found');
      grants.push({ userId: staff[0].id, transportId: transport[0].id });
    }
    const code = await issueEnrollment(db, { ...grants[0], grants, storeId });
    // Enrollment code is displayed ONLY to the local operator, never persisted in plaintext or returned over an open endpoint.
    process.stdout.write(`one-use enrollment code (valid 10 minutes): ${code}\n`);
  } else if (
    args[0] === 'approve-folder' &&
    args.length === 9 &&
    args[1] === '--store-id' &&
    args[3] === '--transport-email' &&
    args[5] === '--folder-id' &&
    args[7] === '--kind'
  ) {
    const kind = args[8];
    if (kind !== 'triage' && kind !== 'inbox' && kind !== 'spam' && kind !== 'drafts')
      throw new Error('Invalid folder kind');
    const [transport] = await db
      .select({ id: mailboxTransport.id })
      .from(mailboxTransport)
      .where(and(eq(mailboxTransport.email, args[4]), eq(mailboxTransport.isActive, true)))
      .limit(1);
    if (!transport) throw new Error('Active transport not found');
    await provisionApprovedFolder(db, {
      storeId: args[2],
      transportId: transport.id,
      folderId: args[6],
      kind,
    });
    process.stdout.write('folder approved\n');
  } else if (
    args[0] === 'revoke-folder' &&
    args.length === 8 &&
    args[1] === '--store-id' &&
    args[3] === '--transport-email' &&
    args[5] === '--folder-id' &&
    args[7] === '--confirm-revoke'
  ) {
    const [transport] = await db
      .select({ id: mailboxTransport.id })
      .from(mailboxTransport)
      .where(eq(mailboxTransport.email, args[4]))
      .limit(1);
    if (!transport) throw new Error('Transport not found');
    const removed = await db
      .delete(outlookApprovedFolder)
      .where(
        and(
          eq(outlookApprovedFolder.storeId, args[2]),
          eq(outlookApprovedFolder.transportId, transport.id),
          eq(outlookApprovedFolder.folderId, args[6]),
        ),
      )
      .returning({ folderId: outlookApprovedFolder.folderId });
    process.stdout.write(removed.length ? 'folder approval revoked\n' : 'folder not approved\n');
  } else if (
    ['approve-read-root', 'revoke-read-root', 'inventory-read-roots'].includes(args[0]) &&
    args[1] === '--device-id' &&
    args[3] === '--staff-email' &&
    args[5] === '--transport-email' &&
    args[7] === '--store-id' &&
    (args[0] === 'inventory-read-roots'
      ? args.length === 9
      : args.length === 13 &&
        args[9] === '--root-entry-id' &&
        args[11] === (args[0] === 'approve-read-root' ? '--policy-version' : '--confirm-revoke'))
  ) {
    const staff = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, args[4]))
      .limit(2);
    const transport = await db
      .select({ id: mailboxTransport.id })
      .from(mailboxTransport)
      .where(eq(mailboxTransport.email, args[6]))
      .limit(2);
    if (staff.length !== 1 || transport.length !== 1)
      throw new Error('Exact named staff and transport required');
    const input = {
      deviceId: args[2],
      userId: staff[0].id,
      transportId: transport[0].id,
      storeId: args[8],
      rootEntryId: args[10],
      policyVersion: 1 as const,
    };
    if (args[0] === 'approve-read-root') {
      if (args[12] !== '1') throw new Error('Unknown read policy version');
      await approveReadRoot(db, input);
      process.stdout.write('read root approved; mutation grants unchanged\n');
    } else if (args[0] === 'revoke-read-root') {
      if (args[12] !== '1') throw new Error('Revocation confirmation must be 1');
      const revoked = await revokeReadRoot(db, input);
      process.stdout.write(revoked ? 'read root revoked\n' : 'read root not active\n');
    } else {
      process.stdout.write(
        JSON.stringify(
          await getApprovedReadRoots(
            db,
            input.deviceId,
            input.userId,
            input.transportId,
            input.storeId,
          ),
          null,
          2,
        ) + '\n',
      );
    }
  } else if (
    args[0] === 'revoke' &&
    args.length === 4 &&
    args[1] === '--device-id' &&
    args[3] === '--confirm-revoke'
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args[2]))
      throw new Error('Invalid device ID');
    const revoked = await revokeDevice(db, args[2]);
    process.stdout.write(revoked ? 'device revoked\n' : 'device not active\n');
  } else {
    throw new Error(
      'usage: set-sync-quota --source-id <id> --device-id <id> --staff-email <staff> --transport-email <mailbox> --store-id <exact store> --root-entry-id <exact root> --limit-bytes <safe integer >=1073741824> | approve-read-root|revoke-read-root|inventory-read-roots --device-id <id> --staff-email <staff> --transport-email <mailbox> --store-id <exact store> [--root-entry-id <exact root> --policy-version 1|--confirm-revoke 1] | issue --store-id <StoreID> [--staff-email <account> --transport-email <mailbox>]+ | approve-folder --store-id <StoreID> --transport-email <mailbox> --folder-id <exact Folder EntryID> --kind inbox|triage|spam|drafts | revoke-folder --store-id <StoreID> --transport-email <mailbox> --folder-id <Folder EntryID> --confirm-revoke | revoke --device-id <uuid> --confirm-revoke',
    );
  }
}

void main(process.argv.slice(2))
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Outlook operator action failed'}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDb());
