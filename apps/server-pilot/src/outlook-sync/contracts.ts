import { z } from 'zod';

const id = z.string().min(1).max(512);
const storeId = z.string().min(1).max(2048);
const instant = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    // PostgreSQL has no year zero and limits numeric timezone offsets to 15:59.
    const offset = /[+-](\d{2}):?(\d{2})$/.exec(value);
    return (
      Number(value.slice(0, 4)) > 0 &&
      Number.isFinite(Date.parse(value)) &&
      (!offset || (Number(offset[1]) <= 15 && Number(offset[2]) <= 59))
    );
  }, 'Invalid persisted timestamp');
export const safeBytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const version = z.literal(1);
export const availability = z.enum([
  'available',
  'missing',
  'protected',
  'unsupported',
  'unknown-date',
  'source-unavailable',
]);
export const artifactRole = z
  .string()
  .min(1)
  .max(256)
  .refine((value) =>
    /^(original-msg|original-mime|body-html|body-text|transport-headers|attachment:[A-Za-z0-9_.:-]+)$/.test(
      value,
    ),
  );
const identity = z
  .object({ address: z.string().max(1024), name: z.string().max(1024).nullable().default(null) })
  .strict();
export const syncObservationV1 = z
  .object({
    version,
    sourceObservationId: id,
    semanticVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    semanticReady: z.boolean().default(true),
    locator: z.object({ storeId, rootEntryId: id, folderEntryId: id, entryId: id }).strict(),
    availability,
    direction: z.enum(['inbound', 'outbound', 'unknown']),
    timestamps: z
      .object({
        receivedAt: instant.nullable(),
        sentAt: instant.nullable(),
        createdAt: instant.nullable(),
        modifiedAt: instant.nullable(),
        originalDate: z.string().max(1024).nullable().default(null),
      })
      .strict(),
    event: z
      .object({
        kind: z.enum(['inventory', 'new-mail', 'saved-sent', 'folder-hint']),
        observedAt: instant,
        receivedAt: instant.nullable().default(null),
        wasUnsent: z.boolean().default(false),
        isUnsent: z.boolean().default(false),
        sentCopySaved: z.boolean().default(false),
      })
      .strict(),
    semantic: z
      .object({
        internetMessageId: z.string().max(2048).nullable(),
        subject: z.string().max(8192),
        from: z.string().max(2048),
        to: z.array(z.string().max(2048)).max(1000),
        references: z.array(z.string().max(2048)).max(1000).default([]),
        inReplyTo: z.string().max(2048).nullable().default(null),
        sender: identity.nullable().default(null),
        sentRepresenting: identity.nullable().default(null),
        cc: z.array(identity).max(1000).default([]),
        bcc: z.array(identity).max(1000).default([]),
        replyTo: z.array(identity).max(1000).default([]),
        conversationId: z.string().max(2048).nullable().default(null),
        conversationIndex: z.string().max(8192).nullable().default(null),
        isRead: z.boolean().nullable().default(null),
        categories: z.array(z.string().max(256)).max(100).default([]),
        transportHeaders: z.string().max(262144).nullable().default(null),
      })
      .strict(),
    requiredArtifactRoles: z.array(artifactRole),
    contentIdentity: z
      .object({
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        attachments: z.array(
          z
            .object({
              role: artifactRole,
              stableId: id,
              modifiedAt: instant,
              sizeBytes: safeBytes,
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SyncObservationV1 = z.infer<typeof syncObservationV1>;
export const syncManifestV1 = z
  .object({
    version,
    observationId: id,
    semanticVersion: z.number().int().positive(),
    artifacts: z
      .array(
        z
          .object({
            role: artifactRole,
            version: z.number().int().positive(),
            sizeBytes: safeBytes,
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            contentType: z.string().min(1).max(256),
            fileName: z.string().max(1024).optional(),
            attachmentIndex: z.number().int().min(0).optional(),
            contentId: z.string().max(2048).nullable().optional(),
            inline: z.boolean().optional(),
            availability: availability.default('available'),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.artifacts.map((a) => `${a.role}:${a.version}`)).size !== value.artifacts.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate artifact role/version' });
  });
/** Manifests are bounded pages. Additional pages append artifact declarations; they never mean truncation/completion. */
export type SyncManifestV1 = z.infer<typeof syncManifestV1>;
export const syncReceiptV1 = z
  .object({
    version,
    sourceId: id,
    observationId: id,
    artifactId: id,
    role: artifactRole,
    sealedKey: id,
    sizeBytes: safeBytes,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    acceptedAt: instant,
    ingestionState: z.enum(['pending', 'committed', 'attention']),
  })
  .strict();
export type SyncReceiptV1 = z.infer<typeof syncReceiptV1>;
const countSummary = z
  .object({ discovered: safeBytes, retained: safeBytes, committed: safeBytes, gaps: safeBytes })
  .strict();
export const syncStatusV1 = z
  .object({
    version,
    sourceId: id,
    state: z.enum(['pending', 'running', 'paused', 'sign-in-required', 'attention']),
    capabilityRequirement: z.literal('mailboxSync:1'),
    historyFrom: instant.nullable(),
    historyTo: instant.nullable(),
    timezone: z.string().max(64),
    captureStartedAt: instant.nullable(),
    discoveredThrough: instant.nullable(),
    committedThrough: instant.nullable(),
    discovered: safeBytes,
    retained: safeBytes,
    committed: safeBytes,
    gaps: safeBytes,
    history: countSummary.extend({ discoveryComplete: z.boolean() }),
    live: countSummary,
    userPaused: z.boolean(),
    resourcePauseReason: z.string().max(64).nullable(),
  })
  .strict();
export type SyncStatusV1 = z.infer<typeof syncStatusV1>;
export const activeMailboxSyncStatus = z
  .union([syncStatusV1, z.object({ state: z.literal('not_applicable') }).strict()])
  .nullable();
export type ActiveMailboxSyncStatus = z.infer<typeof activeMailboxSyncStatus>;
export const activateInput = z
  .object({
    sourceId: id.optional(),
    deviceId: z.string().uuid(),
    storeId,
    rootEntryId: id,
    capabilityVersion: version,
    idempotencyKey: z.string().min(16).max(128),
  })
  .strict();
export const controlInput = z
  .object({
    sourceId: id,
    operation: z.enum(['start', 'pause', 'resume', 'syncNow', 'retryMissing']),
    idempotencyKey: z.string().min(16).max(128),
    window: z.object({ from: instant, to: instant }).strict().optional(),
  })
  .strict();
export const nativeBase = z
  .object({
    version,
    sourceId: id,
    sourceHandle: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    storeId,
    rootEntryId: id,
  })
  .strict();
export const nativeFenced = nativeBase.extend({
  claimFence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const nativeActivateInput = z
  .object({
    version,
    sourceId: id,
    activationTicket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    idempotencyKey: z.string().min(16).max(128),
    storeId,
    rootEntryId: id,
  })
  .strict();
export const nativeClaimInput = nativeBase.extend({ workerId: z.string().min(16).max(128) });
export const nativeLeaseInput = nativeFenced;
export const nativeHeartbeatInput = nativeBase.extend({
  claimFence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  resourcePauseReason: z
    .enum(['outlook-busy', 'offline', 'disk', 'quota', 'source-unavailable'])
    .nullable()
    .optional(),
  subscriptionStartedAt: instant.optional(),
});
export const nativeInventoryInput = nativeFenced.extend({
  scan: z
    .object({
      id: id.optional(),
      mode: z.enum(['history', 'catchup', 'reconcile']),
      from: instant,
      to: instant,
    })
    .strict(),
  partitionId: id,
  pageId: id,
  checkpoint: z
    .object({
      cursor: z.string().max(4096).nullable(),
      generation: z.string().max(128),
      complete: z.boolean(),
      gapCode: z.string().max(64).nullable(),
    })
    .strict(),
  observations: z.array(syncObservationV1).max(100),
  discoveryComplete: z.boolean().default(false),
});
export type NativeSyncScope = z.infer<typeof nativeFenced>;
export type SyncReadLeaseV1 = {
  version: 1;
  sourceId: string;
  storeId: string;
  rootEntryId: string;
  policyGeneration: number;
  claimFence: number;
  expiresAt: string;
};
