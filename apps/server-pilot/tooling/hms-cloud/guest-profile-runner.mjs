// Labtest by default; real-guest writes require trusted server callbacks.
// Attempt files are write-once: an incomplete file is a hold, not permission to retry.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createGuestProfile as nativeCreate, prepareGuestProfile as nativePrepare, readGuestProfile as nativeRead,
  listGuestProfileCreationOptions as nativeListOptions, hasExtendedProfileFields, matchesProfileReadback,
  matchesProfileReview, profileBusinessFields, profileInputIssue, profilePreviewDigest, profileReviewDigest,
} from './guest-profile-create.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validAttempt = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cleanIntent = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const intentKey = fields => hash(['HRCEN', ...['firstName', 'lastName', 'mobile', 'email'].map(key => cleanIntent(fields[key]))]);
const own = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).every(key => keys.includes(key));
const MAX_JOURNAL_RECORD_BYTES = 4 * 1024 * 1024;

async function privateDirectory(path) {
  if (typeof path !== 'string' || !path || !path.startsWith('/')) throw new Error('PROFILE_JOURNAL_PATH_INVALID');
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const canonical = await realpath(absolute);
  const stat = await lstat(absolute);
  if (canonical !== absolute || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('PROFILE_JOURNAL_DIRECTORY_UNSAFE');
  }
  // Never store personal data or dispatch records in any Git worktree.
  for (let dir = canonical; ; dir = dirname(dir)) {
    try { await lstat(join(dir, '.git')); throw new Error('PROFILE_JOURNAL_IN_GIT'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(dir) === dir) break;
  }
  return canonical;
}

async function syncDir(dir) {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeOnce(dir, name, value) {
  const data = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(data) > MAX_JOURNAL_RECORD_BYTES) throw new Error('PROFILE_JOURNAL_RECORD_TOO_LARGE');
  const handle = await open(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  await syncDir(dir);
}

async function readRecord(dir, name) {
  let handle;
  try {
    handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > MAX_JOURNAL_RECORD_BYTES) throw new Error('PROFILE_JOURNAL_CORRUPT');
    const data = await handle.readFile('utf8');
    if (!data.endsWith('\n')) throw new Error('PROFILE_JOURNAL_CORRUPT');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PROFILE_JOURNAL_CORRUPT');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('PROFILE_JOURNAL_CORRUPT');
  } finally { await handle?.close(); }
}

const file = (attemptKey, suffix) => `attempt-${attemptKey}-${suffix}.json`;
const intentFile = key => `intent-${key}.json`;
const successorFile = (key, previous) => `intent-${key}-after-${previous}.json`;
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function intentChain(dir, key) {
  const root = await readRecord(dir, intentFile(key));
  if (!root) return [];
  if (root.version !== 1 || root.intentKey !== key || !validHash(root.attemptKey)) throw new Error('PROFILE_JOURNAL_CORRUPT');
  const chain = [root.attemptKey];
  while (chain.length <= 1000) {
    const previous = chain.at(-1);
    const next = await readRecord(dir, successorFile(key, previous));
    if (!next) return chain;
    if (next.version !== 1 || next.intentKey !== key || next.previous !== previous ||
        !validHash(next.attemptKey) || !validHash(next.evidenceDigest) || chain.includes(next.attemptKey)) {
      throw new Error('PROFILE_JOURNAL_CORRUPT');
    }
    chain.push(next.attemptKey);
  }
  throw new Error('PROFILE_JOURNAL_CORRUPT');
}

async function readAttempt(dir, attemptKey) {
  const names = ['claim', 'initial', 'initial-response', 'confirm', 'confirm-response', 'result', 'reconcile-claim', 'reconcile'];
  const parts = {};
  for (const name of names) parts[name] = await readRecord(dir, file(attemptKey, name));
  const claim = parts.claim;
  if (!claim || ![1, 2].includes(claim.version) || !validAttempt(claim.attemptId) || hash(claim.attemptId) !== attemptKey ||
      !claim.fields || !same(profileBusinessFields({ guest: Object.fromEntries(
        Object.entries(claim.fields).filter(([key]) => !['status', 'consent'].includes(key))) }), claim.fields) ||
      typeof claim.previewDigest !== 'string' ||
      (claim.version === 1 && (hasExtendedProfileFields(claim.fields) || claim.previewDigest !== profilePreviewDigest(claim.fields, claim.confirmDuplicateName))) ||
      (claim.version === 2 && (!matchesProfileReview(claim.review, claim.fields, claim.confirmDuplicateName) ||
        claim.previewDigest !== profileReviewDigest(claim.review))) ||
      claim.intentKey !== intentKey(claim.fields) || typeof claim.confirmDuplicateName !== 'boolean') throw new Error('PROFILE_JOURNAL_CORRUPT');
  const chain = await intentChain(dir, claim.intentKey);
  if (chain.length && !chain.includes(attemptKey)) {
    // An attempt that lost an intent race is a permanent no-dispatch result.
    if (!parts.result || parts.result.issue !== 'PROFILE_INTENT_HELD' || parts.initial || parts.confirm) throw new Error('PROFILE_INTENT_HELD');
  } else if (!chain.length && (parts.initial || parts.confirm)) throw new Error('PROFILE_JOURNAL_CORRUPT');
  for (const [phase, response] of [['initial', 'initial-response'], ['confirm', 'confirm-response']]) {
    if (parts[phase] && (parts[phase].phase !== phase || parts[phase].attemptKey !== attemptKey)) throw new Error('PROFILE_JOURNAL_CORRUPT');
    const record = parts[response];
    if (record && (!parts[phase] || record.phase !== phase || record.attemptKey !== attemptKey ||
        typeof record.success !== 'boolean' || typeof record.question !== 'boolean' ||
        !(record.nativeId === null || /^\d+$/.test(record.nativeId)))) throw new Error('PROFILE_JOURNAL_CORRUPT');
  }
  if (parts.confirm && (!claim.confirmDuplicateName || !parts['initial-response']?.question)) throw new Error('PROFILE_JOURNAL_CORRUPT');
  if (parts['reconcile-claim'] && (parts['reconcile-claim'].version !== 1 ||
      parts['reconcile-claim'].attemptKey !== attemptKey)) throw new Error('PROFILE_JOURNAL_CORRUPT');
  if (parts.reconcile && (!parts['reconcile-claim'] || parts.reconcile.outcome !== 'created')) throw new Error('PROFILE_JOURNAL_CORRUPT');
  const successful = parts['confirm-response']?.success ? parts['confirm-response'] : parts['initial-response']?.success ? parts['initial-response'] : null;
  for (const result of [parts.result, parts.reconcile]) {
    if (result && (result.attemptId !== claim.attemptId || typeof result.outcome !== 'string')) throw new Error('PROFILE_JOURNAL_CORRUPT');
    if (result?.nativeId != null && !/^\d+$/.test(result.nativeId)) throw new Error('PROFILE_JOURNAL_CORRUPT');
    if (result?.outcome === 'created' && (!successful?.nativeId || result.nativeId !== successful.nativeId ||
        !matchesProfileReadback(result.readback, claim.fields, successful.nativeId, claim.review))) throw new Error('PROFILE_JOURNAL_CORRUPT');
    if (result?.outcome === 'confirmation_required' && (!parts['initial-response']?.question || parts.confirm)) {
      throw new Error('PROFILE_JOURNAL_CORRUPT');
    }
  }
  return { ...parts, successful };
}

function held(attemptId, parts, issue = 'PROFILE_RECONCILIATION_REQUIRED') {
  const response = parts?.['confirm-response'] || parts?.['initial-response'];
  const phase = parts?.confirm ? 'confirm_distinct' : parts?.initial ? 'initial' : null;
  return { outcome: 'reconciliation_required', issue, attemptId, phase,
    dispatched: parts ? Boolean(parts.initial || parts.confirm) : null,
    nativeId: response?.nativeId ?? parts?.result?.nativeId ?? null };
}

// The native duplicate question is an explicit no-create response. It is safe
// only before any distinct-confirmation dispatch, with no returned profile ID.
function duplicateDeclined(parts) {
  const response = parts['initial-response'], result = parts.result;
  return parts.claim.confirmDuplicateName === false && Boolean(parts.initial) && !parts.confirm &&
    !parts['confirm-response'] && response?.status === 200 && response.success === false &&
    response.question === true && response.nativeId === null && result?.outcome === 'confirmation_required' &&
    result.issue === 'PROFILE_NAME_ALREADY_EXISTS' && result.dispatched === true && result.nativeId == null;
}

// A broken record must stay held, but intact response records can still tell an
// operator which ID to investigate. They do not authorize reconciliation.
async function partialHeld(dir, attemptKey, attemptId, issue) {
  let phase = null, nativeId = null;
  for (const name of ['confirm', 'initial']) {
    try {
      const dispatch = await readRecord(dir, file(attemptKey, name));
      if (!phase && dispatch?.attemptKey === attemptKey && dispatch.phase === name) phase = name === 'confirm' ? 'confirm_distinct' : 'initial';
    } catch { /* A different intact record may still contain useful evidence. */ }
    try {
      const response = await readRecord(dir, file(attemptKey, `${name}-response`));
      if (!nativeId && response?.attemptKey === attemptKey && response.phase === name && /^\d+$/.test(response.nativeId ?? '')) {
        nativeId = response.nativeId;
      }
    } catch { /* A different intact record may still contain useful evidence. */ }
  }
  try {
    const result = await readRecord(dir, file(attemptKey, 'result'));
    if (!nativeId && result?.attemptId === attemptId && /^\d+$/.test(result.nativeId ?? '')) nativeId = result.nativeId;
  } catch { /* Keep the incomplete record held. */ }
  return { outcome: 'reconciliation_required', issue, attemptId, phase, dispatched: phase ? true : null, nativeId };
}

/** Configuration is trusted infrastructure; tool input is data, never authority. */
export function createGuestProfileRunner({ runtimeDir = join(homedir(), '.nava-hms-runtime', 'guest-profile'),
  dependencies = {}, sessionOptions = {}, verifyNoCreate, authorizeStaffWrite, dispatchStaffWrite } = {}) {
  if (verifyNoCreate !== undefined && typeof verifyNoCreate !== 'function') throw new TypeError('PROFILE_VERIFIER_INVALID');
  if (authorizeStaffWrite !== undefined && typeof authorizeStaffWrite !== 'function') throw new TypeError('PROFILE_AUTHORIZER_INVALID');
  if (dispatchStaffWrite !== undefined && typeof dispatchStaffWrite !== 'function') throw new TypeError('PROFILE_DISPATCH_AUTHORIZER_INVALID');
  const prepare = dependencies.prepareGuestProfile ?? nativePrepare;
  const create = dependencies.createGuestProfile ?? nativeCreate;
  const read = dependencies.readGuestProfile ?? nativeRead;
  const listOptions = dependencies.listGuestProfileCreationOptions ?? nativeListOptions;
  let dirPromise;
  const directory = () => dirPromise ??= privateDirectory(runtimeDir);

  async function prepareGuestProfile(input) {
    if (!profileBusinessFields(input)) return { outcome: 'needs_input', issue: profileInputIssue(input) };
    return prepare(input, sessionOptions);
  }

  async function createGuestProfile(input) {
    if (!own(input, ['propertyCode', 'guest', 'confirmDuplicateName', 'expectedPreviewDigest', 'expectedReview', 'attemptId', 'retryOfAttemptId']) ||
        !validAttempt(input.attemptId) || (input.retryOfAttemptId != null && !validAttempt(input.retryOfAttemptId))) {
      return { outcome: 'not_dispatched', issue: 'PROFILE_ATTEMPT_INPUT_INVALID', dispatched: false };
    }
    const { attemptId, retryOfAttemptId, ...business } = input;
    const fields = profileBusinessFields(business);
    if (!fields) {
      const issue = profileInputIssue(business);
      if (issue !== 'GUEST_NAME_AND_MOBILE_REQUIRED') return { outcome: 'needs_input', issue, attemptId, dispatched: false };
    }
    const realGuest = fields && (fields.firstName !== 'Proof' || fields.lastName !== 'Labtest');
    if (!fields || (realGuest && (!authorizeStaffWrite || !dispatchStaffWrite))) {
      return { outcome: 'not_dispatched', issue: 'PROFILE_LABTEST_ONLY', attemptId, dispatched: false };
    }
    const confirmDuplicateName = business.confirmDuplicateName === true;
    const extended = hasExtendedProfileFields(fields);
    if (extended && !matchesProfileReview(business.expectedReview, fields, confirmDuplicateName)) {
      return { outcome: 'review_required', issue: 'PROFILE_PREVIEW_CHANGED', attemptId, dispatched: false };
    }
    const previewDigest = extended ? profileReviewDigest(business.expectedReview) : profilePreviewDigest(fields, confirmDuplicateName);
    if (business.expectedPreviewDigest !== previewDigest) return { outcome: 'review_required', issue: 'PROFILE_PREVIEW_CHANGED', attemptId, dispatched: false };
    let dir;
    try { dir = await directory(); } catch { return { outcome: 'not_dispatched', issue: 'PROFILE_JOURNAL_UNAVAILABLE', attemptId, dispatched: false }; }
    const attemptKey = hash(attemptId), key = intentKey(fields);
    const claim = { version: extended ? 2 : 1, attemptId, fields, confirmDuplicateName, previewDigest, intentKey: key,
      ...(extended && { review: structuredClone(business.expectedReview) }) };
    try {
      await writeOnce(dir, file(attemptKey, 'claim'), claim);
    } catch (error) {
      if (error.code !== 'EEXIST') return held(attemptId, null, 'PROFILE_JOURNAL_UNAVAILABLE');
      try {
        const prior = await readAttempt(dir, attemptKey);
        if (!same(prior.claim, claim)) return { outcome: 'review_required', issue: 'PROFILE_ATTEMPT_CHANGED', attemptId, dispatched: false };
        if (prior.reconcile) return prior.reconcile;
        if (prior.result && prior.result.outcome !== 'uncertain') return prior.result;
        return held(attemptId, prior);
      } catch { return partialHeld(dir, attemptKey, attemptId, 'PROFILE_JOURNAL_CORRUPT'); }
    }
    try {
      // A reviewed retry must point to an existing held intent, never establish a new one.
      if (retryOfAttemptId) {
        const conflict = new Error('PROFILE_INTENT_HELD');
        conflict.code = 'EEXIST';
        throw conflict;
      }
      await writeOnce(dir, intentFile(key), { version: 1, intentKey: key, attemptKey });
    } catch (error) {
      let replaced = false;
      if (error.code === 'EEXIST' && retryOfAttemptId && verifyNoCreate) {
        try {
          const chain = await intentChain(dir, key);
          const previous = chain.at(-1);
          const prior = await readAttempt(dir, previous);
          if (prior.claim.attemptId === retryOfAttemptId && prior.result && prior.result.outcome !== 'created' &&
              !prior.successful && !prior.result.nativeId && !prior['initial-response']?.nativeId && !prior['confirm-response']?.nativeId) {
            const proof = await verifyNoCreate(Object.freeze({ attemptId: retryOfAttemptId,
              fields: Object.freeze({ ...prior.claim.fields }), result: structuredClone(prior.result),
              nextAttemptId: attemptId, nextPreviewDigest: previewDigest,
              noDispatchRecorded: !prior.initial && !prior.confirm, duplicateDeclined: duplicateDeclined(prior) }));
            if (proof?.outcome === 'no_create' && validHash(proof.evidenceDigest) &&
                (await intentChain(dir, key)).at(-1) === previous) {
              await writeOnce(dir, successorFile(key, previous), { version: 1, intentKey: key,
                previous, attemptKey, evidenceDigest: proof.evidenceDigest });
              replaced = true;
            }
          }
        } catch { /* A partial or competing reconciliation remains a hold. */ }
      }
      if (!replaced) {
        const result = error.code === 'EEXIST'
          ? { outcome: 'not_dispatched', issue: 'PROFILE_INTENT_HELD', attemptId, dispatched: false }
          : held(attemptId, null, 'PROFILE_JOURNAL_UNAVAILABLE');
        try { await writeOnce(dir, file(attemptKey, 'result'), result); } catch { /* Preserve both holds. */ }
        return result;
      }
    }
    const observed = { phase: null, dispatched: false, nativeId: null };
    const authorized = context => context.previewDigest === previewDigest && context.confirmDuplicateName === confirmDuplicateName &&
      same(context.fields, fields) && (!extended || same(context.review, claim.review)) &&
      (context.phase === 'initial' || context.phase === 'confirm_distinct' && confirmDuplicateName);
    const dispatchCandidate = async (context, proceed) => {
      if (!authorized(context)) throw new Error('PROFILE_AUTHORIZATION_MISMATCH');
      const phase = context.phase === 'initial' ? 'initial' : 'confirm';
      if (phase === 'confirm') {
        const initial = await readRecord(dir, file(attemptKey, 'initial-response'));
        if (!initial?.question || initial.attemptKey !== attemptKey) throw new Error('PROFILE_CONFIRMATION_UNVERIFIED');
      }
      await writeOnce(dir, file(attemptKey, phase), { version: 1, attemptKey, phase });
      observed.phase = context.phase;
      const dispatch = () => {
        observed.dispatched = true; // The request may leave as soon as proceed is called.
        return proceed();
      };
      return dispatchStaffWrite ? dispatchStaffWrite(Object.freeze({ ...context, attemptId }), dispatch) : dispatch();
    };
    const recordResponse = async (context, response) => {
      if (!authorized(context)) throw new Error('PROFILE_AUTHORIZATION_MISMATCH');
      const phase = context.phase === 'initial' ? 'initial' : 'confirm';
      observed.nativeId = response.nativeId ?? observed.nativeId;
      await writeOnce(dir, file(attemptKey, `${phase}-response`), { version: 1, attemptKey, phase, ...response });
    };
    let result;
    try {
      result = await create(business, { ...sessionOptions, attemptId, authorizeCandidate: async context =>
        authorized(context) && (!authorizeStaffWrite || await authorizeStaffWrite(Object.freeze({ ...context, attemptId })) === true),
        dispatchCandidate, recordResponse });
    } catch { result = { outcome: 'uncertain', issue: 'PROFILE_EXECUTION_FAILED', attemptId }; }
    result = { ...result, attemptId, phase: result.phase ?? observed.phase,
      dispatched: result.dispatched ?? observed.dispatched, nativeId: result.nativeId ?? observed.nativeId };
    try {
      await writeOnce(dir, file(attemptKey, 'result'), result);
      // Validate before returning or replaying a result, including dependency failures.
      const saved = await readAttempt(dir, attemptKey);
      if (saved.result.outcome === 'uncertain') return { ...held(attemptId, saved), ...saved.result,
        nativeId: saved.result.nativeId ?? saved.successful?.nativeId ?? null };
      return { ...saved.result, noDispatchRecorded: !saved.initial && !saved.confirm, duplicateDeclined: duplicateDeclined(saved) };
    } catch {
      let saved;
      try { saved = await readAttempt(dir, attemptKey); } catch { /* An incomplete record remains a hold. */ }
      const recovery = saved ? held(attemptId, saved, 'PROFILE_JOURNAL_UNAVAILABLE')
        : await partialHeld(dir, attemptKey, attemptId, 'PROFILE_JOURNAL_UNAVAILABLE');
      return { ...recovery, phase: recovery.phase ?? observed.phase,
        dispatched: recovery.dispatched === true || observed.dispatched ? true : recovery.dispatched,
        nativeId: recovery.nativeId ?? observed.nativeId };
    }
  }

  async function readGuestProfile(input) {
    if (!own(input, ['nativeId', 'propertyCode', 'attemptId']) || input.attemptId != null && !validAttempt(input.attemptId)) {
      return { outcome: 'input_gap', issue: 'PROFILE_ID_REQUIRED' };
    }
    const { attemptId, ...business } = input;
    if (!attemptId) return read(business, sessionOptions);
    let dir, parts;
    const attemptKey = hash(attemptId);
    try { dir = await directory(); parts = await readAttempt(dir, attemptKey); }
    catch { return dir ? partialHeld(dir, attemptKey, attemptId, 'PROFILE_JOURNAL_CORRUPT')
      : held(attemptId, null, 'PROFILE_JOURNAL_CORRUPT'); }
    if (!parts.successful?.nativeId || business.nativeId !== parts.successful.nativeId ||
        business.propertyCode != null && business.propertyCode !== 'HRCEN') return held(attemptId, parts);
    const readback = await read(business, sessionOptions);
    if (!matchesProfileReadback(readback, parts.claim.fields, parts.successful.nativeId, parts.claim.review)) return { ...held(attemptId, parts), readback };
    if (parts.reconcile) return { ...readback, reconciliation: parts.reconcile };
    if (parts.result?.outcome === 'created') return { ...readback, reconciliation: parts.result };
    const result = { outcome: 'created', attemptId, phase: parts.confirm ? 'confirm_distinct' : 'initial',
      dispatched: true, nativeId: parts.successful.nativeId, readback };
    try {
      // A prior process may have stopped after its durable claim. A fresh,
      // matching read can finish reconciliation without sending another Save.
      if (!parts['reconcile-claim']) await writeOnce(dir, file(attemptKey, 'reconcile-claim'), { version: 1, attemptKey });
      await writeOnce(dir, file(attemptKey, 'reconcile'), result);
      return { ...readback, reconciliation: result };
    } catch { return { ...held(attemptId, parts, 'PROFILE_RECONCILIATION_JOURNAL_UNAVAILABLE'), readback }; }
  }

  // Inspection is read-only even when the database claim exists but no runner
  // journal was established. It never creates an attempt or sends Save.
  async function inspectGuestProfileAttempt(input) {
    if (!own(input, ['attemptId', 'propertyCode', 'guest', 'confirmDuplicateName', 'expectedPreviewDigest', 'expectedReview']) ||
        !validAttempt(input.attemptId)) return { outcome: 'input_gap', issue: 'PROFILE_ATTEMPT_INPUT_INVALID' };
    const { attemptId, ...business } = input;
    let dir;
    const key = hash(input.attemptId);
    try {
      dir = await directory();
      if (!await readRecord(dir, file(key, 'claim'))) return held(input.attemptId, null, 'PROFILE_ATTEMPT_NOT_FOUND');
      const parts = await readAttempt(dir, key);
      if (Object.keys(business).length && (!same(profileBusinessFields(business), parts.claim.fields) ||
          business.expectedPreviewDigest !== parts.claim.previewDigest ||
          (business.confirmDuplicateName === true) !== parts.claim.confirmDuplicateName ||
          (hasExtendedProfileFields(parts.claim.fields) && !same(business.expectedReview, parts.claim.review)))) {
        return { outcome: 'review_required', issue: 'PROFILE_ATTEMPT_CHANGED', attemptId, dispatched: false };
      }
      if (parts.reconcile) return parts.reconcile;
      if (parts.result && parts.result.outcome !== 'uncertain') {
        return { ...parts.result, noDispatchRecorded: !parts.initial && !parts.confirm, duplicateDeclined: duplicateDeclined(parts) };
      }
      return held(input.attemptId, parts);
    } catch { return dir ? partialHeld(dir, key, input.attemptId, 'PROFILE_JOURNAL_CORRUPT')
      : held(input.attemptId, null, 'PROFILE_JOURNAL_UNAVAILABLE'); }
  }

  return Object.freeze({ listGuestProfileCreationOptions: input => listOptions(input, sessionOptions),
    prepareGuestProfile, createGuestProfile, readGuestProfile, inspectGuestProfileAttempt });
}
