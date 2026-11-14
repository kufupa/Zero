import { getPropertyRegistration } from './property-registry.mjs';

export const HMS_PROPERTIES = Object.freeze(['HRCEN', 'HRDAV', 'HRDAVS']);
export const HMS_WORKFLOWS = Object.freeze(['reads', 'quote', 'create', 'amend', 'cancel', 'attach', 'addons', 'guest_profile_create']);
export const HMS_WRITE_WORKFLOWS = Object.freeze(['create', 'amend', 'cancel', 'attach', 'addons', 'guest_profile_create']);
export const DAVINCI_MODE_KEYS = Object.freeze({
  reads: 'HMS_DAVINCI_READS', quote: 'HMS_DAVINCI_MAKE_QUOTE', create: 'HMS_DAVINCI_CREATE',
  amend: 'HMS_DAVINCI_AMEND', cancel: 'HMS_DAVINCI_CANCEL', attach: 'HMS_DAVINCI_ATTACH',
  addons: 'HMS_DAVINCI_ADDONS', guest_profile_create: 'HMS_DAVINCI_GUEST_PROFILE_CREATE',
});
export const WRITER_DIGEST_KEYS = Object.freeze(Object.fromEntries(HMS_WRITE_WORKFLOWS.map(workflow =>
  [workflow, `HMS_WRITER_DEPENDENCY_DIGEST_${workflow.toUpperCase()}`])));
export const WRITER_CREDENTIAL_IDENTITY_KEYS = Object.freeze(Object.fromEntries(HMS_PROPERTIES.map(property =>
  [property, `HMS_WRITER_CREDENTIAL_IDENTITY_${property}`])));

export const RUNTIME_PATH_KEYS = Object.freeze([
  'HMS_MEMORY_PMS_PATH', 'HMS_MEMORY_OUTBOUND_PATH', 'HMS_MEMORY_DATA_DIR', 'HMS_MEMORY_OBSERVATIONS_PATH',
  'HMS_NATIVE_CATALOG_PATH', 'HMS_NATIVE_CATALOG_PATH_HRCEN', 'HMS_NATIVE_CATALOG_PATH_HRDAV', 'HMS_NATIVE_CATALOG_PATH_HRDAVS',
  'PARTY_INDEX_PATH', 'PARTY_INDEX_PATH_HRCEN', 'PARTY_INDEX_PATH_HRDAV', 'PARTY_INDEX_PATH_HRDAVS',
  'HMS_READ_ROLE_PROOF_PATH', 'HMS_READ_ROLE_PROOF_V2_PATH', 'HMS_READ_ROLE_PROOF_V2_ROOT',
  'HMS_ACTIVE_REGISTRY_PATH', 'HMS_RELEASE_ROOT',
  'HMS_BROWSER_ARTIFACT_ROOT', 'HMS_HEALTH_STATUS_PATH', 'HMS_CANARY_PROOF_PATH', 'HMS_SHADOW_PROOF_PATH',
  'NAVA_WORKFLOW_REPRO_DIR', 'NAVA_CANARY_PASS_FILE',
]);
const WRITE_MODE_KEYS = Object.freeze([
  'PANE_WRITE_CREATE', 'PANE_WRITE_AMEND', 'PANE_WRITE_AMEND_UNPAID', 'PANE_WRITE_AMEND_PAID',
  'PANE_WRITE_CANCEL_UNPAID', 'PANE_WRITE_CANCEL_PAID', 'PANE_WRITE_ADDONS', 'PANE_WRITE_ATTACH',
  ...HMS_WRITE_WORKFLOWS.map(workflow => DAVINCI_MODE_KEYS[workflow]),
]);
const SWITCH_KEYS = Object.freeze([
  'PANE_HMS_LAB_CREATE_WORKER', 'PANE_HMS_LAB_AMEND_WORKER', 'PANE_HMS_LAB_ATTACH_WORKER',
  'PANE_CLOUD_CREATE_DISPATCH', DAVINCI_MODE_KEYS.reads, DAVINCI_MODE_KEYS.quote,
]);
export const SCOPED_RUNTIME_CONTROL_KEYS = Object.freeze([
  ...WRITE_MODE_KEYS, ...SWITCH_KEYS, 'HMS_DAVINCI_ENABLED_PROPERTIES',
  'HMS_EXPECTED_PROPERTY_CODE', 'HMS_EXPECTED_TENANT', 'HMS_EXPECTED_TRANSPORT_ID', ...RUNTIME_PATH_KEYS,
  ...Object.values(WRITER_DIGEST_KEYS), ...Object.values(WRITER_CREDENTIAL_IDENTITY_KEYS),
]);

export function parseDavinciEnabledProperties(value) {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string') throw new Error('hms_enabled_properties_invalid');
  const properties = value.split(',');
  if (properties.some(property => !['HRDAV', 'HRDAVS'].includes(property)) || new Set(properties).size !== properties.length) {
    throw new Error('hms_enabled_properties_invalid');
  }
  return properties;
}

/** Shared validation for durable, remote and scoped runtime controls. */
export function validateRuntimeControl(key, value) {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string') throw new Error('hms_runtime_control_invalid');
  if (WRITE_MODE_KEYS.includes(key) && !['off', 'lab', 'on'].includes(value)) throw new Error('hms_runtime_control_invalid');
  if (SWITCH_KEYS.includes(key) && !['off', 'on'].includes(value)) throw new Error('hms_runtime_control_invalid');
  if (key === 'HMS_DAVINCI_ENABLED_PROPERTIES') parseDavinciEnabledProperties(value);
  if (RUNTIME_PATH_KEYS.includes(key) && (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.split('/').some(part => part === '.' || part === '..'))) {
    throw new Error('hms_runtime_control_invalid');
  }
  if (Object.values(WRITER_DIGEST_KEYS).includes(key) && !/^[a-f0-9]{64}$/.test(value)) throw new Error('hms_runtime_control_invalid');
  if (Object.values(WRITER_CREDENTIAL_IDENTITY_KEYS).includes(key) && !/^[A-Za-z0-9_./:+-]+$/.test(value)) throw new Error('hms_runtime_control_invalid');
  if (key === 'HMS_EXPECTED_PROPERTY_CODE' && !HMS_PROPERTIES.includes(value)) throw new Error('hms_runtime_control_invalid');
  if (key === 'HMS_EXPECTED_TENANT' && !/^[A-Z][A-Z0-9_]+$/.test(value)) throw new Error('hms_runtime_control_invalid');
  if (key === 'HMS_EXPECTED_TRANSPORT_ID' && !/^transport-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error('hms_runtime_control_invalid');
}

const mode = value => ['lab', 'on'].includes(value) ? value : 'off';
const maxMode = (...values) => values.includes('on') ? 'on' : values.includes('lab') ? 'lab' : 'off';
function centurionMode(env, workflow) {
  const paneKeys = ['PANE_WRITE_CREATE', 'PANE_WRITE_AMEND_UNPAID', 'PANE_WRITE_AMEND_PAID', 'PANE_WRITE_CANCEL_UNPAID', 'PANE_WRITE_CANCEL_PAID'];
  const legacy = paneKeys.some(key => env[key] !== undefined) ? 'off' : mode(env.RESERVATIONIST_PANE_SAVE);
  switch (workflow) {
    case 'create': return env.PANE_WRITE_CREATE !== undefined ? mode(env.PANE_WRITE_CREATE) : legacy;
    case 'amend': return maxMode(mode(env.PANE_WRITE_AMEND), mode(env.PANE_WRITE_AMEND_UNPAID), mode(env.PANE_WRITE_AMEND_PAID), legacy === 'lab' ? 'lab' : 'off');
    case 'cancel': return maxMode(mode(env.PANE_WRITE_CANCEL_UNPAID), mode(env.PANE_WRITE_CANCEL_PAID), legacy);
    case 'attach': return env.PANE_WRITE_ATTACH !== undefined ? mode(env.PANE_WRITE_ATTACH) : env.RESERVATIONIST_PANE_SAVE === 'lab' ? 'lab' : 'off';
    case 'addons': return mode(env.PANE_WRITE_ADDONS);
    case 'guest_profile_create': return centurionCreateDispatchMode(env);
    default: return 'off';
  }
}

function centurionCreateDispatchMode(env) {
  if (env.PANE_CLOUD_CREATE_DISPATCH !== 'on') return 'off';
  const createMode = centurionMode(env, 'create');
  if (createMode === 'on' && env.PANE_WRITE_CREATE !== 'on') return 'lab';
  return createMode;
}

// These workflows have an existing read-only lookup or unsaved check in HRCEN.
function centurionWriteCapability(env, workflow, configuredMode) {
  if (workflow === 'amend' && env.PANE_STAY_LOOKUP === 'off') return 'unavailable';
  let admittedMode = configuredMode;
  if (workflow === 'create' || workflow === 'guest_profile_create') admittedMode = centurionCreateDispatchMode(env);
  else if (workflow === 'amend') admittedMode = env.PANE_HMS_LAB_AMEND_WORKER === 'on' ? mode(env.PANE_WRITE_AMEND) : 'off';
  else if (workflow === 'attach') admittedMode = env.PANE_HMS_LAB_ATTACH_WORKER === 'on' ? mode(env.PANE_WRITE_ATTACH) : 'off';
  else if (workflow === 'addons') admittedMode = maxMode(configuredMode, centurionCreateDispatchMode(env));
  return admittedMode === 'on' ? 'staff-enabled' : admittedMode === 'lab' ? 'lab' : 'prepare-only';
}

/** Modes describe configured scope; capabilities never make an unproven DaVinci writer available. */
export function effectiveWorkflowPolicy(env, property, workflow) {
  if (!HMS_PROPERTIES.includes(property) || !HMS_WORKFLOWS.includes(workflow)) throw new Error('hms_workflow_scope_invalid');
  const enabled = property === 'HRCEN' || parseDavinciEnabledProperties(env.HMS_DAVINCI_ENABLED_PROPERTIES).includes(property);
  const readEnabled = enabled && (property === 'HRCEN' || env.HMS_DAVINCI_READS === 'on');
  let configuredMode = 'off';
  if (enabled) {
    if (workflow === 'reads') configuredMode = readEnabled ? 'on' : 'off';
    else if (workflow === 'quote') configuredMode = property === 'HRCEN' || env.HMS_DAVINCI_MAKE_QUOTE === 'on' ? 'on' : 'off';
    else configuredMode = property === 'HRCEN' ? centurionMode(env, workflow) : mode(env[DAVINCI_MODE_KEYS[workflow]]);
  }
  let capability = 'unavailable';
  if (workflow === 'reads' || workflow === 'quote') capability = configuredMode === 'on' ? 'staff-enabled' : 'unavailable';
  else if (property === 'HRCEN') capability = centurionWriteCapability(env, workflow, configuredMode);
  const registration = getPropertyRegistration(property);
  const credentialIdentity = (HMS_WRITE_WORKFLOWS.includes(workflow) && env[WRITER_CREDENTIAL_IDENTITY_KEYS[property]]) || registration.credentialSecretRef;
  if (credentialIdentity !== registration.credentialSecretRef && capability !== 'unavailable') {
    capability = property === 'HRCEN' ? 'prepare-only' : 'unavailable';
  }
  return {
    property, workflow, mode: configuredMode, readEnabled, capability,
    credentialIdentity,
    writerDependencyDigest: WRITER_DIGEST_KEYS[workflow] ? env[WRITER_DIGEST_KEYS[workflow]] || null : null,
  };
}
