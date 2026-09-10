import {
  isDraftRouteReleaseDescriptor,
  resolveCurrentDraftRouteAuthority,
  type DraftRouteReleaseDescriptor,
} from './draft-route-factory.js';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  mailDraft,
  mailDraftRevision,
} from '../db/schema/mail.js';
import { EvidenceRefSchema, isEvidenceFresh } from './draft-evidence.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, or } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { z } from 'zod';

/** Versioned, closed token carried from explicit human review to send. */
export const DRAFT_APPROVAL_VERSION = 'u6-draft-approval-v1';
export const DRAFT_APPROVAL_POLICY_VERSION = 'u6-draft-policy-v1';
export const DRAFT_APPROVAL_PURPOSE = 'draft-only';

export class DraftApprovalError extends Error {
  readonly code = 'DRAFT_APPROVAL_INVALID' as const;

  constructor(message = 'draft approval is invalid') {
    super(message);
    this.name = 'DraftApprovalError';
  }
}

export type DraftApprovalAttachment = {
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  contentBase64?: string;
};

/** Trusted normal-worker capability/release identity bound into approval. */
export type DraftApprovalRouteBinding = {
  routeId: string;
  modelId: string;
  purpose: 'draft';
  protocol: 'in_process';
  access: 'current_app';
  egress: 'none';
  retention: 'bounded';
  usage: 'reported';
  release?: DraftRouteReleaseDescriptor;
};

export type DraftApprovalPayload = {
  draftId?: string;
  generationId?: string | null;
  transportId?: string;
  threadId?: string | null;
  revisionId?: string | null;
  threadStateVersion?: string | null;
  evidence?: unknown[];
  routeBinding?: DraftApprovalRouteBinding;
  policyVersion?: string;
  approvedByUserId?: string;
  approvedAt?: string;
  origin?: 'manual' | 'ai';
  subject: string;
  html: string;
  text: string;
  to: string[];
  cc: string[];
  bcc: string[];
  attachments: DraftApprovalAttachment[];
};

export type DraftApproval = {
  version: typeof DRAFT_APPROVAL_VERSION;
  purpose: typeof DRAFT_APPROVAL_PURPOSE;
  draftId: string;
  generationId: string;
  transportId: string;
  threadId: string;
  revisionId: string;
  threadStateVersion: string;
  policyVersion: typeof DRAFT_APPROVAL_POLICY_VERSION;
  approvedByUserId: string;
  approvedAt: string;
  bodyDigest: string;
  recipientDigest: string;
  attachmentDigest: string;
  evidenceDigest: string;
  routeBinding?: DraftApprovalRouteBinding;
  fingerprint: string;
  signature: string;
};

function isDraftRouteBinding(value: unknown): value is DraftApprovalRouteBinding {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DraftApprovalRouteBinding>;
  return (
    typeof candidate.routeId === 'string' &&
    candidate.routeId.trim().length > 0 &&
    typeof candidate.modelId === 'string' &&
    candidate.modelId.trim().length > 0 &&
    candidate.purpose === 'draft' &&
    candidate.protocol === 'in_process' &&
    candidate.access === 'current_app' &&
    candidate.egress === 'none' &&
    candidate.retention === 'bounded' &&
    candidate.usage === 'reported' &&
    (candidate.release === undefined || isDraftRouteReleaseDescriptor(candidate.release))
  );
}

/** Extract only the complete trusted route evidence persisted by the worker. */
export function resolveDraftApprovalRouteBinding(
  metrics: unknown,
): DraftApprovalRouteBinding | undefined {
  if (typeof metrics !== 'object' || metrics === null) return undefined;
  const candidate = (metrics as { routeBinding?: unknown }).routeBinding;
  return isDraftRouteBinding(candidate) ? candidate : undefined;
}

/** Resolve the server-only key used to authenticate approval snapshots. */
export function getDraftApprovalSigningSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new DraftApprovalError('approval signing secret unavailable');
  return secret;
}

const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Stable JSON for signed/fingerprinted approval inputs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortCanonical(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortCanonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function normalizedRecipients(input: DraftApprovalPayload): {
  to: string[];
  cc: string[];
  bcc: string[];
} {
  const normalize = (values: string[]) => values.map((value) => value.trim().toLowerCase());
  return {
    to: normalize(input.to),
    cc: normalize(input.cc),
    bcc: normalize(input.bcc),
  };
}

function normalizedAttachments(input: DraftApprovalPayload): Array<{
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentDigest: string;
}> {
  return input.attachments.map((attachment) => {
    const contentBase64 = attachment.contentBase64 ?? '';
    return {
      filename: attachment.filename,
      mimeType: attachment.mimeType ?? '',
      sizeBytes: attachment.sizeBytes ?? Buffer.from(contentBase64, 'base64').length,
      contentDigest: digest(contentBase64),
    };
  });
}

function requiredString(value: string | null | undefined, field: string): string {
  if (!value?.trim()) throw new DraftApprovalError(`approval field missing: ${field}`);
  return value;
}

function assertAiPayload(input: DraftApprovalPayload): void {
  if (input.origin !== 'ai') {
    throw new DraftApprovalError('only AI drafts may receive an approval token');
  }
  requiredString(input.draftId, 'draftId');
  requiredString(input.generationId, 'generationId');
  requiredString(input.transportId, 'transportId');
  requiredString(input.threadId, 'threadId');
  requiredString(input.revisionId, 'revisionId');
  requiredString(input.threadStateVersion, 'threadStateVersion');
  requiredString(input.approvedByUserId, 'approvedByUserId');
  requiredString(input.approvedAt, 'approvedAt');
  if (input.policyVersion !== DRAFT_APPROVAL_POLICY_VERSION) {
    throw new DraftApprovalError('approval policy version is not supported');
  }
}

function approvalFingerprint(input: {
  version: string;
  purpose: string;
  draftId: string;
  generationId: string;
  transportId: string;
  threadId: string;
  revisionId: string;
  threadStateVersion: string;
  policyVersion: string;
  approvedByUserId: string;
  approvedAt: string;
  bodyDigest: string;
  recipientDigest: string;
  attachmentDigest: string;
  evidenceDigest: string;
  routeBinding?: DraftApprovalRouteBinding;
}): string {
  return digest(input);
}

function approvalSignature(
  input: Parameters<typeof approvalFingerprint>[0] & { fingerprint: string },
  signingSecret: string,
): string {
  return createHmac('sha256', signingSecret).update(canonicalJson(input)).digest('hex');
}

/** Build a closed, opaque approval snapshot after the user reviewed the current editor. */
export function buildDraftApproval(
  input: DraftApprovalPayload,
  signingSecret: string,
): DraftApproval {
  requiredString(signingSecret, 'signingSecret');
  assertAiPayload(input);
  const recipients = normalizedRecipients(input);
  const attachments = normalizedAttachments(input);
  const bodyDigest = digest({
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
  const recipientDigest = digest(recipients);
  const attachmentDigest = digest(attachments);
  const evidenceDigest = digest(input.evidence ?? []);
  const approval = {
    version: DRAFT_APPROVAL_VERSION,
    purpose: DRAFT_APPROVAL_PURPOSE,
    draftId: requiredString(input.draftId, 'draftId'),
    generationId: requiredString(input.generationId, 'generationId'),
    transportId: requiredString(input.transportId, 'transportId'),
    threadId: requiredString(input.threadId, 'threadId'),
    revisionId: requiredString(input.revisionId, 'revisionId'),
    threadStateVersion: requiredString(input.threadStateVersion, 'threadStateVersion'),
    policyVersion: DRAFT_APPROVAL_POLICY_VERSION,
    approvedByUserId: requiredString(input.approvedByUserId, 'approvedByUserId'),
    approvedAt: requiredString(input.approvedAt, 'approvedAt'),
    bodyDigest,
    recipientDigest,
    attachmentDigest,
    evidenceDigest,
    ...(input.routeBinding ? { routeBinding: input.routeBinding } : {}),
  } as const;
  const fingerprint = approvalFingerprint(approval);
  const signed = {
    ...approval,
    fingerprint,
  };
  return {
    ...signed,
    signature: approvalSignature(signed, signingSecret),
  };
}

const draftApprovalSchema = z
  .object({
    version: z.literal(DRAFT_APPROVAL_VERSION),
    purpose: z.literal(DRAFT_APPROVAL_PURPOSE),
    draftId: z.string().min(1),
    generationId: z.string().min(1),
    transportId: z.string().min(1),
    threadId: z.string().min(1),
    revisionId: z.string().min(1),
    threadStateVersion: z.string().min(1),
    policyVersion: z.literal(DRAFT_APPROVAL_POLICY_VERSION),
    approvedByUserId: z.string().min(1),
    approvedAt: z.string().datetime(),
    bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
    recipientDigest: z.string().regex(/^[a-f0-9]{64}$/),
    attachmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    routeBinding: z
      .object({
        routeId: z.string().min(1),
        modelId: z.string().min(1),
        purpose: z.literal('draft'),
        protocol: z.literal('in_process'),
        access: z.literal('current_app'),
        egress: z.literal('none'),
        retention: z.literal('bounded'),
        usage: z.literal('reported'),
        release: z
          .object({
            releaseId: z.string().min(1),
            releaseVersion: z.string().min(1),
            sourceRevision: z.string().min(1),
            fingerprint: z.string().min(1),
            purpose: z.literal('draft'),
            capabilityFamilyVersions: z.record(z.string().min(1)),
            issuedAt: z.string().datetime(),
            expiresAt: z.string().datetime(),
            withdrawn: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function parseDraftApproval(raw: unknown, signingSecret: string): DraftApproval {
  requiredString(signingSecret, 'signingSecret');
  const parsed = draftApprovalSchema.safeParse(raw);
  if (!parsed.success) throw new DraftApprovalError('approval token shape is not supported');
  const expected = approvalFingerprint({
    version: parsed.data.version,
    purpose: parsed.data.purpose,
    draftId: parsed.data.draftId,
    generationId: parsed.data.generationId,
    transportId: parsed.data.transportId,
    threadId: parsed.data.threadId,
    revisionId: parsed.data.revisionId,
    threadStateVersion: parsed.data.threadStateVersion,
    policyVersion: parsed.data.policyVersion,
    approvedByUserId: parsed.data.approvedByUserId,
    approvedAt: parsed.data.approvedAt,
    bodyDigest: parsed.data.bodyDigest,
    recipientDigest: parsed.data.recipientDigest,
    attachmentDigest: parsed.data.attachmentDigest,
    evidenceDigest: parsed.data.evidenceDigest,
    routeBinding: parsed.data.routeBinding,
  });
  if (expected !== parsed.data.fingerprint) {
    throw new DraftApprovalError('approval fingerprint mismatch');
  }
  const { signature, ...signed } = parsed.data;
  const expectedSignature = approvalSignature(signed, signingSecret);
  const providedSignature = Buffer.from(signature, 'hex');
  const calculatedSignature = Buffer.from(expectedSignature, 'hex');
  if (
    providedSignature.length !== calculatedSignature.length ||
    !timingSafeEqual(providedSignature, calculatedSignature)
  ) {
    throw new DraftApprovalError('approval signature mismatch');
  }
  return parsed.data;
}

/** Compare a submitted send payload to the exact body/recipient/attachment review. */
export function assertDraftApprovalMatchesPayload(
  rawApproval: unknown,
  input: DraftApprovalPayload,
  signingSecret: string,
): DraftApproval {
  const approval = parseDraftApproval(rawApproval, signingSecret);
  const boundFields: Array<keyof DraftApprovalPayload> = [
    'draftId',
    'generationId',
    'transportId',
    'threadId',
    'revisionId',
    'threadStateVersion',
    'policyVersion',
    'routeBinding',
  ];
  for (const field of boundFields) {
    const submitted = input[field];
    const expected = approval[field as keyof DraftApproval];
    if (
      submitted !== undefined &&
      (field === 'routeBinding'
        ? canonicalJson(submitted) !== canonicalJson(expected)
        : submitted !== expected)
    ) {
      throw new DraftApprovalError(`approval field changed: ${field}`);
    }
  }
  const rebuilt = buildDraftApproval(
    {
      ...input,
      draftId: input.draftId ?? approval.draftId,
      generationId: input.generationId ?? approval.generationId,
      transportId: input.transportId ?? approval.transportId,
      threadId: input.threadId ?? approval.threadId,
      revisionId: input.revisionId ?? approval.revisionId,
      threadStateVersion: input.threadStateVersion ?? approval.threadStateVersion,
      policyVersion: input.policyVersion ?? approval.policyVersion,
      approvedByUserId: approval.approvedByUserId,
      approvedAt: approval.approvedAt,
      routeBinding: input.routeBinding ?? approval.routeBinding,
      origin: 'ai',
    },
    signingSecret,
  );
  if (
    rebuilt.bodyDigest !== approval.bodyDigest ||
    rebuilt.recipientDigest !== approval.recipientDigest ||
    rebuilt.attachmentDigest !== approval.attachmentDigest ||
    (input.evidence !== undefined &&
      (rebuilt.evidenceDigest !== approval.evidenceDigest ||
        rebuilt.fingerprint !== approval.fingerprint))
  ) {
    throw new DraftApprovalError('approval does not match current send payload');
  }
  return approval;
}

function checkEvidenceFreshness(evidence: unknown[], now: Date): boolean {
  // An approved-local mail-only draft makes no external factual claim and
  // therefore has no HMS evidence to expire.  The human approval still binds
  // the exact body, recipients, revision, generation, route, and thread
  // state; non-empty evidence remains strict HMS-only validation below.
  if (!Array.isArray(evidence) || evidence.length === 0) return true;
  for (const raw of evidence) {
    const parsed = EvidenceRefSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== 'hms') return false;
    if (!isEvidenceFresh(parsed.data, now)) return false;
  }
  return true;
}

export type CurrentDraftApprovalPayload = DraftApprovalPayload & {
  draftId: string;
  generationId: string;
  transportId: string;
  threadId: string;
  revisionId: string;
  threadStateVersion: string;
};

/**
 * Re-read mutable draft/generation/revision state immediately before enqueue or
 * SMTP. This intentionally accepts a loader dependency to avoid coupling the
 * token module to a router (the queue and router both use this fence).
 */
export async function assertDraftApprovalCurrent(input: {
  db: DB;
  approval: unknown;
  payload: DraftApprovalPayload;
  loadThreadStateVersion: (
    db: DB,
    input: { transportId: string; threadId: string },
  ) => Promise<string>;
  queueMessageId?: string;
  now?: Date;
  signingSecret: string;
}): Promise<DraftApproval> {
  const approval = assertDraftApprovalMatchesPayload(
    input.approval,
    input.payload,
    input.signingSecret,
  );
  const now = input.now ?? new Date();
  const [draft] = await input.db
    .select()
    .from(mailDraft)
    .where(
      and(
        eq(mailDraft.id, approval.draftId),
        eq(mailDraft.transportId, approval.transportId),
        eq(mailDraft.origin, 'ai'),
        or(
          and(eq(mailDraft.isSent, false), eq(mailDraft.status, 'active')),
          and(eq(mailDraft.isSent, true), eq(mailDraft.status, 'sent')),
        ),
      ),
    )
    .limit(1);
  if (
    !draft ||
    draft.generationId !== approval.generationId ||
    draft.threadId !== approval.threadId
  ) {
    throw new DraftApprovalError('draft is no longer an active AI draft');
  }

  const [revision] = await input.db
    .select()
    .from(mailDraftRevision)
    .where(
      and(
        eq(mailDraftRevision.draftId, approval.draftId),
        eq(mailDraftRevision.id, approval.revisionId),
      ),
    )
    .limit(1);
  if (!revision) throw new DraftApprovalError('approved draft revision no longer exists');

  const [latestRevision] = await input.db
    .select({
      id: mailDraftRevision.id,
      kind: mailDraftRevision.kind,
      sentMessageId: mailDraftRevision.sentMessageId,
    })
    .from(mailDraftRevision)
    .where(eq(mailDraftRevision.draftId, approval.draftId))
    .orderBy(desc(mailDraftRevision.createdAt), desc(mailDraftRevision.id))
    .limit(1);
  if (
    latestRevision?.id !== approval.revisionId &&
    !(
      input.queueMessageId &&
      latestRevision?.kind === 'sent' &&
      latestRevision.sentMessageId === input.queueMessageId
    )
  ) {
    throw new DraftApprovalError('draft changed after approval');
  }

  const [generation] = await input.db
    .select()
    .from(aiDraftGeneration)
    .where(
      and(
        eq(aiDraftGeneration.id, approval.generationId),
        eq(aiDraftGeneration.transportId, approval.transportId),
        eq(aiDraftGeneration.threadId, approval.threadId),
      ),
    )
    .limit(1);
  if (!generation || generation.status !== 'succeeded') {
    throw new DraftApprovalError('approved generation is unavailable');
  }
  if (digest(generation.evidence ?? []) !== approval.evidenceDigest) {
    throw new DraftApprovalError('draft evidence changed after approval');
  }
  if (!checkEvidenceFreshness(generation.evidence ?? [], now)) {
    throw new DraftApprovalError('draft evidence is no longer fresh');
  }

  const [run] = await input.db
    .select({ metrics: aiWorkflowRun.metrics })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.generationId, approval.generationId),
        eq(aiWorkflowRun.runKind, 'candidate_draft'),
        eq(aiWorkflowRun.state, 'succeeded'),
      ),
    )
    .orderBy(desc(aiWorkflowRun.finishedAt), desc(aiWorkflowRun.createdAt))
    .limit(1);
  if (
    (run?.metrics as { modelRouteUnavailable?: unknown } | null)?.modelRouteUnavailable === true
  ) {
    throw new DraftApprovalError('approved draft route unavailable');
  }

  if (approval.routeBinding) {
    const currentAuthority = resolveCurrentDraftRouteAuthority();
    if (currentAuthority || approval.routeBinding.release) {
      const currentRoute = currentAuthority
        ? { ...currentAuthority.route, release: currentAuthority.release }
        : undefined;
      if (
        !approval.routeBinding.release ||
        !currentRoute ||
        canonicalJson(currentRoute) !== canonicalJson(approval.routeBinding)
      ) {
        throw new DraftApprovalError('approved draft route release changed');
      }
    } else {
      const persistedRoute = resolveDraftApprovalRouteBinding(run?.metrics);
      if (
        !persistedRoute ||
        canonicalJson(persistedRoute) !== canonicalJson(approval.routeBinding)
      ) {
        throw new DraftApprovalError('approved draft route release changed');
      }
    }
  }

  const liveThreadStateVersion = await input.loadThreadStateVersion(input.db, {
    transportId: approval.transportId,
    threadId: approval.threadId,
  });
  if (liveThreadStateVersion !== approval.threadStateVersion) {
    throw new DraftApprovalError('thread changed after approval');
  }
  return approval;
}

/**
 * Linearize an approved AI send inside the caller's short DB transaction.
 * The draft row is the mutable-state claim: edits that already committed are
 * observed by the locked validation, while edits that race afterward wait for
 * the row lock and cannot update a sent draft. No model or SMTP I/O belongs in
 * this transaction.
 */
export async function claimDraftApprovalForSend(
  input: Parameters<typeof assertDraftApprovalCurrent>[0] & { queueMessageId: string },
): Promise<DraftApproval> {
  if (!input.queueMessageId.trim()) {
    throw new DraftApprovalError('send claim is missing its queue message id');
  }
  const parsedApproval = parseDraftApproval(input.approval, input.signingSecret);
  const [lockedDraft] = await input.db
    .select({
      id: mailDraft.id,
    })
    .from(mailDraft)
    .where(
      and(
        eq(mailDraft.id, parsedApproval.draftId),
        eq(mailDraft.transportId, parsedApproval.transportId),
        eq(mailDraft.origin, 'ai'),
        eq(mailDraft.isSent, false),
        eq(mailDraft.status, 'active'),
      ),
    )
    .limit(1)
    .for('update');
  if (!lockedDraft) throw new DraftApprovalError('draft changed before send claim');

  const approval = await assertDraftApprovalCurrent(input);
  const [claimed] = await input.db
    .update(mailDraft)
    .set({
      isSent: true,
      status: 'sent',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mailDraft.id, lockedDraft.id),
        eq(mailDraft.transportId, approval.transportId),
        eq(mailDraft.origin, 'ai'),
        eq(mailDraft.isSent, false),
        eq(mailDraft.status, 'active'),
      ),
    )
    .returning({ id: mailDraft.id });
  if (!claimed) throw new DraftApprovalError('draft changed during send claim');
  return approval;
}
