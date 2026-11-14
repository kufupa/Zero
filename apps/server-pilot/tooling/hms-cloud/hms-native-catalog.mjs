import { readFile } from 'node:fs/promises';
import { getPropertyRegistration } from './property-registry.mjs';

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
export function validateRateMealReadback({ propertyCode, selection, form, observedAt = new Date().toISOString() } = {}) {
  if (selection?.outcome !== 'selected_unsaved' || selection.propertyCode !== propertyCode ||
      !['validated_row_and_existing_draft', 'validated_row_and_draft_change_response'].includes(selection.nativeCodeEvidence) ||
      form?.outcome !== 'ok' || !Array.isArray(form.fields) || !Number.isFinite(Date.parse(observedAt))) return null;
  const values = name => form.fields.filter(field => field.name === name).map(field => clean(field.value));
  const rates = values('rateplan'), meals = values('mealplan');
  const code = clean(selection.code);
  if (!code || rates.length !== 1 || rates[0] !== code || meals.length !== 1 || !meals[0]) return null;
  const changes = (Array.isArray(selection.changedFields) ? selection.changedFields : [])
    .filter(change => change?.before?.name === 'mealplan' && change?.after?.name === 'mealplan');
  const mealChange = changes.length === 1 && clean(changes[0].after.value) === meals[0]
    ? { before: clean(changes[0].before.value), after: meals[0] } : null;
  return { ratePlan: code, mealPlan: meals[0], propertyCode, observedAt: new Date(observedAt).toISOString(),
    arrivalDate: clean(selection.arrivalDate), departureDate: clean(selection.departureDate), mealChange,
    nativeCodeEvidence: selection.nativeCodeEvidence,
    basis: 'validated_unsaved_rate_and_native_meal_readback' };
}

/** Normalize private read results without promoting filtered or partial grids to whole catalogs. */
export function normalizeHmsNativeCatalog({ propertyCode, capturedAt, source, catalogs, commissionMapping, rateMealReadbacks = [],
  tenantId, landingPropertyCode, credentialRef, credentialVersionHmacSha256, sourceRevision, maxAgeMs, form, availabilityForm } = {}) {
  const property = clean(propertyCode)?.toUpperCase();
  if (!property || !Number.isFinite(Date.parse(capturedAt)) || !clean(source) || !catalogs || typeof catalogs !== 'object') {
    throw new TypeError('Catalog property, capture time, source and results are required.');
  }
  const time = new Date(capturedAt).toISOString();
  const normalized = {};
  for (const [kind, result] of Object.entries(catalogs)) {
    if (!Object.hasOwn(fields, kind) || !result || typeof result !== 'object') continue;
    const [idField, codeField, labelField] = fields[kind];
    const rows = Array.isArray(result.candidates) ? result.candidates : Array.isArray(result.options) ? result.options :
      Array.isArray(result.records) ? result.records : [];
    if (rows.some(row => [row?.property, row?.propertyCode].some(value => clean(value) && clean(value).toUpperCase() !== property))) {
      throw new TypeError('Catalog record property does not match the selected property.');
    }
    const coverage = result.coverage && typeof result.coverage === 'object' ? result.coverage : {};
    const loaded = coverage.loaded ?? result.reportedLoaded;
    const total = coverage.total ?? result.reportedTotal;
    const criteria = result.criteria && typeof result.criteria === 'object' ? result.criteria : {};
    const query = typeof criteria.query === 'string' ? criteria.query.trim() : null;
    const rateShopScope = kind === 'ratePlans' && criteria.scope !== 'property_master';
    const filtered = rateShopScope || (query === null ? !['unfiltered', 'property_master'].includes(criteria.scope) : query !== '') ||
      coverage.nativeFiltered === true;
    const complete = !filtered && (coverage.complete === true || result.complete === true) &&
      Number.isSafeInteger(loaded) && Number.isSafeInteger(total) && loaded >= 0 && total >= 0 &&
      rows.length === loaded && loaded === total;
    normalized[kind] = { status: result.outcome || 'unknown', scope: { kind: rateShopScope ? 'rate_shop' : filtered ? 'filtered_or_unknown' : 'unfiltered',
      query, wholeCatalogComplete: complete }, coverage: { ...coverage, loaded, total, complete }, records: rows.flatMap(row => {
      const nativeId = clean(row[idField] ?? (kind === 'roomTypes' ? row.roomtypeid : null));
      const code = clean(row[codeField] ?? (kind === 'roomTypes' ? row.roomtypecode : kind === 'ratePlans' ? row.rateplancode : null));
      const meaning = clean(row[labelField] ?? (kind === 'roomTypes' ? row.roomtypename : kind === 'ratePlans' ? row.rateplanname : null));
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
        const matched = rateMealReadbacks.filter(item => item?.propertyCode === property && item.ratePlan === code &&
          item.basis === 'validated_unsaved_rate_and_native_meal_readback' && clean(item.mealPlan) &&
          Number.isFinite(Date.parse(item.observedAt)));
        return [{ ...base, mealPlan: null, mealPlanEvidence: null,
          mealPlanObservations: matched.map(item => ({ ratePlan: code, mealPlan: clean(item.mealPlan), propertyCode: property,
            observedAt: new Date(item.observedAt).toISOString(), arrivalDate: clean(item.arrivalDate),
            departureDate: clean(item.departureDate), mealChange: item.mealChange && clean(item.mealChange.after) === clean(item.mealPlan)
              ? { before: clean(item.mealChange.before), after: clean(item.mealChange.after) } : null,
            nativeCodeEvidence: clean(item.nativeCodeEvidence), basis: item.basis, catalogMappingApplied: false })) }];
      }
      return [base];
    }) };
  }
  const registration = getPropertyRegistration(property);
  if (!registration?.active) throw new TypeError('Unknown catalog property.');
  function normalizeForm(raw, availability = false) {
    if (raw === undefined) return undefined;
    const formFields = raw?.fields ?? raw?.components;
    if (raw?.propertyCode !== property || !Array.isArray(formFields)) throw new TypeError('Form property and fields are required.');
    const selected = formFields.filter(field => field && typeof field.name === 'string' &&
      /^[a-z][a-z0-9]*$/.test(field.name) && (availability ? field.name === 'salesstrategy' :
        field.required === true || /^child[1-6]$/.test(field.name) || field.name === 'guaranteetype'));
    if (new Set(selected.map(field => field.name)).size !== selected.length) throw new TypeError('Duplicate form fields.');
    if (selected.some(field => typeof field.required !== 'boolean' || typeof field.visible !== 'boolean')) {
      throw new TypeError('Form required and visible observations are required.');
    }
    return { propertyCode: property, fields: selected.map(field => ({
      name: field.name, label: clean(field.label) ?? '', type: clean(field.xtype ?? field.type) ?? '',
      required: field.required === true, visible: field.visible === true,
      ...(field.name === 'guestoptin4' && typeof field.value === 'boolean' ? { value: field.value } : {}),
      ...(['guaranteetype', 'marketsegment', 'salesstrategy'].includes(field.name) ? { choices: (Array.isArray(field.rows) ? field.rows : []).flatMap(row => {
        const code = clean(row?.value), meaning = clean(row?.display);
        return code && meaning ? [{ code, meaning }] : [];
      }) } : {}),
    })) };
  }
  const normalizedForm = normalizeForm(form);
  const normalizedAvailabilityForm = normalizeForm(availabilityForm, true);
  const hasIdentity = tenantId !== undefined || landingPropertyCode !== undefined || credentialRef !== undefined ||
    credentialVersionHmacSha256 !== undefined || sourceRevision !== undefined || maxAgeMs !== undefined;
  if (!hasIdentity && property === 'HRCEN') return { schemaVersion: 'hms-native-catalogs/v1', propertyCode: property,
    capturedAt: time, source: { reader: source }, catalogs: normalized };
  if (tenantId !== registration.expectedTenant || landingPropertyCode !== registration.landingPropertyCode ||
      credentialRef !== registration.credentialSecretRef || typeof credentialVersionHmacSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(credentialVersionHmacSha256) || typeof sourceRevision !== 'string' ||
      !clean(sourceRevision) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new TypeError('Catalog property identity, credential binding, source revision and TTL are required.');
  }
  return { schemaVersion: 'hms-native-catalogs/v2', propertyCode: property, tenantId, landingPropertyCode,
    credentialRef, credentialVersionHmacSha256, sourceRevision, maxAgeMs, capturedAt: time,
    source: { reader: source }, catalogs: normalized, ...(normalizedForm ? { form: normalizedForm } : {}),
    ...(normalizedAvailabilityForm ? { availabilityForm: normalizedAvailabilityForm } : {}) };
}

/** Resolve catalog location and independent, deployment-supplied identity bindings. */
export function nativeCatalogReadOptions({ propertyCode, env = process.env } = {}) {
  const property = getPropertyRegistration(propertyCode);
  if (!property?.active) return { propertyCode };
  const suffix = propertyCode === 'HRCEN' ? '' : `_${propertyCode}`;
  return { propertyCode, path: env[`HMS_NATIVE_CATALOG_PATH${suffix}`],
    credentialVersionHmacSha256: env[`HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_${propertyCode}`],
    sourceRevision: env.NAVA_BUILD_COMMIT };
}

function validV2Contents(catalog) {
  for (const section of Object.values(catalog.catalogs)) {
    if (!section || typeof section !== 'object' || !Array.isArray(section.records) ||
        !section.coverage || typeof section.coverage !== 'object' || !section.scope || typeof section.scope !== 'object') return false;
    const { loaded, total, complete } = section.coverage;
    if (typeof complete !== 'boolean' || typeof section.scope.wholeCatalogComplete !== 'boolean' ||
        section.scope.wholeCatalogComplete !== complete) return false;
    if (loaded !== undefined && (!Number.isSafeInteger(loaded) || loaded < 0 || loaded !== section.records.length)) return false;
    if (total !== undefined && (!Number.isSafeInteger(total) || total < 0 || (loaded !== undefined && total < loaded))) return false;
    if (complete && (loaded === undefined || total !== loaded || section.scope.kind !== 'unfiltered')) return false;
    if (section.records.some(row => !row || row.propertyCode !== catalog.propertyCode ||
      row.capturedAt !== catalog.capturedAt || (row.code != null && typeof row.code !== 'string') ||
      (row.meaning != null && typeof row.meaning !== 'string'))) return false;
  }
  for (const form of [catalog.form, catalog.availabilityForm]) {
    if (form === undefined) continue;
    if (!form || form.propertyCode !== catalog.propertyCode || !Array.isArray(form.fields)) return false;
    const names = new Set();
    for (const field of form.fields) {
      if (!field || typeof field.name !== 'string' || !/^[a-z][a-z0-9]*$/.test(field.name) || names.has(field.name) ||
          typeof field.label !== 'string' || typeof field.type !== 'string' || typeof field.required !== 'boolean' ||
          typeof field.visible !== 'boolean' || (field.value !== undefined && (field.name !== 'guestoptin4' || typeof field.value !== 'boolean')) ||
          (field.choices !== undefined && (!['guaranteetype', 'marketsegment', 'salesstrategy'].includes(field.name) || !Array.isArray(field.choices) ||
            field.choices.some(choice => !clean(choice?.code) || !clean(choice?.meaning))))) return false;
      names.add(field.name);
    }
  }
  return true;
}

/** Preserve absence and invalid artifacts as explicit unavailable states. */
export async function loadHmsNativeCatalog({ path, propertyCode, tenantId, landingPropertyCode, credentialRef,
  credentialVersionHmacSha256, sourceRevision, now = new Date() } = {}) {
  const property = getPropertyRegistration(propertyCode);
  if (!path || !property?.active) return { status: 'unavailable', issue: 'catalog_path_or_property_missing' };
  try {
    const catalog = JSON.parse(await readFile(path, 'utf8'));
    const capture = Date.parse(catalog?.capturedAt), current = now.getTime();
    if (catalog?.propertyCode !== propertyCode || !Number.isFinite(capture) || !Number.isFinite(current) || capture > current ||
        !catalog.catalogs || typeof catalog.catalogs !== 'object' || Array.isArray(catalog.catalogs)) {
      return { status: 'unavailable', issue: 'catalog_invalid' };
    }
    if (catalog.schemaVersion === 'hms-native-catalogs/v1') {
      return propertyCode === 'HRCEN' ? { status: 'available', catalog } : { status: 'unavailable', issue: 'catalog_identity_unverified' };
    }
    if (catalog.schemaVersion !== 'hms-native-catalogs/v2' || catalog.tenantId !== property.expectedTenant ||
        catalog.landingPropertyCode !== property.landingPropertyCode || catalog.credentialRef !== property.credentialSecretRef ||
        (tenantId !== undefined && catalog.tenantId !== tenantId) ||
        (landingPropertyCode !== undefined && catalog.landingPropertyCode !== landingPropertyCode) ||
        (credentialRef !== undefined && catalog.credentialRef !== credentialRef) ||
        typeof catalog.credentialVersionHmacSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(catalog.credentialVersionHmacSha256) ||
        (propertyCode !== 'HRCEN' && (typeof credentialVersionHmacSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(credentialVersionHmacSha256) || typeof sourceRevision !== 'string' || !clean(sourceRevision))) ||
        (credentialVersionHmacSha256 !== undefined && catalog.credentialVersionHmacSha256 !== credentialVersionHmacSha256) ||
        typeof catalog.sourceRevision !== 'string' || !clean(catalog.sourceRevision) ||
        (sourceRevision !== undefined && catalog.sourceRevision !== sourceRevision) ||
        !Number.isSafeInteger(catalog.maxAgeMs) || catalog.maxAgeMs <= 0) {
      return { status: 'unavailable', issue: 'catalog_identity_unverified' };
    }
    if (!validV2Contents(catalog)) return { status: 'unavailable', issue: 'catalog_invalid' };
    if (capture + catalog.maxAgeMs <= current) return { status: 'unavailable', issue: 'catalog_stale' };
    return { status: 'available', catalog };
  } catch (error) {
    return { status: 'unavailable', issue: ['ENOENT', 'EACCES', 'ENOTDIR'].includes(error?.code) ? 'catalog_files_unavailable' : 'catalog_invalid' };
  }
}
