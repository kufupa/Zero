import { matchesFullCreateBody, stableNativeCreateFormDigest } from './guest-stay-save.mjs';

/**
 * Digest an exact native request only after matching its body and fixed controls
 * to the supplied form. This does not validate the native field schema or
 * authorize a save. Callers must independently require the approved schema.
 */
export function stableNativeCreateBodyDigest(body, formData) {
  try {
    if (!(body instanceof URLSearchParams) || !matchesFullCreateBody(body, formData)) return null;
    return stableNativeCreateFormDigest(formData);
  } catch {
    return null;
  }
}
