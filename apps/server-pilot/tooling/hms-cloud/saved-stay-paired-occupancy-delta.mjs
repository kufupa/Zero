// Offline transition classifier only. No page, request, stage or Save authority.
import { isDeepStrictEqual } from 'node:util';
import { labtestCombinedAmendPreimageBinding } from './saved-stay-combined-preimage.mjs';
import { matchesSavedChildEditorOpen, planSavedChildOccupancy, savedChildDraftDelta } from './guest-stay-amend-children.mjs';
import { labtestAdultAmendDraftDelta } from './guest-stay-amend-adults.mjs';

const same = isDeepStrictEqual;
const invalid = () => ({ outcome:'offline_mismatch', canStage:false, saveEligible:false, saveDispatched:false });
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const uniqueNames = (value) => Array.isArray(value) && value.every((name) => typeof name === 'string' && name.length > 0) &&
  new Set(value).size === value.length;
const isCount = (value, wanted) => (typeof value === 'number' && value === wanted) ||
  (typeof value === 'string' && value === String(wanted));
const childEvidenceMatches = (evidence, plan) => {
  if (!isRecord(evidence) || evidence.outcome !== 'applied_to_unsaved_draft' || evidence.nativeValidationVerified !== true ||
      !same(evidence.requested, plan) || !same(evidence.nativeResponseAges, plan.childAges) || !isRecord(evidence.draftVisible)) return false;
  const counts = { children:plan.childCount, ...plan.derivedBands };
  return Object.entries(counts).every(([name, wanted]) => isRecord(evidence.draftVisible[name]) &&
    isCount(evidence.draftVisible[name].visible, wanted) && isCount(evidence.draftVisible[name].component, wanted));
};

/**
 * Diagnose a synthetic clean -> editor-open -> child -> adult snapshot chain.
 * The two native interactions, their ordering and the continuation are unproven;
 * a match never grants staging, approval, request continuation or Save authority.
 */
export function classifyPairedOccupancyDelta({ expected, state, baseline, binding, changes, native, opened, childDraft, childEvidence, adultDraft } = {}) {
  try {
    if (!isRecord(expected) || !isRecord(changes) || !Object.hasOwn(changes, 'adults') ||
        !Object.hasOwn(changes, 'childCount') || !Object.hasOwn(changes, 'childAges') ||
        changes.adults === expected.adults || !Array.isArray(expected.childAges) ||
        same(changes.childAges, expected.childAges)) return invalid();
    const currentBinding = labtestCombinedAmendPreimageBinding(expected, state, baseline, changes);
    const plan = planSavedChildOccupancy({ childCount:changes.childCount, childAges:changes.childAges });
    if (!currentBinding || !same(currentBinding, binding) || plan.outcome !== 'planned' || plan.childAges === null ||
        !isRecord(native) || native.propertyCode !== 'HRCEN' || native.reservationStayId !== state.native.reservationstayid ||
        !same(native.childAges, expected.childAges) || !matchesSavedChildEditorOpen(baseline, opened, native) ||
        !savedChildDraftDelta(opened, childDraft, plan).ok || !childEvidenceMatches(childEvidence, plan)) return invalid();
    if (!isRecord(adultDraft) || !same(Object.keys(childDraft).sort(), Object.keys(adultDraft).sort()) ||
        adultDraft.formDirty !== true || adultDraft.recordDirty !== true ||
        !uniqueNames(childDraft.dirtyFields) || !uniqueNames(childDraft.modifiedFields) ||
        !uniqueNames(adultDraft.dirtyFields) || !uniqueNames(adultDraft.modifiedFields) ||
        childDraft.dirtyFields.includes('adults') || childDraft.modifiedFields.includes('adults') ||
        childDraft.dirtyFields.some((name) => !adultDraft.dirtyFields.includes(name)) ||
        childDraft.modifiedFields.some((name) => !adultDraft.modifiedFields.includes(name)) ||
        !adultDraft.dirtyFields.includes('adults') || !adultDraft.modifiedFields.includes('adults')) return invalid();
    const mutable = new Set(['data', 'values', 'formDirty', 'recordDirty', 'dirtyFields', 'modifiedFields']);
    if (Object.keys(childDraft).some((name) => !mutable.has(name) && !same(childDraft[name], adultDraft[name]))) return invalid();
    // Projection exists only to reuse the adult delta classifier after the exact
    // child transition and all original dirty flags have been independently checked.
    // It is never passed to HMS or represented as the actual clean preimage.
    const projectedBefore = { ...childDraft, formDirty:false, recordDirty:false, dirtyFields:[], modifiedFields:[] };
    const projectedAfter = { ...adultDraft,
      dirtyFields:adultDraft.dirtyFields.filter((name) => !childDraft.dirtyFields.includes(name)),
      modifiedFields:adultDraft.modifiedFields.filter((name) => !childDraft.modifiedFields.includes(name)) };
    if (!labtestAdultAmendDraftDelta(projectedBefore, projectedAfter, changes.adults).ok) return invalid();
    return { outcome:'offline_match', canStage:false, saveEligible:false, saveDispatched:false };
  } catch { return invalid(); }
}
