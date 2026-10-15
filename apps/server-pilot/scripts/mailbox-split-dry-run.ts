import { closeDb, getDb, type DB } from '../src/db/client.js';
import { mailIngestQuarantine, mailboxTransport } from '../src/db/schema/mail.js';
import {
  summarizeMailboxSplitDryRun,
  type MailboxAddressSignals,
  type MailboxRouteTransport,
  type MailboxSplitDryRunSummary,
} from '../src/mail/ingest/mailbox-split.js';
import { getS3Storage, type S3Storage } from '../src/storage/s3.js';
import { simpleParser, type AddressObject, type EmailAddress } from 'mailparser';
import { asc } from 'drizzle-orm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface MailboxSplitDryRunQuarantineRow {
  id: string;
  ingestMailboxId: string;
  pop3Uidl: string;
  rawMimeS3Key: string;
  reason: string;
}

export interface MailboxSplitDryRunReport {
  quarantineRows: number;
  missingOwnerHeaderRows: number;
  parseFailureRows: number;
  otherQuarantineRows: number;
  unreadableRows: number;
  headerParseFailures: number;
  summary: MailboxSplitDryRunSummary;
}

export async function buildMailboxSplitDryRunReport(args: {
  quarantineRows: readonly MailboxSplitDryRunQuarantineRow[];
  transports: readonly MailboxRouteTransport[];
  storage: Pick<S3Storage, 'getObject'>;
}): Promise<MailboxSplitDryRunReport> {
  const candidates: {
    raw: Buffer;
    messageId: string | null;
    signals: MailboxAddressSignals;
  }[] = [];
  let missingOwnerHeaderRows = 0;
  let parseFailureRows = 0;
  let otherQuarantineRows = 0;
  let unreadableRows = 0;
  let headerParseFailures = 0;

  for (const row of args.quarantineRows) {
    if (row.reason === 'missing_owner_header') missingOwnerHeaderRows += 1;
    else if (row.reason === 'parse_failure') parseFailureRows += 1;
    else {
      otherQuarantineRows += 1;
      continue;
    }

    let object: Awaited<ReturnType<S3Storage['getObject']>>;
    try {
      object = await args.storage.getObject(row.rawMimeS3Key);
    } catch {
      unreadableRows += 1;
      continue;
    }
    if (!object) {
      unreadableRows += 1;
      continue;
    }

    try {
      const parsed = await simpleParser(object.body, { skipHtmlToText: true });
      candidates.push({
        raw: object.body,
        messageId: parsed.messageId ?? null,
        signals: {
          fromAddress: parsed.from?.value[0]?.address ?? null,
          toAddresses: addressValues(parsed.to),
          ccAddresses: addressValues(parsed.cc),
          bccAddresses: addressValues(parsed.bcc),
        },
      });
    } catch {
      headerParseFailures += 1;
    }
  }

  return {
    quarantineRows: args.quarantineRows.length,
    missingOwnerHeaderRows,
    parseFailureRows,
    otherQuarantineRows,
    unreadableRows,
    headerParseFailures,
    summary: summarizeMailboxSplitDryRun(candidates, args.transports),
  };
}

export async function runMailboxSplitDryRun(db: Pick<DB, 'select'>, storage: S3Storage) {
  const [quarantineRows, transports] = await Promise.all([
    db
      .select({
        id: mailIngestQuarantine.id,
        ingestMailboxId: mailIngestQuarantine.ingestMailboxId,
        pop3Uidl: mailIngestQuarantine.pop3Uidl,
        rawMimeS3Key: mailIngestQuarantine.rawMimeS3Key,
        reason: mailIngestQuarantine.reason,
      })
      .from(mailIngestQuarantine)
      .orderBy(asc(mailIngestQuarantine.createdAt)),
    db
      .select({
        id: mailboxTransport.id,
        email: mailboxTransport.email,
        isActive: mailboxTransport.isActive,
        sendFromConfig: mailboxTransport.sendFromConfig,
      })
      .from(mailboxTransport)
      .orderBy(asc(mailboxTransport.id)),
  ]);

  return buildMailboxSplitDryRunReport({ quarantineRows, transports, storage });
}

export function formatMailboxSplitDryRunReport(report: MailboxSplitDryRunReport): string[] {
  const { summary } = report;
  return [
    'mailbox split dry-run (read-only; counts only)',
    `quarantine_rows=${report.quarantineRows} missing_owner_header=${report.missingOwnerHeaderRows} parse_failure=${report.parseFailureRows} other=${report.otherQuarantineRows}`,
    `parsed_candidates=${summary.scanned} unreadable=${report.unreadableRows} header_parse_failures=${report.headerParseFailures}`,
    `unique_messages=${summary.uniqueMessages} duplicate_copies=${summary.duplicateCopies} cross_mailbox_duplicate_keys=${summary.crossMailboxDuplicateKeys} ambiguous_rows=${summary.ambiguousRows} unmatched_rows=${summary.unmatchedRows}`,
    ...summary.mailboxes.map(
      (mailbox) =>
        `transport_id=${mailbox.transportId} active=${mailbox.active} inbound_candidates=${mailbox.inboundCandidates} outbound_candidates=${mailbox.outboundCandidates} ambiguous_candidates=${mailbox.ambiguousCandidates} would_promote=${mailbox.wouldPromote} would_promote_if_activated=${mailbox.wouldPromoteIfActivated} unique_messages=${mailbox.uniqueCanonicalMessages} duplicate_copies=${mailbox.duplicateCopies}`,
    ),
  ];
}

async function main(): Promise<void> {
  try {
    const report = await runMailboxSplitDryRun(getDb(), getS3Storage());
    for (const line of formatMailboxSplitDryRunReport(report)) console.log(line);
  } finally {
    await closeDb();
  }
}

function addressValues(value: AddressObject | AddressObject[] | undefined): string[] {
  const objects = value ? (Array.isArray(value) ? value : [value]) : [];
  return objects.flatMap((object) => object.value.flatMap(flattenEmailAddress));
}

function flattenEmailAddress(value: EmailAddress): string[] {
  if (value.address) return [value.address];
  return value.group?.flatMap(flattenEmailAddress) ?? [];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('mailbox split dry-run failed; no row or message data was printed');
    process.exitCode = 1;
  });
}
