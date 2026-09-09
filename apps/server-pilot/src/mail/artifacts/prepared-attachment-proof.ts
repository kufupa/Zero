import type { AuthorizedArtifactBytes } from './read-artifact.js';

/**
 * Scope minted by the server-side attachment selection path.  It intentionally
 * contains no body bytes and is never derived from prepared-input metadata.
 */
export type PreparedAttachmentReaderScope = {
  attachmentId: string;
  artifactRef: string;
  ownerRef: string;
  threadId: string;
  observedAt: string;
  expiresAt?: string;
  kind?: 'pdf' | 'image' | 'text' | 'other';
};

export type PreparedAttachmentReaderProof = PreparedAttachmentReaderScope & {
  sourceHash: string;
  selectedBytes: true;
};

// The weak association means a copied/forged bytes-shaped object cannot carry
// the reader's proof into authorizePreparedAttachment.
const proofs = new WeakMap<AuthorizedArtifactBytes, PreparedAttachmentReaderProof>();

/** @internal Called only by readAuthorizedArtifactBytes after all lower checks. */
export function registerPreparedAttachmentReaderBytes(
  bytes: AuthorizedArtifactBytes,
  scope: PreparedAttachmentReaderScope,
): void {
  proofs.set(bytes, {
    ...scope,
    sourceHash: bytes.sha256,
    selectedBytes: true,
  });
}

export function preparedAttachmentReaderProofFor(
  bytes: AuthorizedArtifactBytes,
): PreparedAttachmentReaderProof | undefined {
  return proofs.get(bytes);
}
