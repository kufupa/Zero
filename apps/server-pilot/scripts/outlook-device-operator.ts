import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db/client.js';
import { user } from '../src/db/schema/auth.js';
import { mailboxTransport } from '../src/db/schema/mail.js';
import { issueEnrollment, revokeDevice, wrappingKey } from '../src/outlook-security/device.js';

// Run from a restricted server shell; never expose operator actions via HTTP.
async function main(args: string[]) {
  wrappingKey(process.env.NAVA_OUTLOOK_DEVICE_WRAPPING_KEY);
  const db = getDb();
  if (args[0] === 'issue' && args.length >= 7 && (args.length - 3) % 4 === 0 && args[1] === '--store-id') {
    const storeId = args[2];
    const grants: { userId: string; transportId: string }[] = [];
    for (let offset = 3; offset < args.length; offset += 4) {
      if (args[offset] !== '--staff-email' || args[offset + 2] !== '--transport-email') throw new Error('Invalid operator grant arguments');
      const staff = await db.select({ id: user.id }).from(user).where(eq(user.email, args[offset + 1])).limit(2);
      const transport = await db.select({ id: mailboxTransport.id }).from(mailboxTransport).where(eq(mailboxTransport.email, args[offset + 3])).limit(2);
      if (staff.length !== 1 || transport.length !== 1) throw new Error('Named staff or mailbox transport not found');
      grants.push({ userId: staff[0].id, transportId: transport[0].id });
    }
    const code = await issueEnrollment(db, { ...grants[0], grants, storeId });
    // Enrollment code is displayed ONLY to the local operator, never persisted in plaintext or returned over an open endpoint.
    process.stdout.write(`one-use enrollment code (valid 10 minutes): ${code}\n`);
  } else if (args[0] === 'revoke' && args.length === 4 && args[1] === '--device-id' && args[3] === '--confirm-revoke') {
    if (!/^[0-9a-fA-F-]{36}$/.test(args[2])) throw new Error('Invalid device ID');
    const revoked = await revokeDevice(db, args[2]);
    process.stdout.write(revoked ? 'device revoked\n' : 'device not active\n');
  } else {
    throw new Error('usage: issue --store-id <exact native Outlook StoreID> [--staff-email <named account> --transport-email <approved mailbox>]+ | revoke --device-id <uuid> --confirm-revoke');
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Outlook operator action failed'}\n`);
  process.exitCode = 1;
}).finally(() => closeDb());
