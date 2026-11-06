import type {
  ReservationWorkflowV2Draft,
  ReservationWorkflowV2Source,
} from '../../../server-pilot/src/ai/reservation-workflow-v2-contract.js';

export type ReservationFieldOverride = ReservationWorkflowV2Draft['fieldOverrides'][string];

/** Mailbox identity plus host-owned source/display metadata. The hash and cutoff come from resolveSource. */
export type ReservationSourceContext = {
  mailboxId: string;
  propertyId: string;
  internetMessageId: string | null;
  messageId: string;
  threadId: string | null;
  sourceHash: string;
  arrivedAt: string;
  selectionEpoch: number;
  subject: string;
  sender: string;
  receivedAt?: string;
  attachments: ReservationAttachmentView[];
};

export type ReservationAttachmentView = {
  sourceRef: string;
  name: string;
  mimeType?: string;
  uploadability: 'ready' | 'checking' | 'unsupported' | 'unknown';
  detail?: string;
};

export type ReservationWorkflowV2Session = {
  draft: ReservationWorkflowV2Draft;
  revision: number;
  revisionHead: number;
  seq: number;
  preparationViews: ReservationPreparationView[];
};

export type ReservationPreparationView = {
  requestId: string;
  allocationId: string;
  current: boolean;
  issue?: string;
  price?: { averageRate?: unknown; totalRate?: unknown; currency?: unknown };
};

export type ReservationFieldProjection = {
  path: string;
  value: unknown;
  override?: ReservationFieldOverride;
  required: boolean;
  review: 'pending' | 'accepted' | 'flagged';
  provenance: 'source' | 'native_read' | 'policy' | 'inferred' | 'assumption' | 'manual' | 'unknown';
  evidenceRefs: string[];
  issue?: string;
};

export type ReservationRequestProjection = {
  id: string;
  kind: 'create' | 'quote' | 'amend' | 'cancel' | 'services' | 'filing' | 'other';
  text: string;
  fieldPaths: string[];
  supported: boolean;
};

export type ReservationPaneSnapshot = {
  session: ReservationWorkflowV2Session;
  sourceMessageId: string;
  requests: ReservationRequestProjection[];
  fields: Record<string, ReservationFieldProjection>;
  issues: Array<{ path?: string; kind: string; explanation: string; evidenceRefs: string[] }>;
  operationResults: Array<Record<string, unknown>>;
  preparationViews: ReservationPreparationView[];
  preparation: {
    state: 'idle' | 'stale' | 'current';
    message: string;
  };
  serviceNotice?: string;
  loading?: boolean;
  loadError?: string;
};

export type ReservationWorkflowKind = ReservationRequestProjection['kind'];

export type ReservationCommandContext = {
  source: ReservationSourceContext;
  snapshot: ReservationPaneSnapshot;
};

export type ReservationEditCommand = ReservationCommandContext & {
  requestId: string;
  fieldPath: string;
  state: ReservationFieldOverride['state'];
  value?: unknown;
};

export type ReservationReviewCommand = ReservationCommandContext & {
  fieldPath: string;
  decision: 'accepted' | 'flagged';
  note?: string | null;
};

/** Client boundary is bound to reservationWorkflowV2; no quoteWorkflow DTOs cross it. */
export interface ReservationWorkflowClient {
  ensure(input: { source: ReservationSourceContext }): Promise<ReservationPaneSnapshot>;
  get(input: ReservationCommandContext): Promise<ReservationPaneSnapshot>;
  edit(input: ReservationEditCommand): Promise<ReservationPaneSnapshot>;
  review(input: ReservationReviewCommand): Promise<ReservationPaneSnapshot>;
  undo(input: ReservationCommandContext): Promise<ReservationPaneSnapshot>;
  redo(input: ReservationCommandContext): Promise<ReservationPaneSnapshot>;
  lookup(input: ReservationCommandContext & { requestId?: string }): Promise<ReservationPaneSnapshot>;
  prepare(input: ReservationCommandContext & { requestId: string; allocationId: string }): Promise<ReservationPaneSnapshot>;
  execute(input: ReservationCommandContext & { requestId: string; allocationId: string; idempotencyKey: string }): Promise<ReservationPaneSnapshot>;
  reconcile(input: ReservationCommandContext & { operationId: string }): Promise<ReservationPaneSnapshot>;
}

export type ReservationWorkflowV2WireSource = ReservationWorkflowV2Source;
