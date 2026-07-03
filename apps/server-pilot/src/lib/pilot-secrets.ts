/** Merge new/rotated pilot credentials into existing Secrets Manager JSON. */
export function mergePilotSecretPayload(
  existing: Record<string, { password: string }>,
  updates: Record<string, { password: string }>,
): Record<string, { password: string }> {
  return { ...existing, ...updates };
}
