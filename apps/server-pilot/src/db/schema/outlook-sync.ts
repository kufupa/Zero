import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { outlookDevice } from './outlook-device.js';
import { mailboxTransport } from './mail.js';
import { sql } from 'drizzle-orm';
import { user } from './auth.js';

export const outlookSyncSource = pgTable(
  'outlook_sync_source',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => outlookDevice.deviceId),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    storeId: text('store_id').notNull(),
    rootEntryId: text('root_entry_id').notNull(),
    sessionId: text('session_id').notNull(),
    policyGeneration: integer('policy_generation').notNull(),
    timezone: text('timezone').notNull().default('Africa/Johannesburg'),
    historyFrom: timestamp('history_from'),
    historyTo: timestamp('history_to'),
    captureStartedAt: timestamp('capture_started_at'),
    subscriptionStartedAt: timestamp('subscription_started_at'),
    handleHash: text('handle_hash'),
    handleCiphertext: text('handle_ciphertext'),
    authorityExpiresAt: timestamp('authority_expires_at').notNull(),
    activationKey: text('activation_key').notNull(),
    activationTicketHash: text('activation_ticket_hash').notNull(),
    activationTicketCiphertext: text('activation_ticket_ciphertext').notNull(),
    activationExpiresAt: timestamp('activation_expires_at').notNull(),
    redeemedAt: timestamp('redeemed_at'),
    claimFence: bigint('claim_fence', { mode: 'number' }).notNull().default(0),
    claimOwner: text('claim_owner'),
    claimExpiresAt: timestamp('claim_expires_at'),
    discoveredThrough: timestamp('discovered_through'),
    committedThrough: timestamp('committed_through'),
    discoveredCount: bigint('discovered_count', { mode: 'number' }).notNull().default(0),
    retainedCount: bigint('retained_count', { mode: 'number' }).notNull().default(0),
    committedCount: bigint('committed_count', { mode: 'number' }).notNull().default(0),
    gapCount: bigint('gap_count', { mode: 'number' }).notNull().default(0),
    historySummary: jsonb('history_summary')
      .$type<{
        discoveryComplete: boolean;
        discovered: number;
        retained: number;
        committed: number;
        gaps: number;
      }>()
      .notNull()
      .default({ discoveryComplete: false, discovered: 0, retained: 0, committed: 0, gaps: 0 }),
    liveSummary: jsonb('live_summary')
      .$type<{ discovered: number; retained: number; committed: number; gaps: number }>()
      .notNull()
      .default({ discovered: 0, retained: 0, committed: 0, gaps: 0 }),
    userPaused: boolean('user_paused').notNull().default(false),
    resourcePauseReason: text('resource_pause_reason'),
    pendingBytes: bigint('pending_bytes', { mode: 'number' }).notNull().default(0),
    pendingArtifactCount: integer('pending_artifact_count').notNull().default(0),
    pendingByteLimit: bigint('pending_byte_limit', { mode: 'number' })
      .notNull()
      .default(1073741824),
    status: text('status').notNull().default('pending'),
    controlKey: text('control_key'),
    controlHash: text('control_hash'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outlook_sync_source_identity_uq').on(
      t.deviceId,
      t.transportId,
      t.storeId,
      t.rootEntryId,
    ),
    index('outlook_sync_source_session_idx').on(t.sessionId),
    check(
      'outlook_sync_source_quota_ck',
      sql`${t.pendingBytes} >= 0 AND ${t.pendingBytes} <= 9007199254740991 AND ${t.pendingArtifactCount} >= 0 AND ${t.pendingByteLimit} >= 1073741824 AND ${t.pendingByteLimit} <= 167772160000`,
    ),
    check(
      'outlook_sync_source_bounds_ck',
      sql`${t.historyFrom} IS NULL OR ${t.historyFrom} < ${t.historyTo}`,
    ),
  ],
);

/** header -> partition -> bounded page -> per-observation membership; no unbounded mailbox JSON. */
export const outlookSyncScan = pgTable(
  'outlook_sync_scan',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => outlookSyncSource.id),
    recordKind: text('record_kind').notNull().default('scan'),
    parentId: text('parent_id'),
    recordKey: text('record_key').notNull(),
    mode: text('mode').notNull(),
    from: timestamp('from_at').notNull(),
    to: timestamp('to_at').notNull(),
    claimFence: bigint('claim_fence', { mode: 'number' }).notNull(),
    checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>(),
    observationId: text('observation_id'),
    discoveredCount: bigint('discovered_count', { mode: 'number' }).notNull().default(0),
    committedCount: bigint('committed_count', { mode: 'number' }).notNull().default(0),
    gapCount: bigint('gap_count', { mode: 'number' }).notNull().default(0),
    discoveryComplete: boolean('discovery_complete').notNull().default(false),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outlook_sync_scan_record_uq').on(t.sourceId, t.recordKey),
    index('outlook_sync_scan_parent_idx').on(t.parentId),
    index('outlook_sync_scan_observation_idx').on(t.observationId),
    check('outlook_sync_scan_interval_ck', sql`${t.from} <= ${t.to}`),
    check(
      'outlook_sync_scan_kind_ck',
      sql`${t.recordKind} IN ('scan','partition','page','membership','control')`,
    ),
    uniqueIndex('outlook_sync_scan_one_active_uq')
      .on(t.sourceId)
      .where(
        sql`${t.recordKind} = 'scan' AND (${t.status} = 'pending' OR ${t.status} = 'discovering')`,
      ),
  ],
);

export const outlookSyncObservation = pgTable(
  'outlook_sync_observation',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => outlookSyncSource.id),
    sourceObservationId: text('source_observation_id').notNull(),
    semanticVersion: bigint('semantic_version', { mode: 'number' }).notNull(),
    summaryCache: jsonb('summary_cache').$type<{
      eligible?: boolean;
      history: boolean;
      retained: boolean;
      committed: boolean;
      gap: boolean;
    }>(),
    summaryDirty: boolean('summary_dirty').notNull().default(true),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    availability: text('availability').notNull(),
    direction: text('direction').notNull(),
    canonicalMessageId: text('canonical_message_id'),
    artifactOrigin: jsonb('artifact_origin').$type<{ sourceId: string; observationId: string }>(),
    requiredArtifactRoles: jsonb('required_artifact_roles').$type<string[]>().notNull(),
    exportState: text('export_state').notNull().default('pending'),
    ingestionState: text('ingestion_state').notNull().default('pending'),
    drainOwner: text('drain_owner'),
    drainFence: bigint('drain_fence', { mode: 'number' }).notNull().default(0),
    drainExpiresAt: timestamp('drain_expires_at'),
    drainNextAttemptAt: timestamp('drain_next_attempt_at'),
    retryCount: integer('retry_count').notNull().default(0),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outlook_sync_observation_identity_uq').on(
      t.sourceId,
      t.sourceObservationId,
      t.semanticVersion,
    ),
    index('outlook_sync_observation_pending_idx').on(t.ingestionState),
    index('outlook_sync_observation_dirty_idx')
      .on(t.sourceId)
      .where(sql`${t.summaryDirty}=true`),
    index('outlook_sync_observation_drain_idx').on(
      t.ingestionState,
      t.drainNextAttemptAt,
      t.drainExpiresAt,
    ),
  ],
);

export const outlookSyncArtifact = pgTable(
  'outlook_sync_artifact',
  {
    id: text('id').primaryKey(),
    observationId: text('observation_id')
      .notNull()
      .references(() => outlookSyncObservation.id),
    role: text('role').notNull(),
    version: integer('version').notNull(),
    expectedBytes: bigint('expected_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    contentType: text('content_type').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    uploadSession: jsonb('upload_session').$type<Record<string, unknown>>(),
    stagingKey: text('staging_key'),
    sealedKey: text('sealed_key'),
    verifiedReceipt: jsonb('verified_receipt').$type<Record<string, unknown>>(),
    acceptedAt: timestamp('accepted_at'),
    quotaReserved: boolean('quota_reserved').notNull().default(true),
    reservationExpiresAt: timestamp('reservation_expires_at')
      .notNull()
      .default(sql`now()+interval '7 days'`),
    ingestionState: text('ingestion_state').notNull().default('pending'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outlook_sync_artifact_identity_uq').on(t.observationId, t.role, t.version),
    uniqueIndex('outlook_sync_artifact_sealed_uq').on(t.sealedKey),
    index('outlook_sync_artifact_reservation_idx')
      .on(t.reservationExpiresAt)
      .where(sql`${t.quotaReserved}=true AND ${t.acceptedAt} IS NULL`),
    check(
      'outlook_sync_artifact_bytes_ck',
      sql`${t.expectedBytes} >= 0 AND ${t.expectedBytes} <= 9007199254740991`,
    ),
  ],
);
