import type { PaneStayInput } from './pane-stay-bind';

export type BatchSourceIdentity = { stayId: string; rowId: string; roomIndex: number };

/** The server resolves profile IDs and property, and stores the returned immutable manifest in its approval form. */
export type BatchReviewInput = {
  propertyCode: string;
  source: { transportId: string; threadId: string; messageId: string; workItemId: string };
  rooms: Array<{ allocationId: string; identity: BatchSourceIdentity; stay: PaneStayInput; amount: { minor: number | null; currency: string | null;
    basis: 'room_night' | 'unknown'; tax: 'unknown'; status: 'estimate' | 'unavailable' } }>;
};
export type BatchReviewedRoom = {
  allocationId: string; identity: BatchSourceIdentity; roomType: string; ratePlan: string;
  guest: { firstName: string; lastName: string; profileId: string };
  stay: { arrival: string; departure: string; adults: number; childAges: number[] };
  agency: { name: string; nativeId: string } | null;
  organization: { name: string; nativeId: string } | null;
  guaranteeType: string; sourceOfBusiness: string | null; note: string | null;
  track: string | null; marketSegment: string | null; guestOptIn: boolean;
  booker: { name: string | null; email: string | null } | null; cmsSend: false;
  amount: { status: 'unknown' | 'unavailable' | 'estimate' | 'confirmed'; minor?: number | null; currency?: string | null; basis?: string; tax?: string };
};
export type BatchReview = { reviewId: string; manifestDigest: string; expiresAt: string; batchLimit: number | null;
  /** Server-discovered unsupported fields/pricing block approval until actually supported. */
  blockers: string[]; propertyCode: string; source: BatchReviewInput['source']; rooms: BatchReviewedRoom[] };
export type BatchEvidenceScope = { workItemId: string; runId: string; childId: string };
/** The server persists this decision for the exact child attempt and evidence version. */
export type BatchChildReview = BatchEvidenceScope & { evidenceVersion: string; decision: 'ok' | 'flag' };
export type BatchRoomResult = { allocationId: string; status: 'unattempted' | 'uncertain' | 'confirmed' | 'not_dispatched' | 'failed' | 'reconciled_not_booked';
  /** Evidence existence only; storage paths never leave the server. */
  confirmation?: string; screenshotRecorded?: boolean; readbackRecorded?: boolean;
  /** Original write run, including when another approved run later continues the batch. */
  attempt?: { runId: string; childId: string };
  reviewed?: BatchChildReview | null };
export type BatchEvidenceReply = BatchEvidenceScope & (
  | { status: 'available'; evidenceVersion: string; dataUrl: string }
  | { status: 'unavailable' | 'expired' }
);
export type BatchReviewChildInput = BatchEvidenceScope & { evidenceVersion: string } & (
  | { decision: 'ok' }
  | { decision: 'flag'; note: string }
);
export type BatchReviewChildReply = BatchChildReview & { status: 'recorded' };
export type PaneBatchClient = {
  /** Only the separate server batch capability enables this client, never single-create mode. */
  prepare: (input: BatchReviewInput) => Promise<BatchReview>;
  approve: (input: { workItemId: string; reviewId: string; manifestDigest: string }) => Promise<{ runId: string }>;
  /** Strongly consistent, owner-checked fresh read of persisted attempts and decisions for this exact batch run. Storage refs never leave the server. */
  read: (input: { workItemId: string; runId: string }) => Promise<{ workItemId: string; runId: string; rooms: BatchRoomResult[]; complete: boolean }>;
  /** Authenticated, owner-checked fetch for this particular child attempt, never a client-supplied storage path. */
  evidence?: (input: BatchEvidenceScope) => Promise<BatchEvidenceReply>;
  /** Idempotent, single durable decision tied to the evidence version displayed; acknowledgement alone is not proof of persistence. */
  reviewChild?: (input: BatchReviewChildInput) => Promise<BatchReviewChildReply>;
};
