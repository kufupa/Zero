import type { SyncObservationV1 } from './contracts.js';
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export function immutableSemantic(semantic: SyncObservationV1['semantic']) {
  const { isRead: _read, categories: _categories, ...immutable } = semantic;
  return immutable;
}
export function differingSemanticFields(a: SyncObservationV1, b: SyncObservationV1): string[] {
  const left: Record<string, unknown> = immutableSemantic(a.semantic);
  const right: Record<string, unknown> = immutableSemantic(b.semantic);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    .filter((key) => stableJson(left[key]) !== stableJson(right[key]));
}
/** Signed content identity complements immutable semantic evidence; provider attachment identities are mandatory. */
export function reusableContent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const left = a as unknown as SyncObservationV1,
    right = b as unknown as SyncObservationV1;
  if (
    (left.optionalMissing?.length ?? 0) > 0 ||
    (right.optionalMissing?.length ?? 0) > 0 ||
    !left.contentIdentity ||
    !right.contentIdentity ||
    stableJson(left.contentIdentity) !== stableJson(right.contentIdentity)
  )
    return false;
  const immutable = (o: typeof left) => {
    const { modifiedAt: _modified, ...timestamps } = o.timestamps;
    return {
      semantic: immutableSemantic(o.semantic),
      timestamps,
      direction: o.direction,
      requiredArtifactRoles: o.requiredArtifactRoles,
    };
  };
  const attachments = left.requiredArtifactRoles.filter((role) => role.startsWith('attachment:'));
  return (
    attachments.length === left.contentIdentity.attachments.length &&
    attachments.every((role) =>
      left.contentIdentity!.attachments.some((a) => a.role === role && a.stableId && a.modifiedAt),
    ) &&
    stableJson(immutable(left)) === stableJson(immutable(right))
  );
}
