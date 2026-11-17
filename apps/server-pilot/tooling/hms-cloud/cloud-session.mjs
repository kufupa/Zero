// Each Cloud read owns its browser and starts on the authenticated landing property.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import postgres from 'postgres';
import { readFileSync, readlinkSync, lstatSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { consumePageRequestAuthorization, hasPageRequestAuthorization } from './page-request-fence.mjs';
import { openGuestStayScreen } from './open-guest-stay.mjs';
import { PROPERTY_REGISTRY, getPropertyRegistration, validateHmsPropertySecret } from './property-registry.mjs';
import { credentialVersionHmacSha256 } from './credential-version.mjs';
import { isReviewedAvailabilityInquiry, isReviewedGuestStayRatePlanInquiry, isReviewedSavedRateShopRefresh, isReviewedBlankRateShopRefresh,
  rejectDuplicateAvailabilityJsonKeys } from './quote-availability-policy.mjs';

const readPosts = new Set([
  '/web/base/BSSTRT', '/web/base/BSSTRT.HDR', '/web/base/OSRESS', '/web/base/OSRESS.search',
  '/web/base/OSRESV', '/web/base/OSRESV.LST', '/web/base/OSRESV.HDR', '/web/base/OSRESV.xmlhttp',
  '/web/base/OSRESV.GDT', '/web/base/OSRESV.GST', '/web/base/OSRESV.NOT', '/web/base/OSRESV.REM',
  '/web/base/OSRESV.FOL', '/web/base/OSRESV.FOL.xmlhttp', '/web/base/OSRESV.RAN',
  '/web/base/OSRESV.DOC', '/web/base/OSRESV.DOC.xmlhttp', '/web/base/OSRESV.NTE',
  '/web/base/OSRESV.MSG', '/web/base/OSRESV.HDR.getChildAges', '/web/base/LOVPOP',
  '/web/base/GRIDDATA', '/web/base/GETCACHE', '/web/base/BSMSLV', '/web/base/OSRASD',
  '/web/base/OSMPAV', '/web/base/OSMPAV.HDR', '/web/base/FSGSPF', '/web/base/FSGSPF.HDR',
  '/web/base/FSGSPF.LST', '/web/base/FSGSPF.xmlhttp', '/web/jsp/7iosress_getstaydata.jsp',
  '/api/internalBooking/rateshop/inquiryForGrid', '/api/internalBooking/hotelAvail/inquiryForGrid',
]);
const forbiddenPath = /(?:save|delete|update|upload|cancel|duplicate|checkin|checkout|postcharge|sendemail|rateSelection|getcheckavailability|rateplanchange|changeguaranteemethod|hmsvault|payments)/i;
const forbiddenAction = /^(?:save|delete|update|cancel|duplicate|checkin|checkout|insert|commit|create|submit|post|amend|book|confirm|upload|send|autosave)/i;
const writeFlags = /^(?:newprofileclick|confirmnewguestprofile|confirminactiveguestprofile|createinactiveprofileflag|linkprofileflag|savecctoprofile|savesettlementcctoprofile)$/i;
const actionKey = /^(?:pageaction|action|autosave)$/i;
const headerFields = new Set(['system_function_name', 'user_function_name', 'current_tab_name',
  'confirmationnumber', 'reservationstayid', 'propertycode', 'guestfullname', 'account', 'guestid',
  'hoteldate', 'lastname', 'firstname', 'twitterid', 'facebookid', 'tripadvisorid', 'bookingdotcomid',
  'room', 'menu_module_key', 'removescreenflows', 'only_data_required', 'scrollrow']);
const sessionState = new WeakMap();
const credentialLeases = new WeakMap();
const credentialPriority = new AsyncLocalStorage();
const credentialScope = new AsyncLocalStorage();
const credentialRun = new AsyncLocalStorage();
const retainedLeases = new Set();
const ownedWriterPages = new WeakMap();
const closedWriters = new Set();

/** Target holds share the old Centurion directory and survive process restarts. */
export function cloudHoldPath(propertyCode, alias, home = homedir()) {
  const property = registeredProperty(propertyCode);
  let parts;
  try { parts = JSON.parse(alias); } catch { throw new Error('HMS_BROWSER_TARGET_INVALID'); }
  const partitioned = propertyCode !== 'HRCEN';
  const size = partitioned ? 1 : 0;
  const name = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4608 &&
    !/[\p{Cc}]/u.test(value) && value === value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const valid = Array.isArray(parts) && parts[0] === propertyCode && JSON.stringify(parts) === alias && (
    (parts[1] === 'create' && parts.length === 5 + size && name(parts[2]) && name(parts[3]) &&
      /^\d{4}-\d{2}-\d{2}$/.test(parts[4]) && (!partitioned || parts[5] === property.expectedTenant)) ||
    (parts[1] === 'saved' && parts.length === 3 + size && /^(?:0|[1-9]\d{0,29})-(?:0|[1-9]\d{0,9})$/.test(parts[2]) &&
      (!partitioned || parts[3] === property.expectedTenant)) ||
    (parts[1] === 'saved_native' && parts.length === 3 + size && /^(?:0|[1-9]\d{0,99})$/.test(parts[2]) &&
      (!partitioned || parts[3] === property.expectedTenant)) ||
    (parts[1] === 'guest_profile' && parts.length === 5 && name(parts[2]) && name(parts[3]) && parts[4] === property.expectedTenant) ||
    (parts[1] === 'guest_profile_email' && parts.length === 4 && name(parts[2]) &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parts[2]) && parts[3] === property.expectedTenant));
  if (!valid) throw new Error('HMS_BROWSER_TARGET_INVALID');
  const directory = cloudPrivateDirectory(home);
  return join(directory, `${propertyCode.toLowerCase()}-browser-hold-${createHash('sha256').update(alias).digest('hex')}`);
}

function cloudPrivateDirectory(home = homedir()) {
  const uid = process.getuid();
  const safe = (path, mask) => {
    const stat = lstatSync(path);
    return stat.isDirectory() && stat.uid === uid && !(stat.mode & mask);
  };
  if (!safe(home, 0o022)) throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE');
  const directory = join(home, '.nava-hms-runtime');
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE'); }
  if (!safe(directory, 0o077)) throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE');
  return directory;
}

function assertNoCenturionBrowserHold() {
  try { lstatSync(join(cloudPrivateDirectory(), 'hrcen-browser-hold')); }
  catch (error) { if (error?.code === 'ENOENT') return; throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE'); }
  throw new Error('HMS_BROWSER_HOLD');
}

function credentialWriterHoldPath(propertyCode) {
  return join(cloudPrivateDirectory(), `credential-browser-hold-${cloudCredentialLeaseKey(propertyCode)}`);
}

function readCredentialWriterHold(propertyCode) {
  const path = credentialWriterHoldPath(propertyCode);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw new Error('HMS_CREDENTIAL_BROWSER_HOLD_UNAVAILABLE'); }
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4096) {
    throw new Error('HMS_CREDENTIAL_BROWSER_HOLD_UNAVAILABLE');
  }
  let hold;
  try { hold = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('HMS_CREDENTIAL_BROWSER_HOLD_UNAVAILABLE'); }
  if (hold.version !== 2 || hold.credentialKey !== cloudCredentialLeaseKey(propertyCode) ||
      registeredProperty(hold.propertyCode).credentialSecretRef !== registeredProperty(propertyCode).credentialSecretRef) {
    throw new Error('HMS_CREDENTIAL_BROWSER_HOLD_UNAVAILABLE');
  }
  return hold;
}

async function assertCredentialWriterQuiesced(propertyCode) {
  const hold = readCredentialWriterHold(propertyCode);
  if (!hold) return;
  if (!cloudWriterQuiesced(hold.identity)) {
    const identity = hold.identity;
    try {
      const host = hostIdentity();
      let nodeGone = false;
      try { nodeGone = processIdentity(identity.node.pid).started !== identity.node.started; }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error?.code)) nodeGone = true; }
      const browser = processIdentity(identity.browser.pid, true);
      if (nodeGone && identity.host === host.host && identity.bootId === host.bootId &&
          identity.pidNamespace === host.pidNamespace && browser.started === identity.browser.started) {
        process.kill(-identity.browser.pid, 'SIGKILL');
        await delay(250);
      }
    } catch { /* A live or unidentifiable owner remains held. */ }
  }
  if (!cloudWriterQuiesced(hold.identity)) throw new Error('HMS_CREDENTIAL_BROWSER_HELD');
  unlinkSync(credentialWriterHoldPath(propertyCode));
}

function holdCredentialWriter(propertyCode, identity) {
  writeFileSync(credentialWriterHoldPath(propertyCode), JSON.stringify({ version: 2, propertyCode,
    credentialKey: cloudCredentialLeaseKey(propertyCode), identity }) + '\n', { flag: 'wx', mode: 0o600 });
}

function releaseCredentialWriter(propertyCode, identity) {
  const hold = readCredentialWriterHold(propertyCode);
  if (!hold || writerKey(hold.identity) !== writerKey(identity) || !cloudWriterQuiesced(identity)) {
    throw new Error('HMS_CREDENTIAL_BROWSER_HOLD_UNAVAILABLE');
  }
  unlinkSync(credentialWriterHoldPath(propertyCode));
}

export function assertNoCloudHold(propertyCode, alias) {
  if (propertyCode === 'HRCEN') assertNoCenturionBrowserHold();
  const path = cloudHoldPath(propertyCode, alias);
  try { lstatSync(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE');
  }
  throw new Error('HMS_BROWSER_HOLD');
}

function reconcileCloudBrowserHold(propertyCode, alias, lease) {
  const state = credentialLeases.get(lease);
  if (!state || state.released || state.ref !== registeredProperty(propertyCode).credentialSecretRef || lease.signal.aborted) {
    throw new Error('HMS_CREDENTIAL_LEASE_INVALID');
  }
  const path = cloudHoldPath(propertyCode, alias);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error?.code === 'ENOENT') return; throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE'); }
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4096) {
    throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE');
  }
  let hold;
  try { hold = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE'); }
  if (hold.version !== 2 || hold.propertyCode !== propertyCode || hold.alias !== alias || !cloudWriterQuiesced(hold.identity)) {
    throw new Error('HMS_BROWSER_HOLD');
  }
  unlinkSync(path);
}

function holdCloudWriter(propertyCode, alias, identity) {
  const path = cloudHoldPath(propertyCode, alias);
  try { writeFileSync(path, JSON.stringify({ version: 2, propertyCode, alias, identity }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE'); }
}

function processIdentity(pid, group = false) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? '') || (group && (Number(fields[2]) !== pid || Number(fields[3]) !== pid))) {
    throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
  }
  return { pid, started: fields[19] };
}

function hostIdentity() {
  const machine = readFileSync('/etc/machine-id', 'utf8').trim();
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const pidNamespace = readlinkSync('/proc/self/ns/pid');
  if (!/^[a-f0-9]{32}$/i.test(machine) || !/^[a-f0-9-]{36}$/i.test(bootId) || !/^pid:\[\d+\]$/.test(pidNamespace)) {
    throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
  }
  return { host: createHash('sha256').update(machine).update('\0').update(hostname()).digest('hex'), bootId, pidNamespace };
}

function writerKey(identity) { return JSON.stringify(identity); }

async function waitForOwnedWriterGroupGone(identity) {
  const deadline = performance.now() + 5000;
  for (;;) {
    const host = hostIdentity(), node = processIdentity(process.pid);
    if (identity.host !== host.host || identity.bootId !== host.bootId || identity.pidNamespace !== host.pidNamespace ||
        identity.node.pid !== node.pid || identity.node.started !== node.started) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
    try {
      const browser = processIdentity(identity.browser.pid, true);
      if (browser.started !== identity.browser.started) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error?.code)) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
    }
    try { process.kill(-identity.browser.pid, 0); }
    catch (error) {
      if (error?.code === 'ESRCH') return true;
      throw new Error('HMS_SESSION_CLEANUP_FAILED');
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(50, remaining));
  }
}

export function cloudWriterIdentity(page) {
  const identity = ownedWriterPages.get(page);
  return identity && cloudWriterCurrent(identity) ? structuredClone(identity) : null;
}

export function cloudSessionIdentity(page) {
  const state = sessionState.get(page?.context?.());
  return state?.verified && state.ownedPage === page && state.identity ? { ...state.identity } : null;
}

/** Carry a verified saved-form read through the outer guard without admitting a write. */
export async function withCloudSavedRateReadScope(page, frame, saved, operation) {
  const state = sessionState.get(page?.context?.());
  if (!state?.verified || state.ownedPage !== page || frame?.page?.() !== page ||
      !saved || saved.propertyCode !== state.identity?.propertyCode ||
      !/^\d+-\d+$/.test(saved.confirmation || '') ||
      ['reservationStayId', 'reservationId', 'recordId', 'guestId'].some(key => !/^\d{1,100}$/.test(saved[key] || '')) ||
      typeof saved.bookingSessionId !== 'string' || !saved.bookingSessionId.trim() ||
      saved.bookingSessionId.length > 1024 || /[\p{Cc}]/u.test(saved.bookingSessionId) ||
      typeof operation !== 'function' || state.savedRateReadScope) {
    throw new Error('SAVED_RATE_READ_SCOPE_INVALID');
  }
  const scope = Object.freeze({ frame, propertyCode: saved.propertyCode, confirmation: saved.confirmation,
    reservationStayId: saved.reservationStayId, reservationId: saved.reservationId, recordId: saved.recordId,
    guestId: saved.guestId, bookingSessionId: saved.bookingSessionId });
  state.savedRateReadScope = scope;
  try { return await operation(); }
  finally { if (state.savedRateReadScope === scope) state.savedRateReadScope = null; }
}

/** Bind the blank Rate Shop refresh to the verified, unsaved native form and page fence. */
export async function withCloudBlankRateReadScope(page, operation) {
  const state = sessionState.get(page?.context?.());
  if (!state?.verified || state.ownedPage !== page || state.blankRateReadScope ||
      state.savedRateReadScope || typeof operation !== 'function') throw new Error('BLANK_RATE_READ_SCOPE_INVALID');
  if (state.writer) return operation();
  const propertyCode = state.identity?.propertyCode;
  const blank = await page.evaluate(propertyCode => {
    const visible = el => Boolean(el.offsetWidth || el.offsetHeight) && !el.closest('.x-window');
    const confirmations = [...document.querySelectorAll('input[name="confirmationnumber"]')].filter(visible);
    const properties = [...document.querySelectorAll('[data-qtip="Property"]')].filter(visible);
    const confirmation = confirmations[0];
    const record = confirmation && globalThis.Ext?.getCmp?.(confirmation.id.replace(/-inputEl$/, ''))?.up?.('form')?.getRecord?.()?.data;
    if (confirmations.length !== 1 || confirmation.value !== '' || properties.length !== 1 ||
        properties[0].textContent.trim().toUpperCase() !== propertyCode || !record ||
        ['confirmationnumber', 'reservationstayid', 'reservationid', 'recordid', 'guestid'].some(name => String(record[name] ?? '') !== '')) return null;
    return { propertyCode, confirmation: '', reservationStayId: '', reservationId: '', recordId: '', guestId: '',
      bookingSessionId: String(record.bookingsessionid ?? '') };
  }, propertyCode);
  if (!blank || blank.bookingSessionId.length > 1024 || /[\p{Cc}]/u.test(blank.bookingSessionId)) {
    throw new Error('BLANK_RATE_READ_SCOPE_INVALID');
  }
  const scope = Object.freeze({ ...blank, frame: page.mainFrame() });
  state.blankRateReadScope = scope;
  try { return await operation(); }
  finally { if (state.blankRateReadScope === scope) state.blankRateReadScope = null; }
}

export function cloudWriterCurrent(identity) {
  try {
    const host = hostIdentity(), node = processIdentity(process.pid), browser = processIdentity(identity?.browser?.pid, true);
    return identity.host === host.host && identity.bootId === host.bootId && identity.pidNamespace === host.pidNamespace &&
      identity.node?.pid === node.pid && identity.node.started === node.started && identity.browser.started === browser.started;
  } catch { return false; }
}

export function cloudWriterQuiesced(identity) {
  try {
    const host = hostIdentity();
    if (!identity || identity.host !== host.host || !/^[a-f0-9-]{36}$/i.test(identity.bootId ?? '') ||
        !Number.isSafeInteger(identity.node?.pid) || !Number.isSafeInteger(identity.browser?.pid) ||
        identity.node.pid < 2 || identity.browser.pid < 2 || identity.node.pid === identity.browser.pid ||
        !/^\d+$/.test(identity.node.started ?? '') || !/^\d+$/.test(identity.browser.started ?? '')) return false;
    if (identity.bootId !== host.bootId) return true;
    if (identity.pidNamespace !== host.pidNamespace) return false;
    try { process.kill(-identity.browser.pid, 0); return false; }
    catch (error) { if (error?.code !== 'ESRCH') return false; }
    if (closedWriters.has(writerKey(identity))) return true;
    try { if (processIdentity(identity.node.pid).started === identity.node.started) return false; }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error?.code)) return false; }
    return true;
  } catch { return false; }
}

function registeredProperty(code) {
  const property = typeof code === 'string' ? getPropertyRegistration(code) : null;
  if (!property?.active) throw new Error('HMS_PROPERTY_REQUIRED');
  return property;
}

function validateSecret(property, raw, transportId) {
  const secret = raw && typeof raw === 'object' && !Array.isArray(raw) && 'secret' in raw ? raw.secret : raw;
  const landing = registeredProperty(property.landingPropertyCode);
  if (!secret || typeof secret !== 'object' || Array.isArray(secret)) throw new Error('HMS_CREDENTIALS_INVALID');
  for (const key of ['loginUrl', 'username', 'password', 'expectedTenant', 'expectedPropertyCode', 'expectedPropertyName']) {
    if (typeof secret[key] !== 'string' || !secret[key]) throw new Error('HMS_CREDENTIALS_INVALID');
  }
  validateHmsPropertySecret(transportId === undefined ? landing : { ...landing, transportId }, secret);
  let url;
  try { url = new URL(secret.loginUrl); } catch { throw new Error('HMS_TARGET_MISMATCH'); }
  if (url.origin !== property.origin || url.username || url.password || url.hash ||
      url.pathname !== '/web/base/logindisp' || url.searchParams.getAll('tenant').length !== 1 ||
      url.searchParams.get('tenant') !== property.expectedTenant || landing.group !== property.group ||
      landing.expectedTenant !== property.expectedTenant || landing.origin !== property.origin) {
    throw new Error('HMS_TARGET_MISMATCH');
  }
  return secret;
}

async function loadCloudSecret({ secretArn, signal }) {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'af-south-1' });
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn, VersionStage: 'AWSCURRENT' }), { abortSignal: signal });
    if (!result.SecretString) throw new Error('empty');
    return { secret: JSON.parse(result.SecretString), versionId: result.VersionId, versionStages: result.VersionStages };
  } catch {
    signal?.throwIfAborted();
    throw new Error('HMS_CREDENTIALS_UNAVAILABLE');
  } finally { client.destroy(); }
}

async function loadCloudEvidenceKey({ secretArn, keyVersion, signal }) {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'af-south-1' });
  let result;
  try {
    result = await client.send(new GetSecretValueCommand({ SecretId: secretArn, VersionStage: 'AWSCURRENT' }), { abortSignal: signal });
  } catch {
    signal?.throwIfAborted();
    throw new Error('HMS_EVIDENCE_KEY_UNAVAILABLE');
  } finally { client.destroy(); }
  if (typeof result.VersionId !== 'string' || result.VersionId.trim() !== keyVersion ||
      !Array.isArray(result.VersionStages) || !result.VersionStages.includes('AWSCURRENT')) {
    throw new Error('HMS_EVIDENCE_KEY_VERSION_MISMATCH');
  }
  const encoded = typeof result.SecretString === 'string' ? result.SecretString.trim() : '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('HMS_EVIDENCE_KEY_INVALID');
  const key = Buffer.from(encoded, 'base64');
  if (key.byteLength < 32 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    key.fill(0);
    throw new Error('HMS_EVIDENCE_KEY_INVALID');
  }
  return key;
}

/** Bind authenticated reads and every writer to freshly fetched credential metadata. */
export async function verifyCloudCredentialVersion({ propertyCode, transportId, loadedSecret, signal, requireBoundVersion = false, allowUnboundVersion = false } = {}) {
  const property = registeredProperty(propertyCode);
  const expected = process.env[`HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_${propertyCode}`];
  // A leased, uncached read may opt out only when no catalog binding is configured.
  if (!requireBoundVersion && allowUnboundVersion && !expected) return null;
  if (!requireBoundVersion && !allowUnboundVersion && (transportId === undefined || property.group === 'centurion' && !expected)) return null;
  if (typeof transportId !== 'string' || !property.transportIds.includes(transportId)) throw new Error('HMS_SESSION_OPTIONS_INVALID');
  const versionId = typeof loadedSecret?.versionId === 'string' ? loadedSecret.versionId.trim() : '';
  if (!versionId) throw new Error('HMS_CREDENTIAL_VERSION_MISSING');
  if (!Array.isArray(loadedSecret.versionStages) || !loadedSecret.versionStages.length) throw new Error('HMS_CREDENTIAL_VERSION_STAGES_MISSING');
  if (!loadedSecret.versionStages.includes('AWSCURRENT')) throw new Error('HMS_CREDENTIAL_VERSION_STALE');
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('HMS_CREDENTIAL_VERSION_DIGEST_MISSING');
  const secretArn = process.env.HMS_EVIDENCE_HMAC_SECRET_ARN?.trim();
  const keyVersion = process.env.HMS_EVIDENCE_HMAC_KEY_VERSION?.trim();
  if (!secretArn || !keyVersion) throw new Error('HMS_EVIDENCE_KEY_METADATA_MISSING');
  const key = await loadCloudEvidenceKey({ secretArn, keyVersion, signal });
  try {
    signal?.throwIfAborted();
    const actual = credentialVersionHmacSha256({ evidenceKey: key, evidenceKeyVersion: keyVersion,
      hmsSecretArn: property.credentialSecretRef, hmsSecretVersionId: versionId });
    if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('HMS_CREDENTIAL_VERSION_MISMATCH');
    return actual;
  } finally { key.fill(0); }
}

function decoded(value) {
  let result = String(value ?? '');
  for (let i = 0; i < 3; i += 1) {
    try { const next = decodeURIComponent(result.replace(/\+/g, ' ')); if (next === result) break; result = next; }
    catch { break; }
  }
  return result;
}

function hasWriteIntent(value) {
  const text = decoded(value);
  if (/(?:[?&;{,\s]|^)["']?(?:pageaction|action|autosave)["']?\s*(?:=|:)\s*["']?\s*(?:save|delete|update|cancel|duplicate|checkin|checkout|insert|commit|create|submit|post|amend|book|confirm|upload|send)/i.test(text)) return true;
  const visit = (data) => data && typeof data === 'object' && Object.entries(data).some(([key, entry]) =>
    (actionKey.test(key) && forbiddenAction.test(String(entry).trim())) ||
    (writeFlags.test(key) && !['', '0', 'false', '-'].includes(String(entry).trim().toLowerCase())) || visit(entry));
  try { if (visit(JSON.parse(text))) return true; } catch { /* Form payloads are handled below. */ }
  for (const [key, entry] of new URLSearchParams(text)) {
    if ((actionKey.test(key) && forbiddenAction.test(entry.trim())) ||
        (writeFlags.test(key) && !['', '0', 'false', '-'].includes(entry.trim().toLowerCase()))) return true;
  }
  return false;
}

function safeHeaderRead(url, body, propertyCode) {
  if (url.search) return false;
  const entries = [...new URLSearchParams(body)];
  const keys = entries.map(([key]) => key.toLowerCase());
  if (new Set(keys).size !== keys.length || keys.some((key) => !headerFields.has(key))) return false;
  const fields = new Map(entries.map(([key, value]) => [key.toLowerCase(), value]));
  if (fields.get('system_function_name') !== 'OSRESV' || fields.get('user_function_name') !== 'OSRESV' ||
      fields.get('current_tab_name') !== 'HDR' ||
      (fields.get('propertycode') && fields.get('propertycode') !== propertyCode)) return false;
  const blank = ['confirmationnumber', 'reservationstayid', 'guestid', 'guestfullname', 'account', 'firstname', 'lastname']
    .every((key) => !fields.get(key));
  return blank || Boolean(fields.get('confirmationnumber') && fields.get('propertycode'));
}

export async function installCloudReadGuard(context, property, state) {
  if (typeof context.routeWebSocket !== 'function') throw new Error('HMS_SOCKET_GUARD_UNAVAILABLE');
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    let url;
    try { url = new URL(request.url()); } catch { return route.abort(); }
    const body = request.postData() ?? '';
    const path = decoded(url.pathname);
    if (state.writer && state.verified && state.ownedPage && url.origin === property.origin &&
        ['GET', 'POST'].includes(method) && !url.username && !url.password &&
        consumePageRequestAuthorization(request, state.ownedPage)) {
      try { if (request.frame().page() !== state.ownedPage) return route.abort(); }
      catch { return route.abort(); }
      return route.fallback();
    }
    let savedScope = null;
    if (path === '/api/internalBooking/rateshop/inquiryForGrid' || path === '/web/base/OSRASD.RatePlanChange') {
      try {
        if (state.verified && !state.writer && state.ownedPage && state.savedRateReadScope &&
            request.frame() === state.savedRateReadScope.frame && hasPageRequestAuthorization(request, state.ownedPage)) {
          savedScope = state.savedRateReadScope;
        }
      } catch { return route.abort(); }
    }
    let savedRefresh = false;
    let blankRefresh = false;
    if (path === '/web/base/OSRASD.RatePlanChange') {
      savedRefresh = Boolean(savedScope && isReviewedSavedRateShopRefresh(request, {
        origin: property.origin, propertyCode: property.propertyCode, saved: savedScope }));
      try {
        const blank = state.blankRateReadScope;
        blankRefresh = Boolean(state.verified && !state.writer && state.ownedPage && blank &&
          request.frame() === blank.frame && hasPageRequestAuthorization(request, state.ownedPage) &&
          isReviewedBlankRateShopRefresh(request, { origin: property.origin, propertyCode: property.propertyCode, blank }));
      } catch { return route.abort(); }
      if (!savedRefresh && !blankRefresh) return route.abort();
    }
    if (path === '/api/internalBooking/rateshop/inquiryForGrid') {
      const options = { origin: property.origin, propertyCode: property.propertyCode,
        rejectDuplicateJsonBodyKeys: rejectDuplicateAvailabilityJsonKeys,
        reservationStayId: savedScope?.reservationStayId ?? '' };
      if (!isReviewedAvailabilityInquiry(request, options) &&
          !(state.verified && !state.writer && isReviewedGuestStayRatePlanInquiry(request, options))) return route.abort();
      // Earlier context guards still need the read authorization; closing its page scope revokes it.
    }
    if (url.username || url.password || (forbiddenPath.test(path) && !savedRefresh && !blankRefresh) || hasWriteIntent(request.url()) || hasWriteIntent(body) ||
        !['GET', 'HEAD', 'OPTIONS', 'POST'].includes(method)) return route.abort();
    if (request.isNavigationRequest() && url.origin !== property.origin) return route.abort();
    if (path === '/web/base/loadmain' && url.searchParams.has('defaultproperty')) {
      const requested = url.searchParams.getAll('defaultproperty');
      if (!state.switching || requested.length !== 1 || requested[0] !== state.switching) return route.abort();
    }
    if (!state.verified && path === '/web/base/loadmain') {
      const screen = url.searchParams.get('initpath');
      if (screen && screen !== 'BSSTRT') return route.abort();
    }
    if (!state.verified && (/^\/api\//i.test(path) || /^\/web\/base\/(?:OSRESV|OSRESS|OSRRAV|OSMPAV|FSGSPF)/i.test(path) ||
        (/^\/web\/jsp\//i.test(path) && path !== '/web/jsp/interfaceStatusAlert.jsp'))) return route.abort();
    if (method === 'POST') {
      if (url.origin !== property.origin) return route.abort();
      if (!state.verified && !['/web/base/login', '/web/base/BSSTRT', '/web/base/BSSTRT.HDR',
        '/web/base/LOVPOP', '/web/base/GRIDDATA', '/web/base/GETCACHE', '/web/base/BSMSLV'].includes(path)) return route.abort();
      if (path === '/web/base/login') {
        const params = new URLSearchParams(body);
        if (state.authenticated || params.get('tenant') !== property.expectedTenant ||
            params.get('SYSTEM_FUNCTION_NAME') !== 'LOGIN' || params.get('USER_FUNCTION_NAME') !== 'LOGIN') return route.abort();
      } else if ((!readPosts.has(path) && !savedRefresh && !blankRefresh) || (path === '/web/base/OSRESV.HDR' && !safeHeaderRead(url, body, property.propertyCode))) {
        const availabilityDetail = state.verified && !state.writer &&
          (path === '/web/base/OSCCRT' || path === `/api/booking/hotelAvail/${property.propertyCode}/availabilityDetailsInquiry`);
        if (availabilityDetail && typeof state.readRequestPolicy === 'function') {
          try {
            if (request.frame().page() === state.ownedPage && state.readRequestPolicy(request) === true) return route.fallback();
          } catch { /* An unproven availability detail remains blocked. */ }
        }
        return route.abort();
      }
      if (path === '/api/internalBooking/hotelAvail/inquiryForGrid') {
        let inquiry;
        try { inquiry = JSON.parse(body); } catch { return route.abort(); }
        if (typeof inquiry?.propertyCodes !== 'string' || inquiry.propertyCodes.trim().toUpperCase() !== property.propertyCode) return route.abort();
      }
    }
    return route.fallback();
  });
}

async function installPostRedirectGuard(context) {
  await context.route('**/*', async (route) => {
    if (route.request().method().toUpperCase() !== 'POST') return route.fallback();
    try {
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 });
      if (response.status() >= 300 && response.status() < 400) return await route.abort();
      return await route.fulfill({ response });
    } catch {
      try { await route.abort(); } catch { /* A closed context has already terminated the request. */ }
    }
  });
}

/** Verify the native shell, not a property inferred from the caller or a business result. */
export async function verifyCloudProperty(page, { propertyCode, tenantId } = {}) {
  const property = registeredProperty(propertyCode);
  if (tenantId !== undefined && tenantId !== property.expectedTenant) throw new Error('HMS_TENANT_MISMATCH');
  const handle = await page.waitForFunction(({ expectedProperty, expectedTenant, expectedOrigin }) => {
    const visible = (el) => Boolean(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    if (location.origin !== expectedOrigin || [...document.querySelectorAll('input[name="password"], input[type="password"], .x-mask, .x-mask-msg, .x-loadmask, [aria-busy="true"]')].some(visible)) return false;
    const app = window.EAM?.AppData?.getRawAppData?.() ?? {};
    const html = document.documentElement.outerHTML;
    const tenant = app.tenantid ?? document.documentElement.dataset.tenant ?? /"tenantid"\s*:\s*"([^"]+)"/i.exec(html)?.[1] ?? new URL(location.href).searchParams.get('tenant');
    const controls = [...document.querySelectorAll('.switchproperty, input[name="property"]')].filter(visible);
    const nativeCodes = controls.map((el) => (el.value || el.textContent || '').trim()).filter(Boolean);
    if (app.property) nativeCodes.push(String(app.property).trim());
    const titleCode = /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1];
    if (titleCode) nativeCodes.push(titleCode);
    if (tenant !== expectedTenant || !nativeCodes.length || nativeCodes.some((code) => code !== expectedProperty)) return false;
    const name = app.propertyname ?? app.propertyName ?? app.propertydescription ?? null;
    return { propertyCode: expectedProperty, tenantId: expectedTenant, origin: expectedOrigin,
      observedName: typeof name === 'string' && name.trim() ? name.trim() : null };
  }, { expectedProperty: property.propertyCode, expectedTenant: property.expectedTenant, expectedOrigin: property.origin }, { timeout: 30000 });
  try { return await handle.jsonValue(); } finally { await handle.dispose(); }
}

/** Select the native property row and wait for the shell to confirm the new code. */
export async function switchCloudProperty(page, { propertyCode, landingPropertyCode, tenantId } = {}) {
  const target = registeredProperty(propertyCode);
  const landing = registeredProperty(landingPropertyCode);
  if (target.landingPropertyCode !== landing.propertyCode || target.group !== landing.group ||
      target.expectedTenant !== landing.expectedTenant || target.origin !== landing.origin ||
      (tenantId !== undefined && tenantId !== target.expectedTenant)) throw new Error('HMS_PROPERTY_SWITCH_REFUSED');
  const before = await verifyCloudProperty(page, { propertyCode: landing.propertyCode, tenantId });
  if (target.propertyCode === landing.propertyCode) return before;
  const state = sessionState.get(page.context());
  const button = page.locator('.switchproperty:visible').first();
  await button.click();
  const popup = page.locator('.x-window[id^="gridpopup"]:visible').last();
  await popup.waitFor({ state: 'visible', timeout: 15000 });
  const rows = popup.locator('tr.x-grid-row:visible');
  await rows.first().waitFor({ state: 'visible', timeout: 15000 });
  let selected;
  let observedName = null;
  for (let i = 0; i < await rows.count(); i += 1) {
    const row = rows.nth(i);
    const cells = row.locator('td');
    if ((await cells.count()) < 2 || (await cells.nth(0).innerText()).trim() !== target.propertyCode) continue;
    if (selected) throw new Error('HMS_PROPERTY_SWITCH_AMBIGUOUS');
    selected = row;
    observedName = (await cells.nth(1).innerText()).trim() || null;
  }
  if (!selected) throw new Error('HMS_PROPERTY_SWITCH_UNAVAILABLE');
  await selected.click();
  await selected.waitFor({ state: 'visible', timeout: 5000 });
  if (!(await selected.evaluate((el) => el.classList.contains('x-grid-row-selected')))) throw new Error('HMS_PROPERTY_SWITCH_NOT_SELECTED');
  const ok = popup.locator('a.x-btn:visible, button:visible').filter({ hasText: /^\s*OK\s*$/ });
  if (await ok.count() !== 1) throw new Error('HMS_PROPERTY_SWITCH_AMBIGUOUS');
  if (state) state.switching = target.propertyCode;
  try {
    await ok.click();
    const identity = await verifyCloudProperty(page, { propertyCode: target.propertyCode, tenantId });
    return { ...identity, observedName: observedName ?? identity.observedName };
  } finally { if (state) state.switching = null; }
}

async function openStay360(page) {
  const node = (label) => page.locator('span.x-tree-node-text:visible')
    .filter({ hasText: new RegExp(`^${label}$`) });
  await page.locator('a.app-menu-trigger:visible').click();
  const frontDesk = node('Front Desk');
  await frontDesk.waitFor({ state: 'visible' });
  await frontDesk.scrollIntoViewIfNeeded({ timeout: 900 }).catch(() => {});
  await frontDesk.click();
  await page.waitForTimeout(800);
  const stay360 = node('Stay 360');
  await stay360.waitFor({ state: 'visible' });
  await stay360.scrollIntoViewIfNeeded({ timeout: 900 }).catch(() => {});
  await stay360.click();
  await page.locator('input[name="search"]:visible').first().waitFor();
}

async function authenticatedShellReady(page, secret) {
  try {
    return await page.evaluate(({ expectedTenant, expectedPropertyCode, expectedPropertyName }) => {
      const html = document.documentElement.outerHTML;
      const tenant = document.documentElement.dataset.tenant ?? /"tenantid"\s*:\s*"([^"]+)"/i.exec(html)?.[1] ?? new URL(location.href).searchParams.get('tenant');
      const property = document.documentElement.dataset.propertyCode ?? /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1];
      const visible = element => Boolean(element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
      return ![...document.querySelectorAll('input[type="password"], input[name="password"], .x-mask, .x-mask-msg, .x-loadmask, [aria-busy="true"]')].some(visible) &&
        tenant === expectedTenant && property === expectedPropertyCode && (document.body?.innerText ?? '').includes(expectedPropertyName);
    }, { expectedTenant: secret.expectedTenant, expectedPropertyCode: secret.expectedPropertyCode, expectedPropertyName: secret.expectedPropertyName });
  } catch (error) {
    if (/execution context was destroyed|cannot find context|most likely because of a navigation/i.test(error?.message ?? '')) return false;
    throw error;
  }
}

async function login(page, secret, signal) {
  const deadline = Date.now() + 120_000;
  const budget = () => Math.max(1, deadline - Date.now());
  signal?.throwIfAborted();
  await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: budget() });
  let submitted = false;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await authenticatedShellReady(page, secret)) return;
    if (!submitted && await page.locator('input[name="password"]:visible, input[type="password"]:visible').count()) {
      await page.locator('input[name="userid"], input[name="username"]').fill(secret.username, { timeout: budget() });
      const password = page.locator('input[name="password"]');
      await password.fill(secret.password, { timeout: budget() });
      const submit = page.getByRole('button', { name: 'Sign in', exact: true });
      if (await submit.count()) await submit.click({ timeout: budget() });
      else await password.press('Enter', { timeout: budget() });
      submitted = true;
    }
    await delay(250, undefined, { signal });
  }
  throw new Error('AUTHENTICATED_SHELL_TIMEOUT');
}

async function runUntilAborted(operation, signal) {
  if (!signal) return operation();
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Canonical credentials shared by multiple properties use one advisory lock. */
export function cloudCredentialLeaseKey(propertyCode) {
  const property = registeredProperty(propertyCode);
  return createHash('sha256').update('zero/hms-credential-lease/v1\0')
    .update(property.credentialSecretRef).digest().readBigInt64BE(0).toString();
}

/** Mark background work at its entry point; nested cloud sessions inherit the priority. */
export function withCloudCredentialPriority(priority, operation) {
  if (!['staff', 'background'].includes(priority) || typeof operation !== 'function') {
    throw new Error('HMS_CREDENTIAL_LEASE_OPTIONS_INVALID');
  }
  return credentialPriority.run(priority, operation);
}

/** The queued pane path is off unless explicitly enabled. */
export function hmsJobQueueEnabled(env = process.env) {
  return env.HMS_JOB_QUEUE === 'on';
}

export function hmsJobQueueAvailable(env = process.env) {
  return hmsJobQueueEnabled(env) && (!env.HMS_LANE_PAUSED || ['false', '0'].includes(env.HMS_LANE_PAUSED));
}

// A live consumer holds the shared lock in the same database. Every process,
// including standalone tools with a different environment, observes the same
// queue availability. A dead connection automatically removes the marker.
export const hmsJobConsumerAvailableSql = `EXISTS (SELECT 1 FROM pg_locks consumer
  WHERE consumer.locktype = 'advisory' AND consumer.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND consumer.classid = hashtext('zero/hms-job-consumer/v1')::oid AND consumer.objid = 0
    AND consumer.objsubid = 2 AND consumer.mode = 'ShareLock' AND consumer.granted)`;

/** A private ledger run reuses its durable admission ticket across sessions and retries. */
export function withCloudCredentialRun(fence, operation) {
  if (!fence || ![fence.runId, fence.claimOwner, fence.claimToken].every(value => typeof value === 'string' && value && value.length <= 512) || typeof operation !== 'function') {
    throw new Error('HMS_CREDENTIAL_LEASE_OPTIONS_INVALID');
  }
  return credentialRun.run(Object.freeze({ runId: fence.runId, claimOwner: fence.claimOwner, claimToken: fence.claimToken }), operation);
}

/** Repository command-line proofs and tools are background unless explicitly scoped. */
export function currentCloudCredentialPriority(fallback) {
  const owned = credentialLeases.get(credentialScope.getStore());
  if (owned && !owned.released) return owned.priority;
  const scoped = credentialPriority.getStore();
  if (scoped) return scoped;
  if (process.env.NAVA_HMS_CHILD_PRIORITY === 'staff' || process.env.NAVA_HMS_CHILD_PRIORITY === 'background') {
    return process.env.NAVA_HMS_CHILD_PRIORITY;
  }
  if (fallback !== undefined) {
    if (!['staff', 'background'].includes(fallback)) throw new Error('HMS_CREDENTIAL_LEASE_OPTIONS_INVALID');
    return fallback;
  }
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  return /\/apps\/server-pilot\/(?:src|dist)\/(?:main|hms\/remote-http)\.[cm]?[jt]s$/.test(entry)
    ? 'staff' : 'background';
}

async function registerCredentialAdmission(connection, key, fence) {
  const runId = fence?.runId;
  const operationKey = runId ? `run:${runId}` : `direct:${randomUUID()}`;
  await connection.unsafe(`DELETE FROM hms_credential_admission admission WHERE admission.run_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_stat_activity backend
      WHERE backend.pid = admission.owner_pid AND backend.backend_start = admission.owner_started_at)`);
  if (runId) {
    await credentialRunPromoted(connection, fence);
  }
  const runAdmission = fence ? `WITH owned_run AS (
    UPDATE ai_workflow_run SET metrics = CASE WHEN run_kind = 'reservation_prefill'
      THEN coalesce(metrics, '{}'::jsonb) || '{"credentialPending":true}'::jsonb ELSE metrics END
    WHERE id = $3 AND claim_owner = $4 AND claim_token = $5 AND state = 'running' AND deadline_at > clock_timestamp()
    RETURNING id)
    INSERT INTO hms_credential_admission (operation_key, credential_key, run_id, owner_pid, owner_started_at)
    SELECT $1, $2::bigint, id, pg_backend_pid(), (SELECT backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()) FROM owned_run` : `INSERT INTO hms_credential_admission
      (operation_key, credential_key, owner_pid, owner_started_at)
      VALUES ($1, $2::bigint, pg_backend_pid(), (SELECT backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()))`;
  const rows = await connection.unsafe(`${runAdmission}
    ON CONFLICT (operation_key) DO UPDATE SET credential_key = EXCLUDED.credential_key,
      owner_pid = EXCLUDED.owner_pid, owner_started_at = EXCLUDED.owner_started_at
      WHERE hms_credential_admission.credential_key IS NULL OR hms_credential_admission.credential_key = EXCLUDED.credential_key
    RETURNING operation_key`, fence ? [operationKey, key, fence.runId, fence.claimOwner, fence.claimToken] : [operationKey, key]);
  if (rows.length !== 1) throw new Error('HMS_CREDENTIAL_ADMISSION_SCOPE_INVALID');
  return operationKey;
}

export function cloudDevBackgroundEligible() {
  const hour = new Date().getUTCHours();
  const start = Number(process.env.HMS_DEV_GATE_START_HOUR_UTC ?? 5);
  const end = Number(process.env.HMS_DEV_GATE_END_HOUR_UTC ?? 16);
  return process.env.HMS_DEV_GATE === 'off' || hour < start || hour >= end;
}

// A stopped queue retains its tickets. Unclaimed jobs are suspended; a fresh
// claim or a live credential session stays eligible until it settles or expires.
// An idle prefill ticket cannot become head while another default prefill is
// already waiting on that credential: the same worker may need to run both.
export const cloudCredentialAdmissionEligibilitySql = `((admission.run_id IS NULL AND EXISTS (SELECT 1 FROM pg_stat_activity backend
        WHERE backend.pid = admission.owner_pid AND backend.backend_start = admission.owner_started_at))
        OR (run.state IN ('queued', 'retry_wait', 'claimed', 'running')
          AND (${hmsJobConsumerAvailableSql} OR (run.state IN ('claimed', 'running') AND
            (run.deadline_at > clock_timestamp() OR EXISTS (SELECT 1 FROM pg_stat_activity backend
              WHERE backend.pid = admission.owner_pid AND backend.backend_start = admission.owner_started_at)))
            OR run.run_kind <> 'read_tool' OR run.prompt_version <> 'hms-job/1')
          AND (run.state IN ('claimed', 'running') OR run.next_run_at IS NULL OR run.next_run_at <= $4::timestamptz)
          AND (run.run_kind <> 'reservation_prefill' OR run.metrics->>'phase' = 'native_checks' OR run.metrics->>'credentialPending' = 'true'
            OR EXISTS (SELECT 1 FROM work_item item WHERE item.id = run.work_item_id AND item.transport_id = run.transport_id
              AND item.state->'reservationWorkflowV2'->'prefill'->>'jobRunId' = run.id
              AND item.state->'reservationWorkflowV2'->'prefill'->>'phase' = 'native_checks'
              AND item.state->'reservationWorkflowV2'->'prefill'->>'status' = 'running'))
          AND (run.run_kind <> 'reservation_prefill' OR run.executor_lane <> 'default'
            OR EXISTS (SELECT 1 FROM pg_stat_activity owner WHERE owner.pid = admission.owner_pid
              AND owner.backend_start = admission.owner_started_at)
            OR NOT EXISTS (SELECT 1 FROM hms_credential_admission active_admission
              JOIN ai_workflow_run active_run ON active_run.id = active_admission.run_id
              JOIN pg_stat_activity owner ON owner.pid = active_admission.owner_pid
                AND owner.backend_start = active_admission.owner_started_at
              WHERE active_run.id <> run.id AND active_run.executor_lane = 'default'
                AND active_run.run_kind = 'reservation_prefill' AND active_run.transport_id = ANY($2::text[])
                AND active_run.state IN ('claimed', 'running') AND active_run.deadline_at > clock_timestamp()))
          AND coalesce(run.metrics->>'staffPrefillRequested', 'false') <> 'true'
          AND (run.run_kind <> 'read_tool' OR run.prompt_version <> 'hms-job/1' OR run.priority < 10)
          AND ($3::boolean OR run.run_kind <> 'read_tool' OR run.prompt_version <> 'hms-job/1' OR run.priority >= 0
            OR NOT EXISTS (SELECT 1 FROM ai_workflow_run higher
              WHERE higher.transport_id = ANY($2::text[]) AND higher.executor_lane = 'hms'
                AND higher.run_kind <> 'hms_write' AND higher.priority >= 0
                AND (higher.state IN ('claimed', 'running') OR
                  (higher.state IN ('queued', 'retry_wait') AND
                    (higher.next_run_at IS NULL OR higher.next_run_at <= $4::timestamptz)))))))`;

async function credentialAdmissionHead(connection, key, transportIds) {
  const rows = await connection.unsafe(`SELECT admission.operation_key
    FROM hms_credential_admission admission LEFT JOIN ai_workflow_run run ON run.id = admission.run_id
    WHERE (admission.credential_key = $1::bigint OR run.transport_id = ANY($2::text[]))
      AND ${cloudCredentialAdmissionEligibilitySql}
    ORDER BY admission.position LIMIT 1`, [key, transportIds, cloudDevBackgroundEligible(), new Date().toISOString()]);
  return rows[0]?.operation_key;
}

async function credentialRunPromoted(connection, fence) {
  if (!fence) return false;
  const rows = await connection.unsafe(`SELECT state, deadline_at,
    (coalesce(metrics->>'staffPrefillRequested', 'false') = 'true'
      OR (run_kind = 'read_tool' AND prompt_version = 'hms-job/1' AND priority >= 10)) AS staff
    FROM ai_workflow_run WHERE id = $1 AND claim_owner = $2 AND claim_token = $3`,
    [fence.runId, fence.claimOwner, fence.claimToken]);
  if (rows[0]?.state !== 'running' || !(rows[0]?.deadline_at > new Date())) throw new Error('HMS_CREDENTIAL_RUN_STALE');
  return rows[0]?.staff === true;
}

/** A dedicated connection holds one credential lock across all participating processes. */
export async function acquireCloudCredentialLease(propertyCode, { signal, readOnly = false, priority = currentCloudCredentialPriority(), databaseUrl = process.env.DATABASE_URL, deadlineAt } = {}) {
  const property = registeredProperty(propertyCode);
  if (typeof readOnly !== 'boolean' || !['staff', 'background'].includes(priority) ||
      (deadlineAt !== undefined && !Number.isFinite(deadlineAt))) throw new Error('HMS_CREDENTIAL_LEASE_OPTIONS_INVALID');
  signal?.throwIfAborted();
  const loss = new AbortController();
  const waitMs = Math.min(readOnly ? 75000 : 20000, deadlineAt === undefined ? Infinity : Math.max(1, deadlineAt - Date.now()));
  const acquisitionTimeout = AbortSignal.timeout(waitMs);
  const acquisitionSignal = AbortSignal.any([loss.signal, acquisitionTimeout, ...(signal ? [signal] : [])]);
  const state = { ref: property.credentialSecretRef, released: false, borrowers: 0, priority };
  let client;
  let connection;
  let timer;
  let heartbeat;
  let acquired = false;
  let closing = false;
  let phase = 'connection';
  let admissionKey;
  const runFence = credentialRun.getStore();
  const runId = runFence?.runId;
  const fail = () => { if (!closing && !loss.signal.aborted) loss.abort(new Error('HMS_CREDENTIAL_LEASE_LOST')); };
  const key = cloudCredentialLeaseKey(propertyCode);
  const waiterKey = createHash('sha256').update('zero/hms-credential-waiters/v1\0')
    .update(property.credentialSecretRef).digest().readBigInt64BE(0).toString();
  const transportIds = [...new Set(PROPERTY_REGISTRY.properties.filter(entry => entry.active &&
    entry.credentialSecretRef === property.credentialSecretRef).flatMap(entry => [...entry.transportIds]))];
  try {
    {
      if (!databaseUrl) throw new Error('HMS_CREDENTIAL_LEASE_DATABASE_REQUIRED');
      client = postgres(databaseUrl, { max: 1, idle_timeout: 0, connect_timeout: 10,
        onclose: fail });
      connection = await runUntilAborted(() => client.reserve(), acquisitionSignal);
      // Staff hold a shared waiter marker while queued. Background acquires an
      // exclusive marker only for a nonblocking lane attempt, so it cannot pass
      // registered staff waiters. PostgreSQL releases both locks on disconnect.
      await runUntilAborted(() => connection.unsafe("SELECT set_config('lock_timeout', $1, false)",
        [readOnly ? '70s' : '15s']), acquisitionSignal);
      const enterStaff = async () => {
        phase = 'contention';
        await runUntilAborted(() => connection.unsafe('SELECT pg_advisory_lock_shared($1::bigint)', [waiterKey]), acquisitionSignal);
        await runUntilAborted(() => connection.unsafe('SELECT pg_advisory_lock($1::bigint)', [key]), acquisitionSignal);
        acquired = true;
        state.priority = 'staff';
        const released = await runUntilAborted(() => connection.unsafe('SELECT pg_advisory_unlock_shared($1::bigint) AS released', [waiterKey]), acquisitionSignal);
        if (released[0]?.released !== true) throw new Error('HMS_CREDENTIAL_LEASE_LOST');
      };
      if (priority === 'staff') {
        await runUntilAborted(() => credentialRunPromoted(connection, runFence), acquisitionSignal);
        await enterStaff();
      }
      else {
        phase = 'contention';
        admissionKey = await runUntilAborted(() => registerCredentialAdmission(connection, key, runFence), acquisitionSignal);
        while (!acquired) {
          phase = 'contention';
          if (await runUntilAborted(() => credentialRunPromoted(connection, runFence), acquisitionSignal)) {
            await enterStaff();
          } else if (await runUntilAborted(() => credentialAdmissionHead(connection, key, transportIds), acquisitionSignal) === admissionKey) {
            const marker = await runUntilAborted(() => connection.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [waiterKey]), acquisitionSignal);
            if (marker[0]?.acquired === true) {
              const rows = await runUntilAborted(() => connection.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key]), acquisitionSignal);
              acquired = rows[0]?.acquired === true;
              // Queue consumers can appear between the first head check and
              // acquiring the credential. Recheck before starting any session.
              if (acquired && await runUntilAborted(() => credentialAdmissionHead(connection, key, transportIds), acquisitionSignal) !== admissionKey) {
                const relinquished = await runUntilAborted(() => connection.unsafe('SELECT pg_advisory_unlock($1::bigint) AS released', [key]), acquisitionSignal);
                if (relinquished[0]?.released !== true) throw new Error('HMS_CREDENTIAL_LEASE_LOST');
                acquired = false;
              }
              const released = await runUntilAborted(() => connection.unsafe('SELECT pg_advisory_unlock($1::bigint) AS released', [waiterKey]), acquisitionSignal);
              if (released[0]?.released !== true) throw new Error('HMS_CREDENTIAL_LEASE_LOST');
            }
          }
          if (!acquired) await delay(250, undefined, { signal: acquisitionSignal });
        }
        await runUntilAborted(() => connection.unsafe(`UPDATE hms_credential_admission SET owner_pid = pg_backend_pid(),
          owner_started_at = (SELECT backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()) WHERE operation_key = $1`,
          [admissionKey]), acquisitionSignal);
      }
      await runUntilAborted(() => credentialRunPromoted(connection, runFence), acquisitionSignal);
      signal?.throwIfAborted();
      phase = 'connection';
      const rows = await runUntilAborted(() => connection.unsafe('SELECT pg_backend_pid() AS pid'), acquisitionSignal);
      const pid = rows[0]?.pid;
      if (!Number.isInteger(pid) || loss.signal.aborted) throw new Error('HMS_CREDENTIAL_LEASE_LOST');
      phase = 'quiescence';
      await assertCredentialWriterQuiesced(propertyCode);
      state.assertRunLive = () => runUntilAborted(() => credentialRunPromoted(connection, runFence),
        AbortSignal.any([loss.signal, AbortSignal.timeout(10000)]));
      timer = setInterval(() => {
        if (heartbeat || closing) return;
        heartbeat = Promise.race([
          connection.unsafe('SELECT pg_backend_pid() AS pid'),
          delay(10000, undefined, { ref: false }).then(() => { throw new Error('HMS_CREDENTIAL_LEASE_TIMEOUT'); }),
        ]).then((result) => {
          if (result[0]?.pid !== pid) fail();
        }, fail).finally(() => { heartbeat = undefined; });
      }, 5000);
      timer.unref?.();
    }
    const lease = Object.freeze({
      signal: loss.signal,
      async release() {
        if (state.released) return;
        if (state.borrowers) throw new Error('HMS_CREDENTIAL_LEASE_IN_USE');
        state.released = true;
        closing = true;
        if (timer) clearInterval(timer);
        let failed = loss.signal.aborted;
        const bounded = (work) => Promise.race([work, delay(5000, undefined, { ref: false }).then(() => {
          throw new Error('HMS_CREDENTIAL_LEASE_TIMEOUT');
        })]);
        try {
          if (heartbeat) await bounded(heartbeat);
          if (admissionKey && !failed) {
            if (runFence) await bounded(connection.unsafe(`WITH fulfilled AS (
              UPDATE ai_workflow_run SET metrics = coalesce(metrics, '{}'::jsonb) || '{"credentialPending":false}'::jsonb
              WHERE id = $1 AND claim_owner = $2 AND claim_token = $3 AND run_kind = 'reservation_prefill'
                AND coalesce(metrics->>'phase', 'generation') <> 'native_checks'
                AND NOT EXISTS (SELECT 1 FROM work_item item WHERE item.id = ai_workflow_run.work_item_id
                  AND item.state->'reservationWorkflowV2'->'prefill'->>'jobRunId' = ai_workflow_run.id
                  AND item.state->'reservationWorkflowV2'->'prefill'->>'phase' = 'native_checks'
                  AND item.state->'reservationWorkflowV2'->'prefill'->>'status' = 'running') RETURNING id)
              DELETE FROM hms_credential_admission WHERE run_id IN (SELECT id FROM fulfilled)`,
              [runFence.runId, runFence.claimOwner, runFence.claimToken]));
            await bounded(connection.unsafe(runId
              ? 'UPDATE hms_credential_admission SET owner_pid = NULL, owner_started_at = NULL WHERE operation_key = $1'
              : 'DELETE FROM hms_credential_admission WHERE operation_key = $1', [admissionKey]));
          }
          if (acquired && !failed) {
            const rows = await bounded(connection.unsafe('SELECT pg_advisory_unlock($1::bigint) AS released', [key]));
            if (rows[0]?.released !== true) failed = true;
          }
        } catch { failed = true; }
        try { await client?.end({ timeout: 5 }); } catch { failed = true; }
        if (failed) throw new Error('HMS_CREDENTIAL_LEASE_RELEASE_FAILED');
      },
    });
    credentialLeases.set(lease, state);
    return lease;
  } catch (error) {
    closing = true;
    if (timer) clearInterval(timer);
    try { await client?.end({ timeout: 5 }); } catch { throw new Error('HMS_CREDENTIAL_LEASE_RELEASE_FAILED'); }
    if (signal?.aborted) signal.throwIfAborted();
    if (['HMS_CREDENTIAL_LEASE_DATABASE_REQUIRED', 'HMS_CREDENTIAL_RUN_STALE', 'HMS_CREDENTIAL_ADMISSION_SCOPE_INVALID'].includes(error?.message)) throw error;
    throw new Error(phase === 'quiescence' ? 'HMS_CREDENTIAL_LEASE_QUIESCENCE_FAILED' :
      error?.code === '55P03' || (phase === 'contention' && acquisitionTimeout.aborted) ? 'HMS_CREDENTIAL_LEASE_CONTENDED' :
        'HMS_CREDENTIAL_LEASE_CONNECTION_FAILED');
  }
}

/** Only live, process-local ownership can be inherited; never serialize a lease into a child. */
export function currentCloudCredentialLease(propertyCode) {
  const lease = credentialScope.getStore();
  if (!lease) return undefined;
  const state = credentialLeases.get(lease);
  if (!state || state.released || state.ref !== registeredProperty(propertyCode).credentialSecretRef || lease.signal.aborted) {
    throw new Error('HMS_CREDENTIAL_LEASE_INVALID');
  }
  return lease;
}

/** A browser borrows exclusively until all its contexts have closed. */
export function borrowCloudCredentialLease(propertyCode, lease) {
  const state = credentialLeases.get(lease);
  if (!state || state.released || state.ref !== registeredProperty(propertyCode).credentialSecretRef || lease.signal.aborted) {
    throw new Error('HMS_CREDENTIAL_LEASE_INVALID');
  }
  if (state.borrowers) throw new Error('HMS_CREDENTIAL_LEASE_IN_USE');
  state.borrowers += 1;
  let released = false;
  return () => { if (!released) { released = true; state.borrowers -= 1; } };
}

export async function withCloudCredentialLease(propertyCode, operation, options = {}) {
  if (typeof operation !== 'function') throw new Error('HMS_CREDENTIAL_LEASE_OPTIONS_INVALID');
  options.signal?.throwIfAborted();
  const inherited = currentCloudCredentialLease(propertyCode);
  if (inherited) {
    await credentialLeases.get(inherited)?.assertRunLive?.();
    const result = await operation(inherited);
    options.signal?.throwIfAborted();
    inherited.signal.throwIfAborted();
    return result;
  }
  const lease = await acquireCloudCredentialLease(propertyCode, options);
  try {
    const result = await credentialScope.run(lease, () => operation(lease));
    options.signal?.throwIfAborted();
    lease.signal.throwIfAborted();
    return result;
  } finally { await lease.release(); }
}

/** Fresh browser/context per operation; a caller-owned lease can span sequential sessions. */
export function withCloudReadSession(operation, options = {}) {
  return withCloudSession(operation, options, false);
}

/** Native actions still need their page-owned semantic request authorization. */
export function withCloudWriterSession(operation, options = {}) {
  return withCloudSession(operation, options, true);
}

async function withCloudSession(operation, { propertyCode, transportId, signal, headless = true,
  prepareContext, readRequestPolicy, startScreen = 'BSSTRT', loadSecret = loadCloudSecret, credentialLease, cloudTargetKey, cloudTargetKeys,
  requireBoundCredentialVersion = false, allowUnboundCredentialVersion = false } = {}, writer) {
  const property = registeredProperty(propertyCode);
  if (typeof operation !== 'function' || typeof headless !== 'boolean' ||
      (transportId !== undefined && (typeof transportId !== 'string' || !property.transportIds.includes(transportId))) ||
      !['BSSTRT', 'OSRESV', 'OSRESS'].includes(startScreen) || typeof loadSecret !== 'function' ||
      (prepareContext !== undefined && typeof prepareContext !== 'function') ||
      (readRequestPolicy !== undefined && typeof readRequestPolicy !== 'function') ||
      typeof requireBoundCredentialVersion !== 'boolean' || typeof allowUnboundCredentialVersion !== 'boolean' ||
      (cloudTargetKeys !== undefined && (!Array.isArray(cloudTargetKeys) || !cloudTargetKeys.length ||
        cloudTargetKeys.length > 16 || cloudTargetKeys.some(key => typeof key !== 'string')))) throw new Error('HMS_SESSION_OPTIONS_INVALID');
  const aliases = [...new Set([...(cloudTargetKeys ?? []), ...(cloudTargetKey === undefined ? [] : [cloudTargetKey])])];
  let lease = credentialLease ?? currentCloudCredentialLease(propertyCode);
  let ownedLease = false;
  let leaseState;
  let borrowed = false;
  let browser;
  let browserServer;
  let writerIdentity;
  let writerGroupGone = false;
  let credentialWriterHeld = false;
  let callbacksDrained = true;
  let operationTask;
  let context;
  let state;
  let secret;
  let abortClose;
  let cleanupError;
  let resourceCloseError;
  let result;
  let failure;
  let failed = false;
  const closeResource = (resource) => Promise.race([
    resource.close(), delay(15_000, undefined, { ref: false }).then(() => { throw new Error('HMS_SESSION_CLEANUP_TIMEOUT'); }),
  ]);
  const close = async () => {
    if (state) state.verified = false;
    const currentContext = context; context = undefined;
    const currentBrowser = browser; browser = undefined;
    for (const resource of [currentContext, currentBrowser]) {
      if (resource) try { await closeResource(resource); } catch { resourceCloseError ??= new Error('HMS_SESSION_CLEANUP_FAILED'); }
    }
    if (browserServer) {
      const server = browserServer; browserServer = undefined;
      try { await closeResource(server); }
      catch {
        resourceCloseError ??= new Error('HMS_SESSION_CLEANUP_FAILED');
        if (writerIdentity && cloudWriterCurrent(writerIdentity)) {
          try { process.kill(-writerIdentity.browser.pid, 'SIGKILL'); await delay(250); }
          catch { /* Unconfirmed termination preserves the target hold and lease. */ }
        }
      }
    }
  };
  const onAbort = () => { abortClose = close(); };
  let sessionSignal = signal;
  try {
    signal?.throwIfAborted();
    if (property.group === 'centurion') assertNoCenturionBrowserHold();
    if (!lease) {
      lease = await acquireCloudCredentialLease(propertyCode, { signal, readOnly: !writer });
      ownedLease = true;
    }
    if (lease) {
      leaseState = credentialLeases.get(lease);
      if (!leaseState || leaseState.released || leaseState.ref !== property.credentialSecretRef || lease.signal.aborted) {
        throw new Error('HMS_CREDENTIAL_LEASE_INVALID');
      }
      await leaseState.assertRunLive?.();
      if (leaseState.borrowers) throw new Error('HMS_CREDENTIAL_LEASE_IN_USE');
      leaseState.borrowers += 1;
      borrowed = true;
      sessionSignal = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
    }
    for (const alias of aliases) {
      reconcileCloudBrowserHold(propertyCode, alias, lease);
      assertNoCloudHold(propertyCode, alias);
    }
    sessionSignal?.addEventListener('abort', onAbort, { once: true });
    sessionSignal?.throwIfAborted();
    let loaded;
    try { loaded = await runUntilAborted(() => loadSecret({ secretArn: property.credentialSecretRef, signal: sessionSignal }), sessionSignal); }
    catch {
      sessionSignal?.throwIfAborted();
      throw new Error('HMS_CREDENTIALS_UNAVAILABLE');
    }
    secret = validateSecret(property, loaded, transportId);
    const credentialVersionHmacSha256 = await verifyCloudCredentialVersion({ propertyCode, transportId, loadedSecret: loaded,
      signal: sessionSignal, requireBoundVersion: writer || requireBoundCredentialVersion,
      allowUnboundVersion: !writer && allowUnboundCredentialVersion });
    sessionSignal?.throwIfAborted();
    if (property.group === 'centurion') assertNoCenturionBrowserHold();
    const launch = { headless, executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined };
    if (writer) {
      browserServer = await chromium.launchServer(launch);
      writerIdentity = { ...hostIdentity(), node: processIdentity(process.pid), browser: processIdentity(browserServer.process().pid, true) };
      holdCredentialWriter(propertyCode, writerIdentity);
      credentialWriterHeld = true;
      browser = await chromium.connect(browserServer.wsEndpoint());
    } else browser = await chromium.launch(launch);
    sessionSignal?.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false });
    sessionSignal?.throwIfAborted();
    state = { authenticated: false, switching: null, verified: false, writer, ownedPage: null, identity: null,
      readRequestPolicy };
    sessionState.set(context, state);
    await installPostRedirectGuard(context);
    if (!writer && prepareContext) await runUntilAborted(() => prepareContext(context), sessionSignal);
    await installCloudReadGuard(context, property, state);
    if (writer && prepareContext) await runUntilAborted(() => prepareContext(context), sessionSignal);
    const page = await context.newPage();
    state.ownedPage = page;
    if (writerIdentity) ownedWriterPages.set(page, writerIdentity);
    if (!writer) page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
    await login(page, secret, sessionSignal);
    sessionSignal?.throwIfAborted();
    state.authenticated = true;
    let identity = await verifyCloudProperty(page, { propertyCode: property.landingPropertyCode, tenantId: property.expectedTenant });
    if (!identity.observedName) identity.observedName = secret.expectedPropertyName;
    if (property.propertyCode !== property.landingPropertyCode) {
      identity = await switchCloudProperty(page, { propertyCode: property.propertyCode,
        landingPropertyCode: property.landingPropertyCode, tenantId: property.expectedTenant });
    }
    state.verified = true;
    state.identity = Object.freeze({ ...identity, landingPropertyCode: property.landingPropertyCode });
    sessionSignal?.throwIfAborted();
    if (startScreen !== 'BSSTRT') {
      if (startScreen === 'OSRESV') await openGuestStayScreen(page);
      else await openStay360(page);
      const current = await verifyCloudProperty(page, { propertyCode: property.propertyCode, tenantId: property.expectedTenant });
      identity = { ...current, observedName: identity.observedName ?? current.observedName };
      state.identity = Object.freeze({ ...identity, landingPropertyCode: property.landingPropertyCode });
    }
    sessionSignal?.throwIfAborted();
    result = await runUntilAborted(async () => {
      await leaseState?.assertRunLive?.();
      operationTask = Promise.resolve().then(() => credentialScope.run(lease, () => operation(page, Object.freeze({ ...identity,
        landingPropertyCode: property.landingPropertyCode }), Object.freeze({ credentialVersionHmacSha256, signal: sessionSignal }))));
      return operationTask;
    }, sessionSignal);
  } catch (error) {
    failed = true;
    if (sessionSignal?.aborted) failure = sessionSignal.reason;
    else {
      const message = String(error?.message ?? 'HMS_SESSION_FAILED');
      const safe = [secret?.password, secret?.username, secret?.loginUrl].filter(Boolean)
        .reduce((text, value) => text.replaceAll(value, '[withheld]'), message)
        .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?[withheld]')
        .replace(/\b(cookie|set-cookie|authorization|requesttoken|csrftckt)\s*[:=]\s*[^\s,;]+/gi, '$1=[withheld]');
      failure = new Error(safe);
    }
  } finally {
    sessionSignal?.removeEventListener('abort', onAbort);
    await abortClose;
    await close();
    if (operationTask) {
      try {
        await Promise.race([operationTask.catch(() => undefined), delay(30_000, undefined, { ref: false }).then(() => {
          throw new Error('SAVE_CALLBACK_DRAIN_UNCONFIRMED');
        })]);
      } catch (error) { callbacksDrained = false; cleanupError ??= error; }
    }
    if (writerIdentity) {
      try {
        writerGroupGone = await waitForOwnedWriterGroupGone(writerIdentity);
        if (!writerGroupGone) cleanupError ??= new Error('HMS_SESSION_CLEANUP_FAILED');
      } catch (error) { cleanupError ??= error; }
    }
    if (resourceCloseError && !(writerIdentity && writerGroupGone && callbacksDrained)) cleanupError ??= resourceCloseError;
    if (writerIdentity && writerGroupGone && callbacksDrained) {
      closedWriters.add(writerKey(writerIdentity));
      if (closedWriters.size > 4096) closedWriters.delete(closedWriters.values().next().value);
    }
    if (credentialWriterHeld && writerGroupGone && callbacksDrained) {
      try { releaseCredentialWriter(propertyCode, writerIdentity); }
      catch (error) { cleanupError ??= error; }
    }
    if (writerIdentity && cleanupError) for (const alias of aliases) holdCloudWriter(propertyCode, alias, writerIdentity);
    if (cleanupError) {
      if (lease) retainedLeases.add(lease);
    } else {
      if (borrowed) leaseState.borrowers -= 1;
      if (ownedLease) try { await lease.release(); } catch (error) { cleanupError = error; }
    }
  }
  if (cleanupError) throw cleanupError;
  if (failed) throw failure;
  return result;
}
