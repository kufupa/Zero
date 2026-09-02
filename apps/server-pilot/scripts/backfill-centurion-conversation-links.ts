#!/usr/bin/env npx tsx
/**
 * Recompute deterministic conversation links for one transport.
 *
 * Dry-run (default) — proposal + active-link counts only; no writes:
 *   pnpm --filter @zero/server exec tsx scripts/backfill-centurion-conversation-links.ts --transport=transport-centurion --deactivate-unsafe --confirm-pilot-rds
 *
 * Apply:
 *   pnpm --filter @zero/server exec tsx scripts/backfill-centurion-conversation-links.ts --transport=transport-centurion --deactivate-unsafe --apply --confirm-pilot-rds
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { mailConversationLink } from '../src/db/schema/mail-conversation-link.js';
import { message } from '../src/db/schema/mail.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import {
  deactivateSupersededConversationLinks,
  discoverConversationLinks,
  findSupersededConversationLinks,
  recomputeConversationLinksForTransport,
  type PersistedConversationLink,
  type LinkableMessage,
} from '../src/mail/conversation-link.js';

type CliArgs = {
  transportId: string | null;
  apply: boolean;
  confirmPilotRds: boolean;
  deactivateUnsafe: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  let transportId: string | null = null;
  let apply = false;
  let confirmPilotRds = false;
  let deactivateUnsafe = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--confirm-pilot-rds') confirmPilotRds = true;
    else if (arg === '--deactivate-unsafe') deactivateUnsafe = true;
    else if (arg.startsWith('--transport=')) transportId = arg.slice('--transport='.length);
  }
  return { transportId, apply, confirmPilotRds, deactivateUnsafe };
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

async function loadActiveLinks(
  db: ReturnType<typeof drizzle<typeof schema>>,
  transportId: string,
): Promise<PersistedConversationLink[]> {
  return db
    .select({
      id: mailConversationLink.id,
      srcThreadId: mailConversationLink.srcThreadId,
      dstThreadId: mailConversationLink.dstThreadId,
      linkType: mailConversationLink.linkType,
      supersededAt: mailConversationLink.supersededAt,
    })
    .from(mailConversationLink)
    .where(
      and(eq(mailConversationLink.transportId, transportId), isNull(mailConversationLink.supersededAt)),
    );
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli.transportId) {
    console.error(
      'Usage: backfill-centurion-conversation-links.ts --transport=<id> [--deactivate-unsafe] [--apply] [--confirm-pilot-rds]',
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
    let activeLinks: PersistedConversationLink[] = [];
    let tableWasMissing = false;
    try {
      activeLinks = await loadActiveLinks(db, cli.transportId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/mail_conversation_link/i.test(message) && !/does not exist/i.test(message)) {
        throw error;
      }
      // Pre-migration dry-run: table absent — still report proposals.
      tableWasMissing = true;
    }
    // Keep table-missing state separate from zero active rows; the query above
    // remains count-free to avoid exposing row-level data in operator output.
    const activeLinksBefore = tableWasMissing ? -1 : activeLinks.length;
    const supersededCandidates = cli.deactivateUnsafe && !tableWasMissing
      ? findSupersededConversationLinks(activeLinks, proposals).length
      : 0;

    const summary = {
      event: 'conversation_link_backfill.summary',
      transportId: cli.transportId,
      mode: cli.apply ? 'apply' : 'dry-run',
      deactivateUnsafe: cli.deactivateUnsafe,
      messageCount: linkable.length,
      proposedLinks: proposals.length,
      activeLinksBefore,
      supersededCandidates,
      tableMissing: tableWasMissing,
    };
    console.log(JSON.stringify(summary));

    if (!cli.apply) {
      return;
    }

    if (tableWasMissing) {
      throw new Error('REFUSE apply: mail_conversation_link missing — run migrations 0020+0021 first');
    }

    const superseded = cli.deactivateUnsafe
      ? await deactivateSupersededConversationLinks(db, cli.transportId, proposals)
      : 0;
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
        deactivateUnsafe: cli.deactivateUnsafe,
        superseded,
        upserted,
        activeLinksAfter: activeAfter?.count ?? 0,
      }),
    );
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'conversation_link_backfill.failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  });
}
