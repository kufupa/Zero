import { readFile } from 'node:fs/promises';

const clean = value => value == null ? null : String(value).trim() || null;
const fields = {
  agencies: ['nativeId', 'nativeId', 'name'], organizations: ['nativeId', 'nativeId', 'name'],
  arAccounts: ['nativeId', 'accountNumber', 'name'], ratePlans: ['nativeId', 'code', 'name'],
  roomTypes: ['nativeId', 'code', 'name'], trackSubsegment: ['nativeId', 'code', 'description'],
  guaranteeTypes: ['value', 'value', 'label'], sourceBusiness: ['nativeCode', 'nativeCode', 'description'],
  cmsMessages: ['code', 'code', 'description'],
};

/** Compare directory percent with the same agency's unsaved native form readback. */
export function validateAgencyCommissionMapping(samples = []) {
  const comparisons = new Map();
  for (const sample of samples) {
    const candidate = sample?.candidate, selected = sample?.selection;
    const id = clean(candidate?.nativeId);
    const values = (selected?.form?.fields || []).filter(field => field.name === 'ta1commission');
    if (!id || selected?.outcome !== 'selected_unsaved' || selected.nativeIdEvidence !== 'form_change_response' ||
        clean(selected.nativeId) !== id || candidate?.commissionEvidence?.mapping !== 'correlated_agency_directory_percent' ||
        typeof candidate.commissionPercent !== 'number' || values.length !== 1 || !/^\d+(?:\.\d+)?$/.test(clean(values[0].value) || '')) continue;
    const match = Number(values[0].value) === candidate.commissionPercent;
    comparisons.set(id, comparisons.has(id) ? comparisons.get(id) && match : match);
  }
  const denominator = comparisons.size, numerator = [...comparisons.values()].filter(Boolean).length;
  return { numerator, denominator, confidence: denominator ? numerator / denominator : null,
    basis: 'same_agency_unsaved_native_form_readback' };
}

/** Confirm a rate/meal pair from a selected unsaved native form, not from a code prefix. */
export function validateRateMealReadback({ propertyCode, selection, form } = {}) {
  if (selection?.outcome !== 'selected_unsaved' || selection.propertyCode !== propertyCode ||
      !['validated_row_and_existing_draft', 'validated_row_and_draft_change_response'].includes(selection.nativeCodeEvidence) ||
      form?.outcome !== 'ok' || !Array.isArray(form.fields)) return null;
  const values = name => form.fields.filter(field => field.name === name).map(field => clean(field.value));
  const rates = values('rateplan'), meals = values('mealplan');
  const code = clean(selection.code);
  if (!code || rates.length !== 1 || rates[0] !== code || meals.length !== 1 || !meals[0]) return null;
  return { ratePlan: code, mealPlan: meals[0], propertyCode,
    basis: 'validated_unsaved_rate_and_native_meal_readback' };
}

/** Normalize private read results without promoting filtered or partial grids to whole catalogs. */
export function normalizeHmsNativeCatalog({ propertyCode, capturedAt, source, catalogs, commissionMapping, rateMealReadbacks = [] } = {}) {
  const property = clean(propertyCode)?.toUpperCase();
  if (!property || !Number.isFinite(Date.parse(capturedAt)) || !clean(source) || !catalogs || typeof catalogs !== 'object') {
    throw new TypeError('Catalog property, capture time, source and results are required.');
  }
  const time = new Date(capturedAt).toISOString();
  const normalized = {};
  for (const [kind, result] of Object.entries(catalogs)) {
    if (!Object.hasOwn(fields, kind) || !result || typeof result !== 'object') continue;
    const [idField, codeField, labelField] = fields[kind];
    const rows = Array.isArray(result.candidates) ? result.candidates : Array.isArray(result.options) ? result.options : [];
    const coverage = result.coverage && typeof result.coverage === 'object' ? result.coverage : {};
    const criteria = result.criteria && typeof result.criteria === 'object' ? result.criteria : {};
    const query = typeof criteria.query === 'string' ? criteria.query.trim() : null;
    const rateShopScope = kind === 'ratePlans' && criteria.scope !== 'property_master';
    const filtered = rateShopScope || (query === null ? criteria.scope !== 'unfiltered' : query !== '') ||
      coverage.nativeFiltered === true;
    const complete = !filtered && (coverage.complete === true || coverage.truncated === false) &&
      (typeof coverage.loaded !== 'number' || rows.length >= coverage.loaded);
    normalized[kind] = { status: result.outcome || 'unknown', scope: { kind: rateShopScope ? 'rate_shop' : filtered ? 'filtered_or_unknown' : 'unfiltered',
      query, wholeCatalogComplete: complete }, coverage: { ...coverage, complete }, records: rows.flatMap(row => {
      const nativeId = clean(row[idField]), code = clean(row[codeField]), meaning = clean(row[labelField]);
      if (!nativeId && !code && !meaning) return [];
      const base = { nativeId, code, meaning, propertyCode: property, capturedAt: time,
        provenance: { source, scope: criteria.scope || null },
        confidence: { numerator: 1, denominator: 1, value: 1, basis: 'native_record_observation' } };
      if (kind === 'agencies') {
        const verified = commissionMapping?.basis === 'same_agency_unsaved_native_form_readback' &&
          Number.isSafeInteger(commissionMapping.denominator) && commissionMapping.denominator > 0 &&
          Number.isSafeInteger(commissionMapping.numerator) && commissionMapping.numerator <= commissionMapping.denominator &&
          commissionMapping.numerator / commissionMapping.denominator >= 0.9 &&
          row.commissionEvidence?.mapping === 'correlated_agency_directory_percent' &&
          row.commissionEvidence?.confidence >= 0.9 && typeof row.commissionPercent === 'number' &&
          Number.isFinite(row.commissionPercent) && row.commissionPercent >= 0 && row.commissionPercent <= 100;
        return [{ ...base, commissionPercent: verified ? row.commissionPercent : null,
          commissionEvidence: { directory: row.commissionEvidence || null, mapping: commissionMapping || null } }];
      }
      if (kind === 'ratePlans') {
        const nativeMeal = clean(row.responseData?.mealplan);
        const gridMeal = clean(row.gridData?.mealplan);
        const matched = rateMealReadbacks.filter(item => item?.propertyCode === property && item.ratePlan === code &&
          item.basis === 'validated_unsaved_rate_and_native_meal_readback' && clean(item.mealPlan));
        const observedMeals = [...new Set(matched.map(item => item.mealPlan))];
        const directMeal = nativeMeal && nativeMeal === gridMeal ? nativeMeal : null;
        const mealPlan = observedMeals.length === 1 && (!directMeal || directMeal === observedMeals[0]) ? observedMeals[0] : null;
        return [{ ...base, mealPlan, mealPlanEvidence: mealPlan ? {
          basis: 'validated_unsaved_rate_and_native_meal_readback', numerator: matched.length, denominator: matched.length,
        } : null }];
      }
      return [base];
    }) };
  }
  return { schemaVersion: 'hms-native-catalogs/v1', propertyCode: property, capturedAt: time,
    source: { reader: source }, catalogs: normalized };
}

/** Preserve absence and invalid artifacts as explicit unavailable states. */
export async function loadHmsNativeCatalog({ path, propertyCode } = {}) {
  if (!path || !propertyCode) return { status: 'unavailable', issue: 'catalog_path_or_property_missing' };
  try {
    const catalog = JSON.parse(await readFile(path, 'utf8'));
    if (catalog?.schemaVersion !== 'hms-native-catalogs/v1' || catalog.propertyCode !== propertyCode ||
        !Number.isFinite(Date.parse(catalog.capturedAt)) || !catalog.catalogs || typeof catalog.catalogs !== 'object') {
      return { status: 'unavailable', issue: 'catalog_invalid' };
    }
    return { status: 'available', catalog };
  } catch (error) {
    return { status: 'unavailable', issue: ['ENOENT', 'EACCES', 'ENOTDIR'].includes(error?.code) ? 'catalog_files_unavailable' : 'catalog_invalid' };
  }
}
