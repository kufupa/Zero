#!/usr/bin/env npx tsx
/**
 * Recompute deterministic conversation links for one transport.
 *
 * Dry-run (default) — proposal + active-link counts only; no writes:
 *   pnpm --filter @zero/server exec tsx scripts/backfill-centurion-conversation-links.ts --transport=transport-centurion --confirm-pilot-rds
 *
 * Apply:
 *   pnpm --filter @zero/server exec tsx scripts/backfill-centurion-conversation-links.ts --transport=transport-centurion --apply --confirm-pilot-rds
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { mailConversationLink } from '../src/db/schema/mail-conversation-link.js';
import { message } from '../src/db/schema/mail.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import {
  discoverConversationLinks,
  recomputeConversationLinksForTransport,
  type LinkableMessage,
} from '../src/mail/conversation-link.js';

type CliArgs = {
  transportId: string | null;
  apply: boolean;
  confirmPilotRds: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  let transportId: string | null = null;
  let apply = false;
  let confirmPilotRds = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--confirm-pilot-rds') confirmPilotRds = true;
    else if (arg.startsWith('--transport=')) transportId = arg.slice('--transport='.length);
  }
  return { transportId, apply, confirmPilotRds };
}

function refusePilotUrl(url: string | undefined, { apply, confirmPilotRds }: CliArgs): void {
  if (!url) throw new Error('DATABASE_URL required');
  if (!url.includes('nava-zero-mail-pilot')) return;
  if (!confirmPilotRds) {
    throw new Error(
      apply
        ? 'REFUSE: pilot RDS apply needs --confirm-pilot-rds (operator-only; not for Vitest).'
        : 'REFUSE: pilot RDS dry-run also needs --confirm-pilot-rds so counts are intentional.',
    );
  }
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL required');
  return url;
}

async function loadLinkableMessages(
  db: ReturnType<typeof drizzle<typeof schema>>,
  transportId: string,
): Promise<LinkableMessage[]> {
  const rows = await db
    .select({
      id: message.id,
      threadId: message.threadId,
      transportId: message.transportId,
      direction: message.direction,
      messageIdHeader: message.messageIdHeader,
      inReplyTo: message.inReplyTo,
      references: message.references,
      fromAddress: message.fromAddress,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
      subject: message.subject,
      textBody: message.textBody,
      receivedAt: message.receivedAt,
    })
    .from(message)
    .where(eq(message.transportId, transportId));

  return rows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    transportId: row.transportId,
    direction: row.direction,
    messageIdHeader: row.messageIdHeader,
    inReplyTo: row.inReplyTo,
    references: row.references ?? [],
    fromAddress: row.fromAddress,
    toAddresses: row.toAddresses,
    ccAddresses: row.ccAddresses,
    subject: row.subject,
    textBody: row.textBody,
    receivedAt: row.receivedAt,
  }));
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli.transportId) {
    console.error(
      'Usage: backfill-centurion-conversation-links.ts --transport=<id> [--apply] [--confirm-pilot-rds]',
    );
    process.exit(2);
  }

  const databaseUrl = requireDatabaseUrl();
  refusePilotUrl(databaseUrl, cli);

  const conn = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });

  try {
    const linkable = await loadLinkableMessages(db, cli.transportId);
    const proposals = discoverConversationLinks(linkable);
    let activeLinksBefore = 0;
    try {
      const [activeRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(mailConversationLink)
        .where(
          and(
            eq(mailConversationLink.transportId, cli.transportId),
            isNull(mailConversationLink.supersededAt),
          ),
        );
      activeLinksBefore = activeRow?.count ?? 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/mail_conversation_link/i.test(message) && !/does not exist/i.test(message)) {
        throw error;
      }
      // Pre-migration dry-run: table absent — still report proposals.
      activeLinksBefore = -1;
    }

    const summary = {
      event: 'conversation_link_backfill.summary',
      transportId: cli.transportId,
      mode: cli.apply ? 'apply' : 'dry-run',
      messageCount: linkable.length,
      proposedLinks: proposals.length,
      activeLinksBefore,
      tableMissing: activeLinksBefore < 0,
    };
    console.log(JSON.stringify(summary));

    if (!cli.apply) {
      return;
    }

    if (activeLinksBefore < 0) {
      throw new Error('REFUSE apply: mail_conversation_link missing — run migrations 0020+0021 first');
    }

    const upserted = await recomputeConversationLinksForTransport(db, cli.transportId);
    const [activeAfter] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mailConversationLink)
      .where(
        and(
          eq(mailConversationLink.transportId, cli.transportId),
          isNull(mailConversationLink.supersededAt),
        ),
      );

    console.log(
      JSON.stringify({
        event: 'conversation_link_backfill.completed',
        transportId: cli.transportId,
        upserted,
        activeLinksAfter: activeAfter?.count ?? 0,
      }),
    );
  } finally {
    await conn.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'conversation_link_backfill.failed',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
