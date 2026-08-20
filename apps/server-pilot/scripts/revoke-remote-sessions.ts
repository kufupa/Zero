import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db/client.js';
import { remoteSession, user } from '../src/db/schema/auth.js';

function parseArgs(args: string[]): { email: string } {
  if (args.length !== 3 || args[0] !== '--email' || args[2] !== '--confirm-revoke') {
    throw new Error('usage: --email <exact-email> --confirm-revoke');
  }

  const email = args[1];
  if (!email || email !== email.trim() || !email.includes('@')) {
    throw new Error('email must be one exact address');
  }

  return { email };
}

async function main(): Promise<void> {
  const { email } = parseArgs(process.argv.slice(2));
  const db = getDb();

  try {
    const users = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(2);
    if (users.length !== 1) {
      throw new Error('matching account must be unique');
    }

    const deleted = await db
      .delete(remoteSession)
      .where(eq(remoteSession.userId, users[0].id))
      .returning({ id: remoteSession.id });

    console.log(`remote sessions revoked: ${deleted.length}`);
  } finally {
    await closeDb();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'remote session revocation failed');
  process.exitCode = 1;
});
