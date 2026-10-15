/** Dry-run counts for missing_owner_header quarantine under live ingest routing. No writes. */
import { mailIngestQuarantine, message } from '../../db/schema/mail.js';
import type { DB } from '../../db/client.js';
import type { S3Storage } from '../../storage/s3.js';
import {
  findDirectToTransport,
  findEquatedHotelTransport,
  findTransportByStamp,
  isStampCorroborated,
  resolveTransportMatch,
  type TransportMatchCandidate,
} from './store.js';
import type { ParsedInboundMessage } from './parse-message.js';
import { ingestRequireOwnerHeader } from '../../env.js';
import { simpleParser, type AddressObject, type EmailAddress } from 'mailparser';
import { and, asc, eq } from 'drizzle-orm';

const HOME: Record<string, string> = { 'ingest-nava-legacy': 'transport-centurion' };
const GROUP: Record<string, string> = {
  'transport-centurion': 'centurion',
  'transport-davinci': 'davinci',
  'transport-epick': 'davinci',
  'transport-kmgidi': 'davinci',
  'transport-faith': 'faith',
  'transport-ayanda': 'ayanda',
};

export class RoutedPromoteDryRunRequiredError extends Error {
  constructor() {
    super('promote-quarantine-routed requires --dry-run');
    this.name = 'RoutedPromoteDryRunRequiredError';
  }
}

export type RoutedPromoteCliArgs = { dryRun: true; limit?: number; transportId?: string };
export type RoutedPromoteDryRunResult = {
  scanned: number;
  byTransport: Record<string, number>;
  unknown: number;
  ambiguous: number;
  multi_transport: number;
  error: number;
  dup_stored: number;
  cross_hotel_violations: number;
  ingestMailboxes: string[];
  crossHotelViolationIds: string[];
  requireOwnerHeader: boolean;
};

export function parseRoutedPromoteCliArgs(argv: string[]): RoutedPromoteCliArgs {
  let dryRun = false;
  let limit: number | undefined;
  let transportId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const next = (flag: string, raw: string | undefined) => {
      if (!raw || raw.startsWith('--')) throw new Error(`${flag} requires a value`);
      return raw;
    };
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const value = Number(next('--limit', arg === '--limit' ? argv[++i] : arg.slice(8)));
      if (!Number.isInteger(value) || value < 1) throw new Error('--limit requires a positive integer');
      limit = value;
      continue;
    }
    if (arg === '--transport' || arg.startsWith('--transport=')) {
      transportId = next('--transport', arg === '--transport' ? argv[++i] : arg.slice(12));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!dryRun) throw new RoutedPromoteDryRunRequiredError();
  return { dryRun: true, limit, transportId };
}

export async function dryRunRoutedPromote(opts: {
  db: DB;
  storage: S3Storage;
  limit?: number;
  transportId?: string;
  requireOwnerHeader?: boolean;
}): Promise<RoutedPromoteDryRunResult> {
  const listed = opts.db
    .select({
      id: mailIngestQuarantine.id,
      ingestMailboxId: mailIngestQuarantine.ingestMailboxId,
      pop3Uidl: mailIngestQuarantine.pop3Uidl,
      rawMimeS3Key: mailIngestQuarantine.rawMimeS3Key,
    })
    .from(mailIngestQuarantine)
    .where(eq(mailIngestQuarantine.reason, 'missing_owner_header'))
    .orderBy(asc(mailIngestQuarantine.createdAt));
  const rows = await (opts.limit !== undefined ? listed.limit(opts.limit) : listed);
  const requireOwnerHeader = opts.requireOwnerHeader ?? ingestRequireOwnerHeader();
  const result: RoutedPromoteDryRunResult = {
    scanned: rows.length,
    byTransport: {},
    unknown: 0,
    ambiguous: 0,
    multi_transport: 0,
    error: 0,
    dup_stored: 0,
    cross_hotel_violations: 0,
    ingestMailboxes: [...new Set(rows.map((row) => row.ingestMailboxId))].sort(),
    crossHotelViolationIds: [],
    requireOwnerHeader,
  };
  for (const row of rows) {
    const existing = await opts.db
      .select({ id: message.id, transportId: message.transportId })
      .from(message)
      .where(and(eq(message.ingestMailboxId, row.ingestMailboxId), eq(message.pop3Uidl, row.pop3Uidl)))
      .limit(1);
    if (existing[0]) result.dup_stored += 1;
    let parsed: ParsedInboundMessage;
    try {
      const object = await opts.storage.getObject(row.rawMimeS3Key);
      if (!object) {
        result.error += 1;
        continue;
      }
      parsed = await parseHeadersOnly(object.body);
    } catch {
      result.error += 1;
      continue;
    }
    const route = await routeLikeLiveIngest(opts.db, parsed, requireOwnerHeader);
    if (route.kind !== 'unique') {
      result[route.kind === 'ambiguous' || route.kind === 'multi_transport' ? route.kind : 'unknown'] += 1;
      continue;
    }
    if (!opts.transportId || opts.transportId === route.transport.id) {
      result.byTransport[route.transport.id] = (result.byTransport[route.transport.id] ?? 0) + 1;
    }
    const home = HOME[row.ingestMailboxId];
    const named =
      resolveTransportMatch(
        [route.transport],
        [...parsed.toAddresses, ...parsed.ccAddresses, ...parsed.bccAddresses],
      ).kind === 'unique';
    if (home && (GROUP[home] ?? home) !== (GROUP[route.transport.id] ?? route.transport.id) && !named) {
      result.cross_hotel_violations += 1;
      result.crossHotelViolationIds.push(row.id);
    }
  }
  return result;
}

/** Same dispatch as persistInboundMessage — store.ts helpers, no forked matcher. */
async function routeLikeLiveIngest(db: DB, parsed: ParsedInboundMessage, requireOwnerHeader: boolean) {
  const closed = (
    match: { kind: 'ambiguous' | 'multi' } | { kind: 'unique'; transport: TransportMatchCandidate } | { kind: 'none' },
  ) =>
    match.kind === 'unique'
      ? ({ kind: 'unique', transport: match.transport } as const)
      : match.kind === 'none'
        ? ({ kind: 'unknown' } as const)
        : ({ kind: match.kind === 'multi' ? 'multi_transport' : 'ambiguous' } as const);
  const direct = await findDirectToTransport(db, parsed.toAddresses);
  if (direct.kind === 'ambiguous' || direct.kind === 'multi') return closed(direct);
  if (parsed.ownerHeaderValue) {
    const stamped = await findTransportByStamp(db, parsed.ownerHeaderValue);
    if (stamped.kind !== 'unique') return closed(stamped);
    if (isStampCorroborated(stamped.transport, parsed)) return closed(stamped);
  }
  if (direct.kind === 'unique') return closed(direct);
  if (requireOwnerHeader) return { kind: 'unknown' } as const;
  return closed(await findEquatedHotelTransport(db, parsed));
}

async function parseHeadersOnly(raw: Buffer): Promise<ParsedInboundMessage> {
  const text = raw.toString('latin1');
  const split = text.search(/\r\n\r\n|\n\n/);
  const parsed = await simpleParser(split === -1 ? raw : Buffer.from(text.slice(0, split), 'latin1'), {
    skipHtmlToText: true,
  });
  const owner = parsed.headers?.get('x-zero-mailbox');
  const ownerRaw =
    typeof owner === 'string' ? owner : owner && typeof owner === 'object' && 'value' in owner ? String(owner.value) : '';
  const fromAddress = parsed.from?.value[0]?.address ?? null;
  const addrs = (value: AddressObject | AddressObject[] | undefined) => {
    const objects = value ? (Array.isArray(value) ? value : [value]) : [];
    const flatten = (item: EmailAddress): string[] =>
      item.address ? [item.address] : (item.group?.flatMap(flatten) ?? []);
    return objects.flatMap((object) => object.value.flatMap(flatten));
  };
  return {
    ownerHeaderValue: ownerRaw.trim() ? ownerRaw.trim().toLowerCase() : null,
    outboundCorrelation: { kind: 'absent' },
    messageId: null,
    inReplyTo: null,
    references: [],
    fromAddress,
    fromHeaderAddress: fromAddress,
    toAddresses: addrs(parsed.to),
    ccAddresses: addrs(parsed.cc),
    bccAddresses: addrs(parsed.bcc),
    subject: null,
    textBody: null,
    htmlBody: null,
    receivedAt: null,
    deliveredAt: null,
    attachments: [],
    rawHeaderLines: [],
  };
}
