import type { RowChange } from './views';
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
  sourceText?: string;
  selfPreStay?: boolean;
  attachments: ReservationAttachmentView[];
};

export type ReservationAttachmentView = {
  sourceRef: string;
  name: string;
  mimeType?: string;
  size?: number;
  uploadability: 'ready' | 'checking' | 'unsupported' | 'unknown';
  detail?: string;
};

export type ReservationWorkflowV2Session = {
  draft: ReservationWorkflowV2Draft;
  sourceChanged?: boolean;
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
  /** Ephemeral last v2 native response; used only for workflow-specific review bindings. */
  workflowReply?: Record<string, unknown>;
  loading?: boolean;
  loadError?: string;
};

export class ReservationWorkflowStaleRevisionError extends Error {
  constructor(readonly snapshot: ReservationPaneSnapshot) {
    super('The reservation draft changed elsewhere. Latest saved values were loaded; your unsaved edits are preserved for review before saving again.');
    this.name = 'ReservationWorkflowStaleRevisionError';
  }
}

export type ReservationSavedServiceTarget = { kind: 'saved_target'; requestId: string; hintId: string };
export type ReservationServiceInput = { allocationId?: string; targetRef?: ReservationSavedServiceTarget };

export type ReservationWorkflowKind = ReservationRequestProjection['kind'];

export type ReservationCommandContext = {
  source: ReservationSourceContext;
  snapshot: ReservationPaneSnapshot;
};

export type ReservationGuestProfileCommand = ReservationCommandContext & {
  requestId: string;
  allocationId: string;
  confirmDuplicateName?: boolean;
};
export type ReservationGuestProfileOptionField = 'title' | 'phoneType' | 'emailType';

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
  ensure(input: { source: ReservationSourceContext; mode?: 'initialize' | 'prefill' }): Promise<ReservationPaneSnapshot>;
  prefill(input: ReservationCommandContext): Promise<ReservationPaneSnapshot>;
  addAction(input: ReservationCommandContext & { kind: Exclude<ReservationWorkflowKind, 'other'> }): Promise<ReservationPaneSnapshot>;
  changeRows(input: ReservationCommandContext & RowChange): Promise<ReservationPaneSnapshot>;
  selectNative(input: ReservationCommandContext & { requestId: string; fieldPath: string; observationRef: string }): Promise<ReservationPaneSnapshot>;
  reviewScope(input: ReservationCommandContext & { requestId: string; scope: 'request' | 'allocations' | 'targets' | 'services' | 'documents'; ids: string[] }): Promise<ReservationPaneSnapshot>;
  get(input: ReservationCommandContext): Promise<ReservationPaneSnapshot>;
  reconcileSource(input: ReservationCommandContext): Promise<ReservationPaneSnapshot>;
  edit(input: ReservationEditCommand): Promise<ReservationPaneSnapshot>;
  review(input: ReservationReviewCommand): Promise<ReservationPaneSnapshot>;
  undo(input: ReservationCommandContext): Promise<ReservationPaneSnapshot>;
  redo(input: ReservationCommandContext): Promise<ReservationPaneSnapshot>;
  lookup(input: ReservationCommandContext & { requestId?: string }): Promise<ReservationPaneSnapshot>;
  guestProfileOptions(input: ReservationCommandContext & { requestId: string; allocationId: string;
    field: ReservationGuestProfileOptionField }): Promise<ReservationPaneSnapshot>;
  prepareGuestProfile(input: ReservationGuestProfileCommand): Promise<ReservationPaneSnapshot>;
  createGuestProfile(input: ReservationGuestProfileCommand & { prepareRef: string; idempotencyKey: string }): Promise<ReservationPaneSnapshot>;
  prepare(input: ReservationCommandContext & { requestId: string; allocationId?: string }): Promise<ReservationPaneSnapshot>;
  execute(input: ReservationCommandContext & { requestId: string; allocationId?: string; idempotencyKey: string }): Promise<ReservationPaneSnapshot>;
  reconcile(input: ReservationCommandContext & { operationId: string }): Promise<ReservationPaneSnapshot>;
  configureFiling(input: ReservationCommandContext & { requestId: string; attachmentId: string; confirmation: string;
    kind: 'voucher' | 'payment_proof' }): Promise<ReservationPaneSnapshot>;
  lookupServices(input: ReservationCommandContext & ReservationServiceInput & { requestId: string; serviceId?: string }): Promise<ReservationPaneSnapshot>;
  previewServices(input: ReservationCommandContext & ReservationServiceInput & { requestId: string; serviceId?: string }): Promise<ReservationPaneSnapshot>;
  executeServices(input: ReservationCommandContext & ReservationServiceInput & { requestId: string; serviceId: string;
    idempotencyKey: string; reviewedPrepareRef?: string }): Promise<ReservationPaneSnapshot>;
  reconcileServices(input: ReservationCommandContext & { operationId: string }): Promise<ReservationPaneSnapshot>;
}

export type ReservationWorkflowV2WireSource = ReservationWorkflowV2Source;
