// Guest-master preparation and guarded creation on a dedicated HRCEN session.
import { createHash } from 'node:crypto';
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { shouldAbortReadOnlyRequest } from '../playwright-quote/hms-read-only-guard.mjs';
import { prepareGuardedContext, isGuardedPage } from './pre-navigation-context-guard.mjs';
import { guestLookupMayRequest, fulfillGuestLookupRequest } from './pane-guest-search.mjs';
import { openNewGuestStay } from './lookup.mjs';
import { collectHmsStorageStateSecretValues } from '../../src/hms/trace-privacy.ts';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const PROPERTY = 'HRCEN';
const clean = value => typeof value === 'string' ? value.trim() : '';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const EXTRA_FIELDS = ['titleCode', 'phoneNumber', 'phoneTypeCode', 'emailTypeCode'];
const OPTION_FIELDS = Object.freeze({ title: 'nametitle', phoneType: 'phonenumbertypecode', emailType: 'emailtypecode' });
const issue = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(String(error?.message || ''))
  ? error.message : error?.name === 'TimeoutError' ? 'PROFILE_UI_TIMED_OUT' : 'PROFILE_PREPARATION_FAILED';

export function profileInputIssue(input) {
  const guest = input?.guest;
  if (guest && typeof guest === 'object' && !Array.isArray(guest)) {
    if (EXTRA_FIELDS.some(key => Object.hasOwn(guest, key) && (typeof guest[key] !== 'string' || !clean(guest[key])))) {
      return 'PROFILE_EXTRA_FIELD_INVALID';
    }
    if (guest.phoneTypeCode && !clean(guest.phoneNumber)) return 'PROFILE_PHONE_REQUIRED_FOR_TYPE';
    if (guest.emailTypeCode && !clean(guest.email)) return 'PROFILE_EMAIL_REQUIRED_FOR_TYPE';
  }
  return 'GUEST_NAME_AND_MOBILE_REQUIRED';
}

export function profileBusinessFields(input) {
  const guest = input?.guest;
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['propertyCode', 'guest', 'confirmDuplicateName', 'expectedPreviewDigest', 'expectedReview'].includes(key)) ||
      (input.propertyCode != null && input.propertyCode !== PROPERTY) ||
      (input.confirmDuplicateName != null && typeof input.confirmDuplicateName !== 'boolean') ||
      !guest || typeof guest !== 'object' || Array.isArray(guest) ||
      Object.keys(guest).some(key => !['firstName', 'lastName', 'mobile', 'email', ...EXTRA_FIELDS].includes(key))) return null;
  if (guest.email != null && typeof guest.email !== 'string') return null;
  const suppliedExtras = EXTRA_FIELDS.filter(key => Object.hasOwn(guest, key));
  if ((!suppliedExtras.length && Object.hasOwn(input, 'expectedReview')) || suppliedExtras.some(key =>
    typeof guest[key] !== 'string' || !clean(guest[key]))) return null;
  const fields = { firstName: clean(guest.firstName), lastName: clean(guest.lastName),
    mobile: clean(guest.mobile), email: guest.email == null ? '' : clean(guest.email) };
  for (const key of suppliedExtras) fields[key] = clean(guest[key]);
  if (['firstName', 'lastName', 'mobile'].some(key => !fields[key]) ||
      (fields.phoneTypeCode && !fields.phoneNumber) || (fields.emailTypeCode && !fields.email) ||
      Object.values(fields).some(value => value.length > 200 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) return null;
  return { ...fields, status: 'ACTIVE', consent: false };
}

export function profilePreviewDigest(fields, confirmDuplicateName) {
  return hash({ property: PROPERTY, fields, confirmDuplicateName: confirmDuplicateName === true });
}

export const hasExtendedProfileFields = fields => EXTRA_FIELDS.some(key => Object.hasOwn(fields ?? {}, key));
export const profileReviewDigest = review => hash(review);

export function matchesProfileReview(review, fields, confirmDuplicateName) {
  const effective = review?.effective;
  if (!hasExtendedProfileFields(fields) || !review || typeof review !== 'object' || Array.isArray(review) ||
      !same(Object.keys(review).sort(), ['confirmDuplicateName', 'effective', 'fields', 'propertyCode', 'version'].sort()) ||
      review.version !== 2 || review.propertyCode !== PROPERTY || review.confirmDuplicateName !== (confirmDuplicateName === true) ||
      !same(review.fields, fields) || !effective || typeof effective !== 'object' || Array.isArray(effective) ||
      !same(Object.keys(effective).sort(), ['title', 'phoneNumber', 'phoneType', 'emailType'].sort()) ||
      typeof effective.phoneNumber !== 'string') return false;
  for (const key of ['title', 'phoneType', 'emailType']) {
    const choice = effective[key];
    if (!choice || typeof choice !== 'object' || Array.isArray(choice) ||
        !same(Object.keys(choice).sort(), ['code', 'label']) || typeof choice.code !== 'string' ||
        typeof choice.label !== 'string' || Boolean(choice.code) !== Boolean(choice.label)) return false;
  }
  return (!fields.titleCode || fields.titleCode === effective.title.code) &&
    effective.phoneNumber === (fields.phoneNumber || '') &&
    (!fields.phoneTypeCode || fields.phoneTypeCode === effective.phoneType.code) &&
    (!fields.emailTypeCode || fields.emailTypeCode === effective.emailType.code);
}

function unique(params) {
  const keys = [...params.keys()].map(key => key.toLowerCase());
  return new Set(keys).size === keys.length;
}

function profileSaveMatches(request, fields, confirmed, review) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
    const required = { SYSTEM_FUNCTION_NAME: 'FSGSPF', USER_FUNCTION_NAME: 'FSGSPF', CURRENT_TAB_NAME: 'HDR',
      firstname: fields.firstName, lastname: fields.lastName, mobilenumber: fields.mobile, emailaddress: fields.email,
      profilestatuscode: 'ACTIVE', profileid: '', recordid: '',
      confirmnewguestprofile: confirmed ? 'confirmed' : '', confirminactiveguestprofile: '' };
    if (hasExtendedProfileFields(fields)) {
      if (!matchesProfileReview(review, fields, review?.confirmDuplicateName)) return false;
      Object.assign(required, { nametitle: review.effective.title.code, phonenumber: review.effective.phoneNumber,
        phonenumbertypecode: review.effective.phoneType.code, emailtypecode: review.effective.emailType.code });
    }
    const matches = (params, name, expected) => {
      const values = [...params].filter(([key]) => key.toLowerCase() === name.toLowerCase());
      return values.length === 1 && values[0][1] === expected;
    };
    const compatible = (params, name, expected) => {
      const values = [...params].filter(([key]) => key.toLowerCase() === name.toLowerCase());
      return values.length === 0 || values.length === 1 && values[0][1] === expected;
    };
    return request.method() === 'POST' && url.origin === ORIGIN && !url.username && !url.password && !url.hash &&
      decodeURIComponent(url.pathname) === url.pathname &&
      url.pathname === '/web/base/FSGSPF.HDR' && matches(url.searchParams, 'pageaction', 'SAVE') &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      Object.entries(required).every(([key, value]) => matches(body, key, value) && compatible(url.searchParams, key, value)) &&
      compatible(body, 'pageaction', 'SAVE') && compatible(body, 'action', 'SAVE') && compatible(url.searchParams, 'action', 'SAVE') &&
      [1, 2, 3, 4].every(index => {
        const entries = [...body].filter(([key]) => key.toLowerCase() === `guestoptin${index}`);
        return entries.length === 1 && ['', '0', 'false'].includes(entries[0][1].toLowerCase());
      }) &&
      [...body].filter(([key]) => /^guestoptin\d+$/i.test(key))
        .every(([, value]) => ['', '0', 'false'].includes(value.toLowerCase()));
  } catch { return false; }
}

function parseProfileResponse(text) {
  const json = text.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  return JSON.parse(json)?.pageData;
}

// The response can be malformed JavaScript or HTML, including session secrets.
// Never retain arbitrary source fragments or the parser's embedded source preview.
function profileParseFailureDiagnostics(text, response, error) {
  try {
    if (typeof text !== 'string') return null;
    const limit = 4 * 1024 * 1024;
    const byteLength = text.length > limit ? limit + 1 : Buffer.byteLength(text, 'utf8');
    let contentType = 'unknown';
    try {
      const headers = response.headers?.(), raw = headers?.['content-type'] ?? headers?.['Content-Type'];
      const mime = typeof raw === 'string' ? raw.split(';', 1)[0].trim().toLowerCase() : '';
      if (['application/json', 'text/json', 'text/html', 'application/javascript', 'text/javascript',
        'text/plain', 'application/xml', 'text/xml'].includes(mime)) contentType = mime;
      else if (mime) contentType = 'other';
    } catch { /* Missing headers are not evidence of a content type. */ }
    const sample = text.slice(0, 8192);
    const bodyKind = !sample.trim() ? 'empty'
      : /<\s*(?:!doctype\s+html|html|head|body|form)(?:\s|>)/i.test(sample) ? 'html'
        : /^\s*[\[{]/.test(sample) ? 'json_like'
          : /^\s*(?:var\s|let\s|const\s|function\s|(?:Ext|window|EAM)\.)/i.test(sample) ? 'javascript_like' : 'other';
    const message = error instanceof SyntaxError && typeof error.message === 'string' ? error.message : '';
    const match = /(?:^| )at position (\d+)(?: \(line (\d+) column (\d+)\))?$/.exec(message);
    const number = value => {
      const parsed = value == null ? null : Number(value);
      return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= limit ? parsed : null;
    };
    // These V8 messages have fixed text and a position, without a source preview.
    const safeMessage = /^(?:Unexpected end of JSON input|Unexpected non-whitespace character after JSON at position \d+(?: \(line \d+ column \d+\))?|(?:Expected property name or '}'|Expected double-quoted property name|Expected ':' after property name|Expected ',' or '}' after property value|Expected ',' or '\]' after array element|Unterminated string|Bad control character in string literal|Bad escaped character|Bad Unicode escape) in JSON at position \d+(?: \(line \d+ column \d+\))?)$/.test(message);
    const token = /^Unexpected token '(.)'/s.exec(message)?.[1];
    const safeToken = token != null && /[{}\[\],:;'\"<>\/\\=]/.test(token) ? token : null;
    const exception = safeMessage ? message : safeToken ? `Unexpected token '${safeToken}'` : null;
    const tokenCategory = token == null ? null : token === "'" ? 'single_quote' : token === '"' ? 'double_quote'
      : /[<>]/.test(token) ? 'angle_bracket' : /[A-Za-z]/.test(token) ? 'letter' : /[0-9]/.test(token) ? 'digit'
        : /\s/.test(token) ? 'whitespace' : /[{}]/.test(token) ? 'brace' : /[\[\]]/.test(token) ? 'bracket'
          : /[,;:]/.test(token) ? 'delimiter' : /[\/\\]/.test(token) ? 'slash' : token === '=' ? 'equals' : 'other';
    return { byteCount: Math.min(byteLength, limit), byteCountCapped: byteLength > limit, contentType, bodyKind,
      exception,
      exceptionOmitted: safeMessage ? null : 'parser_message_may_include_source',
      tokenCategory, positionBasis: 'normalized_json', position: number(match?.[1]),
      line: number(match?.[2]), column: number(match?.[3]),
      contextExcerpt: null, contextOmitted: 'malformed_source_may_contain_unlabelled_secrets' };
  } catch { return null; }
}

// Keep known session and request secrets in memory only, to mask them even when
// HMS displays a value without its credential label. Never journal this set.
async function profileDiagnosticSecrets(request) {
  let timer;
  try {
    const storage = await Promise.race([request.frame().page().context().storageState(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 1000); })]);
    const headers = request.headers();
    const pairs = [...new URL(request.url()).searchParams, ...new URLSearchParams(request.postData() || ''),
      ...Object.entries(headers)].map(([name, value]) => ({ name, value }));
    const cookies = String(headers.cookie || '').split(';').map(part => {
      const index = part.indexOf('=');
      return index < 0 ? null : { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() };
    }).filter(Boolean);
    const auth = /^\s*(?:bearer|basic)\s+(.+)$/i.exec(headers.authorization || '')?.[1];
    if (auth) pairs.push({ name: 'token', value: auth });
    const secrets = collectHmsStorageStateSecretValues({
      cookies: [...(storage.cookies || []), ...cookies],
      origins: [...(storage.origins || []), { localStorage: pairs }],
    });
    if (secrets.length > 128 || secrets.some(secret => secret.length > 1024)) return null;
    const variants = [...new Set(secrets.flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))]
      .filter(Boolean).sort((a, b) => b.length - a.length);
    if (variants.reduce((sum, value) => sum + value.length, 0) > 16384) return null;
    return variants.length ? new RegExp(variants.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : false;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function diagnosticCredentialField(field) {
  return typeof field === 'string' && /^(?:password|passwd|passcode|credential|secret|token|jwt|sid|cookie|set[_-]?cookie|authorization|proxy[_-]?authorization|authentication|auth(?:[_-]?(?:token|key))?|jsessionid|(?:session|access|refresh|request|csrf|id)[_-]?(?:token|key|id)|session|csrf[_-]?(?:ticket|tckt)|api[_-]?key|client[_-]?secret|x[_-](?:api[_-]?key|auth(?:entication)?[_-]?(?:token|key)?|access[_-]?token|refresh[_-]?token|csrf[_-]?token|session[_-]?(?:id|token)|id[_-]?token))$/i.test(field.split('.').at(-1).trim().replace(/\s+/g, '_'));
}

function diagnosticMessageText(value, secrets = false, fieldLabel = false, fields) {
  if (typeof value !== 'string' || value.length > 8192 || secrets === null) return null;
  let text = secrets ? value.replace(secrets, '[redacted]') : value;
  // Journal text, not HTML: angle-bracket field names and comparison values are
  // native validation evidence. Attribute-bearing markup can carry hidden values.
  text = text.replace(/<[A-Za-z][A-Za-z0-9:-]*\s+[^<>]*=\s*[^<>]*(?:>|$)/g, '')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
      catch { return '[redacted URL]'; }
    });
  if (fieldLabel && /^(?:[A-Za-z][A-Za-z0-9_-]*\.)*[A-Za-z][A-Za-z0-9_ -]*$/.test(value.trim()) &&
      diagnosticCredentialField(value)) return text.slice(0, 512);
  text = text.replace(/\b(set-cookie|cookie)(\s*[:=]\s*)[^\r\n]*/gi, '$1$2[redacted]')
    .replace(/\b(authorization|proxy[_-]authorization|authentication|auth|bearer|password|passwd|passcode|credential|secret|token|jwt|sid|jsessionid|session|(?:session|request|access|refresh|id)(?:[_-]|\s+)?(?:token|id|key)|csrf(?:[_-]|\s+)?(?:tckt|ticket|token)|api(?:[_-]|\s+)?key|client(?:[_-]|\s+)?secret|cookie)(["']?\s*[:=]\s*|\s+is(?:\s*[:=])?\s+)(?:(?:bearer|basic)\s+)?(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|<[^>\r\n]*(?:>|$)|[^\r\n,;}]+)/gi, '$1$2[redacted]')
    .replace(/\b((?:proxy[_-])?authorization)(\s+(?:bearer|basic)\s+)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/\b((?:proxy[_-])?authorization|authentication|auth|bearer|credential)(?:\s+(?:bearer|basic|token))?\s+(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;]+)/gi, '$1 [redacted]')
    .replace(/\b((?:session|request|access|refresh|id)(?:[_-]|\s+)?(?:token|id|key)|csrf(?:[_-]|\s+)?(?:tckt|ticket|token)|api(?:[_-]|\s+)?key|client(?:[_-]|\s+)?secret|password|passwd|passcode|secret|token|jwt|sid|jsessionid|session|cookie)\s+(?:(?:bearer|basic|token)\s+)?(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|<[^>\r\n]*(?:>|$)|[^\s,;]+)/gi, '$1 [redacted]');
  // Scrub contact/submitted values only in message content. Field labels and
  // diagnostic codes/handlers stay verbatim apart from credential masking.
  if (fields !== undefined) {
    text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi, '[redacted]');
    // Native dates/confirmation-shaped tokens are not generic phone evidence.
    // An explicitly submitted contact matching one is still scrubbed below.
    text = text.split(/(\b(?:\d{4}-\d{2}-\d{2}|\d{2}[-./]\d{2}[-./]\d{4}|\d{6,10}-\d{1,2})\b)/g)
      .map((part, index) => index % 2 ? part : part.replace(/\+?\d[\d .()/-]{5,}\d/g, '[redacted]')).join('');
    for (const name of ['firstName', 'lastName', 'mobile', 'phoneNumber', 'email']) {
      const submitted = fields?.[name];
      if (typeof submitted !== 'string' || !submitted) continue;
      const literal = submitted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(literal, 'gi'), '[redacted]');
    }
  }
  return text.slice(0, 512);
}

function profileValidationDetails(root, data, secrets, fields = {}) {
  const validation = [];
  const add = (source, value, field = null, nativeMessage = false) => {
    if (validation.length >= 20) return;
    const fieldName = field ?? value?.field ?? value?.fieldName;
    // Preserve the native credential label, but never its attached values.
    const credentialField = diagnosticCredentialField(fieldName);
    const message = typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value)
      ? value.msg ?? value.message ?? value.errorMessage ?? value.validationMessage ?? value.description : null;
    const entry = { source, field: diagnosticMessageText(fieldName, secrets, true),
      type: nativeMessage && !credentialField ? diagnosticMessageText(value?.type, secrets) : null,
      code: credentialField ? null : diagnosticMessageText(value?.code == null ? null : String(value.code), secrets),
      handler: nativeMessage && !credentialField ? diagnosticMessageText(value?.handler, secrets) : null,
      message: credentialField ? null : diagnosticMessageText(message, secrets, false, fields) };
    if (entry.field || entry.type || entry.code || entry.handler || entry.message) validation.push(entry);
  };
  for (const [source, object] of [['root', root], ['pageData', data]]) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    for (const key of ['messages', 'message', 'msg', 'error', 'errors', 'errorMessage', 'validationMessage', 'validationErrors', 'fieldErrors']) {
      const value = object[key], path = `${source}.${key}`;
      if (Array.isArray(value)) value.slice(0, 5).forEach(item => add(path, item, null, key === 'messages'));
      else if (value && typeof value === 'object') {
        add(path, value, null, key === 'messages');
        if (key === 'fieldErrors' || key === 'validationErrors') {
          let visited = 0;
          for (const field in value) {
            if (!Object.hasOwn(value, field)) continue;
            if (++visited > 10) break;
            add(path, value[field], field);
          }
        }
      } else add(path, value);
    }
  }
  return { validation };
}

function profileFailureDiagnostics(data, parseStatus, secrets, root, fields = {}) {
  const observable = parseStatus !== 'parse_failed';
  const dataObject = data !== null && typeof data === 'object' && !Array.isArray(data);
  const present = observable ? root === undefined ? data !== undefined : Object.hasOwn(root, 'pageData') : null;
  const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const successPresent = observable && dataObject ? Object.hasOwn(data, 'success') : null;
  const id = observable && dataObject ? String(data?.values?.profileid ?? '').trim() : null;
  const nativeIdExtractionStatus = id === null ? 'unobservable' : !id ? 'missing_or_empty'
    : /^\d+$/.test(id) ? 'numeric' : 'non_numeric';
  const messages = data?.messages;
  const items = Array.isArray(messages) ? messages.slice(0, 5) : [];
  return {
    version: 1, parseStatus, redactionContext: secrets === null ? 'unavailable' : 'available',
    pageData: { present, type: present ? type(data) : null },
    successField: { present: successPresent, type: successPresent ? type(data.success) : null },
    nativeIdExtractionStatus,
    nativeSuccess: data?.success === true ? true : data?.success === false ? false : null,
    messagesStatus: !observable || !dataObject ? 'unobservable'
      : Array.isArray(messages) ? 'array' : messages == null ? 'absent' : 'invalid',
    messageCount: Array.isArray(messages) ? Math.min(messages.length, 5) : null,
    messagesTruncated: Array.isArray(messages) && messages.length > 5,
    messages: items.map(message => {
      const field = message?.field ?? message?.fieldName;
      const credentialField = diagnosticCredentialField(field);
      const msg = credentialField ? null : diagnosticMessageText(typeof message === 'string' ? message : message?.msg ?? message?.message, secrets, false, fields);
      const numericCode = typeof message?.code === 'number' && Number.isFinite(message.code);
      const code = credentialField ? null : diagnosticMessageText(numericCode ? String(message.code) : message?.code, secrets);
      return { field: diagnosticMessageText(field, secrets, true),
        type: credentialField ? null : diagnosticMessageText(message?.type, secrets),
        code: numericCode && code === String(message.code) ? message.code : code,
        questionType: credentialField ? null : diagnosticMessageText(message?.questiontype, secrets),
        handler: credentialField ? null : diagnosticMessageText(message?.handler, secrets), msg, text: msg };
    }),
  };
}

async function recoverProfileFailureDiagnostics(text, secrets, fields) {
  const unavailable = { method: 'bounded_data_literal', status: 'unavailable' };
  if (typeof text !== 'string' || text.length > 2_000_000) return unavailable;
  let timer;
  try {
    const module = await Promise.race([import('./cancel-association-scope.mjs'),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
    const recovered = module?.parseAssociationResponse(text), data = recovered?.pageData;
    return recovered && typeof recovered === 'object' && !Array.isArray(recovered)
      ? { method: 'bounded_data_literal', status: 'parsed_for_diagnostics',
        evidence: { ...profileFailureDiagnostics(data, 'diagnostic_only', secrets, recovered, fields),
          ...profileValidationDetails(recovered, data, secrets, fields) } } : unavailable;
  } catch { return unavailable; }
  finally { clearTimeout(timer); }
}

async function boundedResponseText(response, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([response.text(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PROFILE_RESPONSE_TIMED_OUT')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function handleProfileSave(route, state) {
  const write = state.write, request = route.request();
  const confirmed = write.phase === 'confirm';
  let forwarded = false, pending;
  try {
    if (state.blocked || state.dialog || !['initial', 'confirm'].includes(write.phase) || !isGuardedPage(request.frame().page()) ||
        !profileSaveMatches(request, write.fields, confirmed, write.review)) throw new Error('PROFILE_SAVE_REQUEST_MISMATCH');
    const phase = confirmed ? 'confirm_distinct' : 'initial';
    write.lastPhase = phase;
    write.phase = 'authorizing';
    write.callbackDrained = false;
    const context = Object.freeze({ phase, previewDigest: write.previewDigest,
      confirmDuplicateName: write.confirmDuplicateName, fields: Object.freeze({ ...write.fields }),
      ...(write.review && { review: structuredClone(write.review) }) });
    if (await write.authorizeCandidate(context) !== true || state.blocked || state.dialog || write.phase !== 'authorizing') {
      throw new Error('PROFILE_SAVE_NOT_AUTHORIZED');
    }
    let used = false;
    const proceed = () => {
      if (used || state.blocked || state.dialog || write.phase !== 'authorizing' || !isGuardedPage(request.frame().page()) ||
          !profileSaveMatches(request, write.fields, confirmed, write.review)) throw new Error('PROFILE_SAVE_AUTHORITY_STALE');
      used = true;
      write.phase = 'waiting';
      write.dispatched = true;
      write.dispatchedPhases.push(phase);
      forwarded = true;
      pending = (async () => {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30_000 });
        const text = await boundedResponseText(response);
        let data, parseError, parseStatus = 'parse_failed';
        try {
          data = parseProfileResponse(text);
          parseStatus = data && typeof data === 'object' && !Array.isArray(data) ? 'parsed' : 'missing_page_data';
        } catch (error) { parseError = error; /* unknown until readback */ }
        const messages = data?.messages;
        const question = !confirmed && response.status() === 200 && data?.success === false &&
          Array.isArray(messages) && messages.length === 1 && messages[0].type === 'question' &&
          messages[0].questiontype === 'YesNo' && messages[0].handler === 'confirmNewGuestProfile' &&
          messages[0].msg === 'Profile name already exists. Continue?';
        const id = String(data?.values?.profileid ?? '').trim();
        write.response = { status: response.status(), success: response.status() === 200 && data?.success === true,
          nativeId: /^\d+$/.test(id) ? id : null, question };
        // Persist the response and any native ID before the browser receives it.
        const needsDiagnostics = write.fields.firstName === 'Proof' && write.fields.lastName === 'Labtest' &&
          (!write.response.success || !write.response.nativeId);
        write.diagnosticFailure = Boolean(needsDiagnostics && confirmed);
        if (needsDiagnostics) write.diagnosticSecrets = await profileDiagnosticSecrets(request);
        let diagnostics = null;
        if (needsDiagnostics) {
          try { diagnostics = profileFailureDiagnostics(data, parseStatus, write.diagnosticSecrets, undefined, write.fields); }
          catch { diagnostics = { version: 1, parseStatus, diagnosticCollection: 'unavailable' }; }
        }
        if (diagnostics && parseStatus === 'parse_failed') {
          write.parseFailed = true;
          const parseFailure = profileParseFailureDiagnostics(text, response, parseError);
          if (parseFailure) diagnostics.parseFailure = parseFailure;
        }
        await write.recordResponse(context, Object.freeze({ ...write.response, ...(diagnostics && { diagnostics }) }));
        // Retain only in memory, after the original response has been journaled.
        if (write.diagnosticFailure && typeof write.recordFailureDiagnostics === 'function') write.diagnosticSource = text;
        if (write.phase !== 'closed') write.phase = question ? 'question' : 'finished';
        await route.fulfill({ response });
        return true;
      })();
      return pending;
    };
    await write.dispatchCandidate(context, proceed);
    if (!used) throw new Error('PROFILE_SAVE_NOT_DISPATCHED');
    await pending;
    write.callbackDrained = true;
  } catch (error) {
    write.issue = forwarded || write.dispatched ? 'PROFILE_SAVE_UNCERTAIN' : issue(error);
    if (write.phase !== 'closed') write.phase = 'failed';
    if (pending) await pending.catch(() => {});
    try { await route.abort('blockedbyclient'); } catch { /* A dispatched request remains uncertain. */ }
  }
}

// Only observed navigation and blank/exact-ID master reads are
// admitted. The context never permits Save, confirmation, send or card routes.
function profileCreateReadMayRequest(request, state = {}) {
  try {
    const url = new URL(request.url()), method = request.method().toUpperCase();
    const postData = request.postData() || '', body = new URLSearchParams(postData);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash ||
        decodeURIComponent(url.pathname) !== url.pathname || !unique(url.searchParams) || !unique(body) ||
        shouldAbortReadOnlyRequest({ method, url: request.url(), postData })) return false;
    const hasWrite = params => [...params].some(([key, value]) =>
      /^(?:pageaction|action|autosave)$/i.test(key) && /^(?:save|delete|cancel|duplicate|insert|update|commit|create|submit|post|amend)$/i.test(value.trim()) ||
      /^(?:confirmnewguestprofile|confirminactiveguestprofile|newprofileclick|createinactiveprofileflag|savecctoprofile|savesettlementcctoprofile)$/i.test(key) &&
        !['', '0', 'false', '-'].includes(value.trim().toLowerCase()));
    if (hasWrite(url.searchParams) || hasWrite(body)) return false;
    if (guestLookupMayRequest({ method, url: request.url(), postData,
      contentType: request.headers()['content-type'] })) return true;
    // Native form initialization needs the static vault scripts (vcei). The
    // lookup predicate admits vetted asset GETs; vault/card actions still fail.
    if (/(?:save|delete|cancel|duplicate|confirmnew|send|card|vault|upload|checkin|checkout|amend)/i.test(url.pathname)) return false;
    if (method === 'GET') {
      if (['/', '/favicon.ico'].includes(url.pathname) && !url.search) return true;
      return url.pathname === '/web/base/loadmain' && url.searchParams.get('initpath') === 'FSGSPF' &&
        url.searchParams.get('SYSTEM_FUNCTION_NAME') === 'FSGSPF' &&
        url.searchParams.get('USER_FUNCTION_NAME') === 'FSGSPF' &&
        url.searchParams.get('popup') === 'TRUE' && url.searchParams.get('CURRENT_TAB_NAME') === 'HDR' &&
        url.searchParams.get('initparams') === 'startUpView=left' && Boolean(url.searchParams.get('requestToken'));
    }
    if (method !== 'POST' || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '')) return false;
    if (url.pathname === '/web/base/FSGSPF.HDR.ATTRIBUTEREFRESH') {
      const blank = ['profileid', 'recordid', 'nametitle', 'lastname', 'firstname', 'phonenumbertypecode',
        'phonenumber', 'mobilenumber', 'emailtypecode', 'emailaddress', 'newpassword', 'confirmnewpassword',
        'actions', 'submit', 'confirmnewguestprofile', 'confirminactiveguestprofile'];
      return !url.search && state.blankRefreshAllowed === true && request.frame() === state.newProfileFrame &&
        body.get('PKID') === '@[EMPTY]#' && body.get('pagemode') === 'display' &&
        body.get('ONLY_DATA_REQUIRED') === 'true' && blank.every(key => body.has(key) && body.get(key) === '');
    }
    if (['/web/base/FSGSPF.HDR.getPhoneTypeDetails', '/web/base/FSGSPF.HDR.getEmailTypeDetails'].includes(url.pathname)) {
      const gate = state.profileOptionGate;
      return !url.search && gate?.path === url.pathname && request.frame() === gate.frame &&
        Object.entries(gate.expected).every(([key, value]) => body.has(key) && body.get(key) === value);
    }
    const system = body.get('SYSTEM_FUNCTION_NAME'), user = body.get('USER_FUNCTION_NAME'), tab = body.get('CURRENT_TAB_NAME');
    if (url.pathname === '/web/base/OSRESV.HDR' && !url.search && system === 'OSRESV' && user === 'OSRESV' && tab === 'HDR' &&
        body.get('ONLY_DATA_REQUIRED') === 'true' && body.get('SCROLLROW') === 'YES' &&
        ['confirmationnumber', 'reservationstayid', 'guestid', 'guestfullname', 'account', 'firstname', 'lastname'].every(key => body.get(key) === '') &&
        ['', PROPERTY].includes(body.get('propertycode'))) return true;
    if (url.search || system !== 'FSGSPF' || user !== 'FSGSPF') return false;
    if (url.pathname === '/web/base/FSGSPF') return body.get('startUpView') === 'left' && body.get('removescreenflows') === 'yes';
    if (url.pathname === '/web/base/FSGSPF.LST') return tab === 'LST' && body.get('COMPONENT_INFO_TYPE') === 'HEAD_DATA';
    if (url.pathname !== '/web/base/FSGSPF.HDR' || tab !== 'HDR' ||
        !['guestfullname', 'externalid', 'account'].every(key => body.get(key) === '')) return false;
    const id = body.get('profileid');
    if (id === '' && body.get('removescreenflows') === 'yes') return true;
    return (id === '' || (state.masterId && id === state.masterId)) &&
      body.get('ONLY_DATA_REQUIRED') === 'true' && body.get('SCROLLROW') === 'YES';
  } catch { return false; }
}

async function guardedSession(openSession, state, operation, options) {
  const result = await openSession(async page => {
    // Keep tracking until the owned session finishes closing, including cleanup.
    page.on('dialog', dialog => {
      state.dialog = true;
      if (state.write?.diagnosticFailure && state.write.lastPhase === 'confirm_distinct') {
        try { state.write.nativeDialog = { type: diagnosticMessageText(dialog.type(), state.write.diagnosticSecrets),
          message: diagnosticMessageText(dialog.message(), state.write.diagnosticSecrets, false, state.write.fields) }; }
        catch { /* Diagnostic collection must not change the guard. */ }
      }
    });
    return operation(page);
  }, options);
  if (state.blocked || state.dialog) throw new Error('PROFILE_SESSION_GUARD_TRIPPED');
  return result;
}

async function withReadSession(operation, state, { openSession = withCenturionStay360Page, signal } = {}) {
  return guardedSession(openSession, state, async page => {
    if (!isGuardedPage(page)) throw new Error('PROFILE_CONTEXT_UNSAFE');
    const valid = await page.evaluate(() => ({ origin: location.origin, title: document.title,
      property: [...document.querySelectorAll('[data-qtip="Property"]')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()) }));
    if (valid.origin !== ORIGIN || !/Infor HMS\s*-\s*HRCEN/i.test(valid.title) ||
        valid.property.length !== 1 || valid.property[0] !== PROPERTY) throw new Error('PROFILE_PROPERTY_UNVERIFIED');
    await openNewGuestStay(page);
    return operation(page, state);
  }, { headless: true, blockServiceWorkers: true, signal: signal || AbortSignal.timeout(120000),
    prepareContext: async context => {
      await prepareGuardedContext(context);
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const profileSave = request.method() === 'POST' && url.origin === ORIGIN &&
          url.pathname === '/web/base/FSGSPF.HDR' && url.searchParams.get('pageaction')?.toUpperCase() === 'SAVE';
        if (state.write && profileSave) {
          const handler = handleProfileSave(route, state);
          state.write.handlers.add(handler);
          try { return await handler; } finally { state.write.handlers.delete(handler); }
        }
        if (!profileCreateReadMayRequest(request, state)) {
          // Blank Guest Stay initializes its card frame automatically. Always
          // refuse that known request without treating it as a profile action.
          const cardInit = request.method() === 'POST' && url.origin === 'https://hmsvault.hms.eu1.inforcloudsuite.com' &&
            url.pathname === '/Vault/servlets/showCardEntryHandler';
          if (request.method() !== 'GET' && !cardInit) state.blocked = true;
          return route.abort('blockedbyclient');
        }
        if (url.pathname === '/web/base/FSGSPF.HDR.ATTRIBUTEREFRESH') {
          state.blankRefreshAllowed = false;
          state.blankRefreshRequest = request;
        }
        if (url.pathname === state.profileOptionGate?.path) {
          state.profileOptionGate.request = request;
          state.profileOptionGate = null;
        }
        return fulfillGuestLookupRequest(route);
      });
    } });
}

async function openProfileFrame(page) {
  const ids = await page.evaluate(() => (globalThis.Ext?.ComponentQuery?.query('button[name=guestprofile]') || [])
    .filter(c => c.el?.dom?.getClientRects().length && !c.disabled && (c.formPanel?.tabName || c.up?.('uxform')?.tabName) === 'HDR').map(c => c.id));
  if (ids.length !== 1) throw new Error('PROFILE_CONTROL_UNAVAILABLE');
  await page.locator(`[id="${ids[0]}"]`).click({ timeout: 10000 });
  let frame;
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const frames = page.frames().filter(f => f.url().includes('/web/base/loadmain') && f.url().includes('FSGSPF'));
    if (frames.length > 1) throw new Error('PROFILE_FRAME_UNVERIFIED');
    if (frames.length === 1) { frame = frames[0]; break; }
    await page.waitForTimeout(100);
  }
  if (!frame) throw new Error('PROFILE_FRAME_UNAVAILABLE');
  await frame.waitForFunction(() => (globalThis.Ext?.ComponentQuery?.query('uxform[tabName=HDR]') || []).length === 1, null, { timeout: 15000 });
  const before = await frame.evaluate(() => {
    const form = Ext.ComponentQuery.query('uxform[tabName=HDR]')[0], screen = form?.getScreen?.();
    return { origin: location.origin, title: document.title, function: screen?.systemFunction,
      dirty: !!form?.isDirty?.(), tabDirty: !!screen?.getCurrentTab?.()?.isDirty?.() };
  });
  if (before.origin !== ORIGIN || !/Infor HMS\s*-\s*HRCEN/i.test(before.title) || before.function !== 'FSGSPF' || before.dirty || before.tabDirty) {
    throw new Error('PROFILE_CLEAN_SCREEN_UNVERIFIED');
  }
  return frame;
}

async function openNewProfile(page, state) {
  const frame = await openProfileFrame(page);
  const button = frame.locator('[data-qtip="New Record (Ctrl+N)"]:visible');
  if (await button.count() !== 1) throw new Error('PROFILE_NEW_CONTROL_UNAVAILABLE');
  state.newProfileFrame = frame;
  state.blankRefreshAllowed = true;
  await button.click({ timeout: 10000 });
  await frame.waitForFunction(() => {
    const forms = globalThis.Ext?.ComponentQuery?.query('uxform[tabName=HDR]') || [];
    return forms.length === 1 && forms[0].getScreen?.()?.isNewRecord === true &&
      (forms[0].query?.('[name=profileid]') || []).length === 1;
  }, null, { timeout: 15000 });
  await frame.waitForFunction(() => !globalThis.Ext?.Ajax?.isLoading?.(), null, { timeout: 10000 });
  await frame.locator('input[name="lastname"]:visible').first().waitFor({ state: 'visible', timeout: 10000 });
  if (state.blocked || state.dialog || !isGuardedPage(page)) throw new Error('PROFILE_SESSION_GUARD_TRIPPED');
  return frame;
}

async function profileForm(frame) {
  return frame.evaluate(() => {
    const forms = globalThis.Ext?.ComponentQuery?.query('uxform[tabName=HDR]') || [];
    if (forms.length !== 1) return null;
    const form = forms[0], screen = form.getScreen?.(), fields = (form.query?.('[name]') || []).filter(c => c.isFormField);
    const names = ['profileid', 'profilestatuscode', 'nametitle', 'lastname', 'firstname', 'phonenumbertypecode',
      'phonenumber', 'mobilenumber', 'emailtypecode', 'emailaddress',
      'guestoptin1', 'guestoptin2', 'guestoptin3', 'guestoptin4'];
    const values = Object.fromEntries(names.map(name => [name, fields.filter(c => c.name === name).map(c => ({
      value: c.getValue?.(), raw: c.getRawValue?.(), submit: c.getSubmitData?.(), valid: c.isValid?.(),
      readOnly: !!c.readOnly, disabled: !!c.disabled }))]));
    return { nativeNew: !!screen?.isNewRecord, dirty: !!form.isDirty?.(), values,
      required: fields.filter(c => c.allowBlank === false).map(c => ({ name: c.name, valid: c.isValid?.() })),
      dialogs: [...document.querySelectorAll('.x-window')].filter(e => e.getClientRects().length).length };
  });
}

function validProfileForm(form, fields, initial = false) {
  if (!form?.nativeNew || form.dialogs || (initial && form.dirty)) return false;
  const one = name => form.values[name]?.length === 1 ? form.values[name][0] : null;
  const id = one('profileid'), status = one('profilestatuscode');
  if (!id || id.value !== '' || !id.readOnly || !status || status.value !== 'ACTIVE' || status.raw !== 'Active') return false;
  if (['guestoptin1', 'guestoptin2', 'guestoptin3', 'guestoptin4'].some(name => one(name)?.value !== false)) return false;
  for (const [native, key] of [['lastname', 'lastName'], ['firstname', 'firstName'], ['mobilenumber', 'mobile'], ['emailaddress', 'email']]) {
    const field = one(native);
    if (!field || field.readOnly || field.disabled || (initial ? field.value !== '' : field.value !== fields[key] || field.submit?.[native] !== fields[key] || field.valid !== true)) return false;
  }
  return initial || form.required.every(field => field.valid === true);
}

async function profileOptions(frame, name) {
  const data = await frame.evaluate(fieldName => {
    const form = globalThis.Ext?.ComponentQuery?.query('uxform[tabName=HDR]')?.[0];
    const fields = (form?.query?.('[name]') || []).filter(c => c.isFormField && c.name === fieldName);
    if (fields.length !== 1) return null;
    const field = fields[0], store = field.getStore?.(), rows = store?.getRange?.();
    if (!Array.isArray(rows) || !field.valueField || !field.displayField) return null;
    return { editable: !field.disabled && !field.readOnly, loading: store.isLoading?.() === true || store.loading === true,
      loaded: store.isLoaded?.() === true || store.loaded === true || store.loadCount > 0 || rows.length > 0,
      total: store.getTotalCount?.(), options: rows.map(row => ({ code: row.get(field.valueField), label: row.get(field.displayField) })) };
  }, name);
  if (!data || !data.editable || data.loading || !data.loaded || data.options.some(option =>
    typeof option.code !== 'string' || !option.code || typeof option.label !== 'string' || !option.label.trim()) ||
    new Set(data.options.map(option => option.code)).size !== data.options.length) throw new Error('PROFILE_OPTIONS_UNAVAILABLE');
  const total = Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : null;
  return { options: data.options, coverage: { loaded: data.options.length, total,
    complete: total === null ? null : total === data.options.length } };
}

/** List current native New Profile choices without saving or selecting one. */
export async function listGuestProfileCreationOptions(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['propertyCode', 'field'].includes(key)) ||
      (input.propertyCode != null && input.propertyCode !== PROPERTY) || !Object.hasOwn(OPTION_FIELDS, input.field)) {
    return { outcome: 'input_gap', issue: 'PROFILE_OPTION_FIELD_REQUIRED' };
  }
  const state = { blocked: false, dialog: false };
  try {
    return await withReadSession(async page => {
      const frame = await openNewProfile(page, state);
      const result = await profileOptions(frame, OPTION_FIELDS[input.field]);
      return { outcome: 'ok', propertyCode: PROPERTY, field: input.field, ...result, observedAt: new Date().toISOString() };
    }, state, options);
  } catch (error) { return { outcome: 'unavailable', issue: issue(error) }; }
}

function submittedValue(form, name) {
  const field = form?.values?.[name]?.length === 1 ? form.values[name][0] : null;
  if (!field || field.disabled || field.readOnly || typeof field.submit?.[name] !== 'string') {
    throw new Error('PROFILE_FIELD_UNAVAILABLE');
  }
  return field.submit[name];
}

async function selectProfileOption(page, frame, state, name, code) {
  const catalog = await profileOptions(frame, name);
  if (catalog.coverage.complete !== true) throw new Error('PROFILE_OPTIONS_INCOMPLETE');
  const matches = catalog.options.filter(option => option.code === code);
  if (!matches.length) throw new Error('PROFILE_OPTION_INVALID');
  if (matches.length !== 1 || catalog.options.filter(option => option.label.trim() === matches[0].label.trim()).length !== 1) {
    throw new Error('PROFILE_OPTION_AMBIGUOUS');
  }
  const input = frame.locator(`input[name="${name}"]:visible`);
  if (await input.count() !== 1) throw new Error('PROFILE_FIELD_UNAVAILABLE');
  const trigger = input.locator('xpath=ancestor::table[1]').locator('.x-form-trigger:visible');
  if (await trigger.count() !== 1) throw new Error('PROFILE_OPTION_UNAVAILABLE');
  await trigger.click({ timeout: 8000 });
  const choices = frame.locator('.x-boundlist-item:visible');
  await choices.first().waitFor({ state: 'visible', timeout: 8000 });
  const indexes = await choices.evaluateAll((elements, label) =>
    elements.flatMap((element, index) => element.textContent.trim() === label.trim() ? [index] : []), matches[0].label);
  if (indexes.length !== 1) throw new Error('PROFILE_OPTION_UNAVAILABLE');
  let gate, response;
  if (name === 'phonenumbertypecode' || name === 'emailtypecode') {
    const form = await profileForm(frame);
    const expected = { SYSTEM_FUNCTION_NAME: 'FSGSPF', USER_FUNCTION_NAME: 'FSGSPF', CURRENT_TAB_NAME: 'HDR',
      profileid: '', recordid: '', PKID: '@[EMPTY]#', pagemode: 'display', ONLY_DATA_REQUIRED: 'true',
      actions: '', submit: '', confirmnewguestprofile: '', confirminactiveguestprofile: '', newpassword: '', confirmnewpassword: '' };
    for (const field of ['nametitle', 'lastname', 'firstname', 'phonenumbertypecode', 'phonenumber', 'mobilenumber', 'emailtypecode', 'emailaddress']) {
      expected[field] = field === name ? code : submittedValue(form, field);
    }
    const path = name === 'phonenumbertypecode' ? '/web/base/FSGSPF.HDR.getPhoneTypeDetails' : '/web/base/FSGSPF.HDR.getEmailTypeDetails';
    gate = { frame, path, expected, request: null };
    state.profileOptionGate = gate;
    response = page.waitForResponse(value => value.request() === gate.request, { timeout: 10000 });
    void response.catch(() => {});
  }
  try {
    await choices.nth(indexes[0]).click({ timeout: 8000 });
    if (response) {
      const received = await response;
      let data;
      try { data = parseProfileResponse(await boundedResponseText(received)); } catch { /* Refuse non-native responses. */ }
      if (received.status() !== 200 || !data || typeof data !== 'object' || data.success === false) {
        throw new Error('PROFILE_OPTION_REFRESH_FAILED');
      }
    }
    await frame.waitForFunction(() => !globalThis.Ext?.Ajax?.isLoading?.(), null, { timeout: 10000 });
    const after = await profileForm(frame);
    if (state.blocked || state.dialog || !isGuardedPage(page) || submittedValue(after, name) !== code) {
      throw new Error('PROFILE_OPTION_UNVERIFIED');
    }
  } finally { if (state.profileOptionGate === gate) state.profileOptionGate = null; }
}

async function effectiveProfileExtras(frame, form) {
  const choice = async name => {
    const code = submittedValue(form, name), field = form.values[name][0];
    if (field.valid !== true) throw new Error('PROFILE_OPTION_UNVERIFIED');
    if (!code) {
      if (![null, ''].includes(field.value) || field.raw !== '') throw new Error('PROFILE_DEFAULT_UNVERIFIED');
      return { code: '', label: '' };
    }
    const catalog = await profileOptions(frame, name);
    const matches = catalog.options.filter(option => option.code === code);
    if (catalog.coverage.complete !== true || matches.length !== 1 || field.value !== code || field.raw !== matches[0].label) {
      throw new Error('PROFILE_OPTION_UNVERIFIED');
    }
    return { code, label: matches[0].label };
  };
  const phoneNumber = submittedValue(form, 'phonenumber'), phone = form.values.phonenumber[0];
  if (phone.valid !== true || phone.value !== phoneNumber || phone.raw !== phoneNumber) throw new Error('PROFILE_FIELD_UNVERIFIED');
  return { title: await choice('nametitle'), phoneNumber,
    phoneType: await choice('phonenumbertypecode'), emailType: await choice('emailtypecode') };
}

// Preparation and creation share staging; only the latter supplies a save operation.
async function stageProfile(page, state, fields, input) {
  const confirmDuplicateName = input.confirmDuplicateName === true;
  const extended = hasExtendedProfileFields(fields);
  const legacyDigest = extended ? null : profilePreviewDigest(fields, confirmDuplicateName);
  if (!extended && input.expectedPreviewDigest != null && input.expectedPreviewDigest !== legacyDigest) {
    return { outcome: 'review_required', issue: 'PROFILE_PREVIEW_CHANGED' };
  }
  const frame = await openNewProfile(page, state);
  const initial = await profileForm(frame);
  if (!validProfileForm(initial, fields, true)) throw new Error('PROFILE_NEW_DEFAULTS_UNVERIFIED');
  if (extended && fields.titleCode) await selectProfileOption(page, frame, state, 'nametitle', fields.titleCode);
  const fill = async (native, key) => {
    if (!fields[key]) return;
    const control = frame.locator(`input[name="${native}"]:visible`);
    if (await control.count() !== 1) throw new Error('PROFILE_FIELD_UNAVAILABLE');
    await control.fill(fields[key]);
    await control.press('Tab');
  };
  await fill('lastname', 'lastName');
  await fill('firstname', 'firstName');
  if (extended && fields.phoneTypeCode) await selectProfileOption(page, frame, state, 'phonenumbertypecode', fields.phoneTypeCode);
  if (extended && fields.phoneNumber) await fill('phonenumber', 'phoneNumber');
  await fill('mobilenumber', 'mobile');
  if (extended && fields.emailTypeCode) await selectProfileOption(page, frame, state, 'emailtypecode', fields.emailTypeCode);
  await fill('emailaddress', 'email');
  const staged = await profileForm(frame);
  if (state.dialog || state.blocked || !isGuardedPage(page) || !validProfileForm(staged, fields)) {
    throw new Error('PROFILE_STAGING_UNVERIFIED');
  }
  const review = extended ? { version: 2, propertyCode: PROPERTY, fields, confirmDuplicateName,
    effective: await effectiveProfileExtras(frame, staged) } : null;
  if (extended && !matchesProfileReview(review, fields, confirmDuplicateName)) throw new Error('PROFILE_STAGING_UNVERIFIED');
  const previewDigest = extended ? profileReviewDigest(review) : legacyDigest;
  if (input.expectedPreviewDigest != null && input.expectedPreviewDigest !== previewDigest ||
      input.expectedReview != null && !same(input.expectedReview, review)) {
    return { outcome: 'review_required', issue: 'PROFILE_PREVIEW_CHANGED' };
  }
  const finalForm = await profileForm(frame);
  if (!validProfileForm(finalForm, fields) || extended && !same(await effectiveProfileExtras(frame, finalForm), review.effective) ||
      state.dialog || state.blocked || !isGuardedPage(page)) throw new Error('PROFILE_STAGING_UNVERIFIED');
  const save = frame.locator('[data-qtip*="Save"]:visible');
  if (await save.count() !== 1 || !await save.isEnabled() || await save.evaluate(element =>
    Boolean(element.closest('.x-item-disabled,.x-btn-disabled,[aria-disabled="true"]')) ||
    globalThis.Ext?.getCmp?.(element.id)?.disabled === true)) throw new Error('PROFILE_SAVE_CONTROL_UNAVAILABLE');
  return { outcome: 'ready', frame, save, fields, previewDigest, confirmDuplicateName, ...(review && { review }),
    requiredFields: staged.required.map(field => field.name) };
}

async function runStaged(input, options, operation) {
  const fields = profileBusinessFields(input);
  if (!fields) return { outcome: 'needs_input', issue: profileInputIssue(input) };
  const state = { blocked: false, dialog: false };
  try {
    const result = await withReadSession(async page => {
      const staged = await stageProfile(page, state, fields, input);
      return staged.outcome === 'ready' ? await operation(page, state, staged) : staged;
    }, state, options);
    if (state.write?.dispatched && (state.write.issue || state.write.handlers.size || !state.write.callbackDrained)) {
      return failureEvidence(state.write, 'PROFILE_SAVE_UNCERTAIN');
    }
    return result;
  } catch (error) {
    if (state.write?.dispatched) return failureEvidence(state.write, 'PROFILE_SAVE_UNCERTAIN');
    const problem = issue(error);
    const outcome = ['PROFILE_OPTION_INVALID', 'PROFILE_OPTION_AMBIGUOUS'].includes(problem) ? 'needs_input'
      : ['PROFILE_OPTIONS_INCOMPLETE', 'PROFILE_DEFAULT_UNVERIFIED'].includes(problem) ? 'unsupported' : 'unavailable';
    return { outcome, issue: problem };
  }
}

function failureEvidence(write, error) {
  return { outcome: 'uncertain', issue: error, attemptId: write.attemptId ?? null,
    phase: write.lastPhase ?? null, dispatched: write.dispatched,
    dispatchedPhases: [...write.dispatchedPhases], nativeId: write.response?.nativeId ?? null };
}

async function waitForDispatch(write, timeout = 40000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (write.issue || write.phase === 'failed') throw new Error(write.issue || 'PROFILE_SAVE_FAILED');
    if (write.callbackDrained && ['question', 'finished'].includes(write.phase)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('PROFILE_SAVE_TIMED_OUT');
}

async function findDuplicateYes(page, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    let yes = null;
    for (const view of page.frames()) {
      const windows = view.locator('.x-window:visible').filter({ hasText: 'Profile name already exists. Continue?' });
      const count = await windows.count();
      if (count > 1) throw new Error('PROFILE_DUPLICATE_DIALOG_AMBIGUOUS');
      if (count === 1) {
        const button = windows.first().locator('a.x-btn:visible').filter({ hasText: /^Yes$/ });
        if (yes || await button.count() !== 1 || !await button.isEnabled()) throw new Error('PROFILE_DUPLICATE_DIALOG_AMBIGUOUS');
        yes = button;
      }
    }
    if (yes) return yes;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('PROFILE_DUPLICATE_DIALOG_UNVERIFIED');
}

// Collect only visible native messages and window titles, after the response was
// durably recorded and fulfilled. Never collect page HTML, input values or URLs
// with query strings. This evidence is written only in the private journal.
async function visibleProfileFailure(page, write) {
  const location = frame => {
    try {
      const url = new URL(frame.url());
      if (url.origin !== ORIGIN) return null;
      const path = /^\/(?:web\/base(?:\/(?:loadmain|FSGSPF(?:\.[A-Za-z]+)?))?)?$/.test(url.pathname)
        ? url.pathname : null;
      return { origin: url.origin, path };
    } catch { return null; }
  };
  try {
    const frames = page.frames().slice(0, 8).filter(frame => location(frame));
    // Give the client a brief chance to render the response, without waiting for a dialog.
    await new Promise(resolve => setTimeout(resolve, 300));
    const snapshots = await Promise.all(frames.map(async frame => {
      let timer;
      try {
        const data = await Promise.race([
          frame.evaluate(() => {
            const visible = el => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
            const texts = selector => [...document.querySelectorAll(selector)].filter(visible)
              .slice(0, 5).map(el => (el.innerText || '').trim()).filter(text => text && text.length <= 8192);
            return { title: document.title.length <= 8192 ? document.title : '',
              windows: texts('.x-window:not(.x-menu) .x-window-header-text'),
              messages: texts('.x-message-box-text, .x-message-box .x-window-body, .x-form-invalid-msg, .x-error-msg, [role="alert"], [role="alertdialog"]') };
          }),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); }),
        ]);
        return data ? { ...location(frame), title: diagnosticMessageText(data.title, write.diagnosticSecrets, false, write.fields),
          windows: data.windows.map(text => diagnosticMessageText(text, write.diagnosticSecrets, false, write.fields)),
          messages: data.messages.map(text => diagnosticMessageText(text, write.diagnosticSecrets, false, write.fields)) }
          : { ...location(frame), unavailable: true };
      } catch { return { ...location(frame), unavailable: true }; }
      finally { clearTimeout(timer); }
    }));
    return { frames: snapshots, nativeDialog: write.nativeDialog ?? null };
  } catch { return { frames: null, nativeDialog: write.nativeDialog ?? null, unavailable: true }; }
}

async function savePreparedProfile(page, state, staged, commit) {
  const { frame, save, fields, previewDigest, confirmDuplicateName, review } = staged;
  const write = { ...commit, fields, previewDigest, confirmDuplicateName, review, phase: 'initial', lastPhase: null,
    dispatched: false, dispatchedPhases: [], response: null, issue: null, callbackDrained: false, handlers: new Set() };
  state.write = write;
  try {
    if (frame) {
      const current = await profileForm(frame);
      if (!validProfileForm(current, fields) || review && !same(await effectiveProfileExtras(frame, current), review.effective) ||
          state.dialog || state.blocked || !isGuardedPage(page)) throw new Error('PROFILE_PREVIEW_CHANGED');
    }
    await save.click({ timeout: 10000 });
    await waitForDispatch(write);
    if (write.phase === 'question' && confirmDuplicateName && !state.dialog && !state.blocked) {
      const yes = await findDuplicateYes(page);
      if (state.dialog || state.blocked || write.phase !== 'question') throw new Error('PROFILE_DUPLICATE_DIALOG_UNVERIFIED');
      write.phase = 'confirm';
      write.callbackDrained = false;
      await yes.click({ timeout: 10000 });
      await waitForDispatch(write);
    }
  } catch (error) { write.issue ??= issue(error); }
  finally { write.phase = 'closed'; }
  if (write.diagnosticFailure && write.callbackDrained && write.lastPhase === 'confirm_distinct' &&
      typeof commit.recordFailureDiagnostics === 'function') {
    try {
      const diagnostics = await visibleProfileFailure(page, write);
      diagnostics.dataLiteralRecovery = await recoverProfileFailureDiagnostics(write.diagnosticSource, write.diagnosticSecrets, write.fields);
      await commit.recordFailureDiagnostics(diagnostics);
    }
    catch { /* Collection and journal diagnostics never alter the held result. */ }
    finally { write.diagnosticSource = null; }
  }
  const evidence = { attemptId: write.attemptId ?? null, phase: write.lastPhase,
    dispatched: write.dispatched, dispatchedPhases: [...write.dispatchedPhases], nativeId: write.response?.nativeId ?? null };
  if (!write.dispatched) return { outcome: 'not_dispatched', issue: write.issue || 'PROFILE_SAVE_NOT_DISPATCHED', ...evidence };
  if (!state.dialog && !state.blocked && !write.issue && write.callbackDrained && write.response?.question && !confirmDuplicateName) {
    return { outcome: 'confirmation_required', issue: 'PROFILE_NAME_ALREADY_EXISTS', ...evidence };
  }
  if (state.dialog || state.blocked || write.issue || !write.callbackDrained || !write.response?.success || !write.response.nativeId) {
    return failureEvidence(write, write.issue || 'PROFILE_SAVE_UNVERIFIED');
  }
  return { outcome: 'awaiting_readback', ...evidence, businessFields: fields, ...(review && { review }) };
}

/** Stage a new profile without saving. Use the existing guest lookup separately. */
export async function prepareGuestProfile(input, options = {}) {
  return runStaged(input, options, async (_page, _state, staged) => ({
    outcome: 'ready', businessFields: staged.fields, previewDigest: staged.previewDigest,
    ...(staged.review && { review: staged.review }),
    native: { profileId: null, requiredFields: staged.requiredFields, saveAvailable: true },
    saveContract: { status: 'authorized_caller_required' },
  }));
}

/** Trusted callbacks authorize and durably record both dispatch and response. */
export async function createGuestProfile(input, { authorizeCandidate, dispatchCandidate, recordResponse, recordFailureDiagnostics, attemptId, ...options } = {}) {
  if (!/^[a-f0-9]{64}$/.test(input?.expectedPreviewDigest || '') ||
      typeof authorizeCandidate !== 'function' || typeof dispatchCandidate !== 'function' || typeof recordResponse !== 'function') {
    return { outcome: 'not_dispatched', issue: 'PROFILE_AUTHORIZATION_REQUIRED', attemptId: attemptId ?? null, dispatched: false };
  }
  const requested = profileBusinessFields(input);
  if (requested && hasExtendedProfileFields(requested) &&
      (!matchesProfileReview(input.expectedReview, requested, input.confirmDuplicateName) ||
       profileReviewDigest(input.expectedReview) !== input.expectedPreviewDigest)) {
    return { outcome: 'review_required', issue: 'PROFILE_PREVIEW_CHANGED', attemptId: attemptId ?? null, dispatched: false };
  }
  const result = await runStaged(input, options, (page, state, staged) =>
    savePreparedProfile(page, state, staged, { authorizeCandidate, dispatchCandidate, recordResponse, recordFailureDiagnostics, attemptId }));
  if (result.outcome !== 'awaiting_readback') return result;
  let readback;
  try { readback = await readGuestProfile({ nativeId: result.nativeId }, options); }
  catch { readback = null; }
  const fields = result.businessFields;
  if (!matchesProfileReadback(readback, fields, result.nativeId, result.review)) {
    return { outcome: 'uncertain', issue: 'PROFILE_READBACK_UNVERIFIED', attemptId: result.attemptId,
      phase: result.phase, dispatched: true, dispatchedPhases: result.dispatchedPhases, nativeId: result.nativeId };
  }
  return { outcome: 'created', attemptId: result.attemptId, phase: result.phase,
    dispatched: true, dispatchedPhases: result.dispatchedPhases, nativeId: result.nativeId, readback };
}

// Unknown consent never counts as off.
export function matchesProfileReadback(readback, fields, expectedNativeId, review) {
  const core = readback?.outcome === 'read' && readback.firstName === fields.firstName && readback.lastName === fields.lastName &&
    readback.mobile === fields.mobile && readback.email === fields.email && readback.status === 'ACTIVE' &&
    (expectedNativeId === undefined || readback.nativeId === expectedNativeId) &&
    Array.isArray(readback.consent) && readback.consent.length === 4 && readback.consent.every(value => value === false);
  if (!core || !hasExtendedProfileFields(fields)) return core;
  if (!matchesProfileReview(review, fields, review?.confirmDuplicateName) || !Array.isArray(readback.fields)) return false;
  for (const [name, expected] of [['nametitle', review.effective.title.code], ['phonenumber', review.effective.phoneNumber],
    ['phonenumbertypecode', review.effective.phoneType.code], ['emailtypecode', review.effective.emailType.code]]) {
    const matches = readback.fields.filter(field => field.name === name);
    if (matches.length !== 1 || (expected ? matches[0].state !== 'present' || matches[0].value !== expected
      : matches[0].state !== 'blank')) return false;
  }
  return true;
}

function profileReadInput(input) {
  const nativeId = clean(input?.nativeId);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['nativeId', 'propertyCode'].includes(key)) ||
      (input.propertyCode != null && input.propertyCode !== PROPERTY) || !/^\d+$/.test(nativeId)) return null;
  return nativeId;
}

async function profileFieldMetadata(frame) {
  return frame.evaluate(() => (globalThis.Ext?.ComponentQuery?.query('uxform[tabName=HDR] [isFormField]') || [])
    .map(field => ({ name: field.getName?.() || field.name || '',
      label: String(field.fieldLabel || '').replace(/<[^>]+>/g, '').trim(),
      kind: field.getXType?.() || null, visibleWhenDiscovered: field.isVisible?.(true) ?? null }))
    .filter(field => field.name));
}

function profileFieldObservation(field, values) {
  if (/(?:password|credential|secret|token)/i.test(`${field.name} ${field.label}`)) {
    return { ...field, state: 'redacted', value: null, displayValue: null, rawValue: null };
  }
  const observed = Object.hasOwn(values, field.name);
  const rawValue = observed ? values[field.name] : null;
  const selected = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) && Object.hasOwn(rawValue, 'selected');
  const value = selected ? rawValue.selected : rawValue;
  let state = 'unknown';
  if (!observed) state = 'unread';
  else if (field.kind === 'checkboxfield') {
    if ([true, 1, '1', 'true'].includes(value)) state = 'true';
    else if ([false, 0, '0', 'false'].includes(value)) state = 'false';
  } else if (value === null || value === '') state = 'blank';
  else if (typeof value === 'string') state = /^(?:\*{3,}|•{3,})/.test(value.trim()) ? 'masked' : value.trim() ? 'present' : 'blank';
  else if (typeof value === 'number' || typeof value === 'boolean') state = 'present';
  const choices = selected && Array.isArray(rawValue.option) ? rawValue.option.filter(option =>
    option?.value === value && typeof option.display === 'string') : [];
  const displayValue = choices.length === 1 ? choices[0].display : null;
  return { ...field, state, value, displayValue, rawValue };
}

async function readProfileMaster(page, frame, nativeId, state, metadata) {
  state.masterId = nativeId;
  const body = new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'FSGSPF', USER_FUNCTION_NAME: 'FSGSPF',
    CURRENT_TAB_NAME: 'HDR', profileid: nativeId, guestfullname: '', externalid: '', account: '',
    ONLY_DATA_REQUIRED: 'true', SCROLLROW: 'YES' }).toString();
  const response = await frame.evaluate(async data => {
    const requestToken = globalThis.EAM?.AppData?.generateRequestToken?.();
    if (typeof requestToken !== 'string' || !requestToken) throw new Error('PROFILE_MASTER_CONTEXT_UNVERIFIED');
    const result = await fetch('/web/base/FSGSPF.HDR', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
        'Request-Type': 'XMLHTTP', 'Request-Source': 'XMLHTTP', requestToken }, body: data,
      signal: AbortSignal.timeout(30_000) });
    return { status: result.status, text: await result.text() };
  }, body);
  if (state.blocked || state.dialog || !isGuardedPage(page) || response.status !== 200) throw new Error('PROFILE_MASTER_READ_UNAVAILABLE');
  const json = response.text.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  const payload = JSON.parse(json), values = payload?.pageData?.values;
  if (payload?.success === false || payload?.pageData?.success === false || !values || typeof values !== 'object' ||
      Array.isArray(values) || String(values.profileid ?? '').trim() !== nativeId) {
    throw new Error('PROFILE_MASTER_READ_UNVERIFIED');
  }
  const status = typeof values.profilestatuscode === 'string' ? clean(values.profilestatuscode)
    : typeof values.profilestatuscode?.selected === 'string' ? clean(values.profilestatuscode.selected) : null;
  const textValue = name => typeof values[name] === 'string' ? values[name] : null;
  // A missing email is unknown, while an explicitly observed native null is blank.
  // Creation's strict validator must not accept a missing field as its blank email.
  const email = Object.hasOwn(values, 'emailaddress') && values.emailaddress === null ? '' : textValue('emailaddress');
  const fields = metadata.map(field => profileFieldObservation(field, values));
  const consent = [1, 2, 3, 4].map(index => {
    const value = values[`guestoptin${index}`];
    if ([false, 0, '0', 'false'].includes(value)) return false;
    if ([true, 1, '1', 'true'].includes(value)) return true;
    return null;
  });
  return { outcome: 'read', nativeId, propertyCode: PROPERTY, observedAt: new Date().toISOString(),
    firstName: textValue('firstname'), lastName: textValue('lastname'), mobile: textValue('mobilenumber'),
    email, status, consent,
    consentCoverage: consent.every(value => value !== null) ? 'complete' : 'incomplete', fields,
    coverage: { scope: 'native_master_values_for_discovered_header_form_fields',
      metadataSource: 'instantiated_profile_header_form', discoveredFields: metadata.length,
      missingSummaryFields: ['firstname', 'lastname', 'mobilenumber', 'emailaddress', 'profilestatuscode']
        .filter(name => !Object.hasOwn(values, name)),
      unreadFields: fields.filter(field => field.state === 'unread').map(field => field.name),
      unknownFields: fields.filter(field => field.state === 'unknown').map(field => field.name),
      unmappedNativeValueNames: Object.keys(values).filter(name => !metadata.some(field => field.name === name)) },
    evidence: 'exact_id_master_read_only_not_dispatch_attribution' };
}

/** Read multiple exact IDs sequentially on one read-only session. No identity lookup. */
export async function readGuestProfiles(inputs, { onResult, ...options } = {}) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.some(input => !profileReadInput(input)) ||
      new Set(inputs.map(profileReadInput)).size !== inputs.length ||
      (onResult !== undefined && typeof onResult !== 'function')) {
    return { outcome: 'input_gap', issue: 'UNIQUE_PROFILE_IDS_REQUIRED', profiles: [] };
  }
  const nativeIds = inputs.map(profileReadInput);
  const state = { blocked: false, masterId: null }, profiles = [];
  try {
    await withReadSession(async page => {
      const frame = await openProfileFrame(page), metadata = await profileFieldMetadata(frame);
      if (!metadata.length) throw new Error('PROFILE_FORM_METADATA_UNAVAILABLE');
      for (const nativeId of nativeIds) {
        options.signal?.throwIfAborted();
        const result = await readProfileMaster(page, frame, nativeId, state, metadata);
        profiles.push(result);
        // Checkpoints are provisional until the session guard and shutdown pass.
        await onResult?.(structuredClone(result));
      }
    }, state, options);
    return { outcome: 'read', profiles, sessionVerified: true };
  } catch (error) { return { outcome: 'unavailable', issue: issue(error), profiles, sessionVerified: false }; }
}

/** Fresh exact-ID master read. This is not evidence that any dispatch created the ID. */
export async function readGuestProfile(input, options = {}) {
  if (!profileReadInput(input)) return { outcome: 'input_gap', issue: 'PROFILE_ID_REQUIRED' };
  const result = await readGuestProfiles([input], options);
  return result.outcome === 'read' ? result.profiles[0] : { outcome: 'unavailable', issue: result.issue };
}

// Internal behavioral checks, not HMS operations.
export const profileCreateTestHooks = Object.freeze({ profileSaveMatches, profileCreateReadMayRequest, handleProfileSave,
  waitForDispatch, savePreparedProfile, guardedSession });
