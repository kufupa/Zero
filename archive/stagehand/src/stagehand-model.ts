/** Development-only, text-only Stagehand v4 callback for approved Azure Astra. */
import { constants, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export const STAGEHAND_ASTRA_DEPLOYMENT = 'gpt-6-astra' as const;
export const STAGEHAND_SPEND_TARGET_CENTS = 2_500;
export const STAGEHAND_SPEND_MAX_CENTS = 5_000;
export const STAGEHAND_INPUT_TOKEN_LIMIT = 272_000;
export const STAGEHAND_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
export const STAGEHAND_MAX_OUTPUT_TOKENS = 8_192;

const IN_CENTS_PER_M = 1_000;
const CACHE_WRITE_CENTS_PER_M = 1_250;
const OUT_CENTS_PER_M = 5_000;
const BODY_ENVELOPE_BYTES = 256;
const INITIALIZATION_MARKER = 'stagehand-spend-ledger-v1\n';
type Obj = Record<string, unknown>;
type Fetcher = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

export type StagehandGenerateParams = {
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  systemPrompt?: string;
  responseFormat?:
    | { type: 'json_schema'; name: string; description?: string; schema: unknown }
    | { type: 'text' };
  temperature?: number;
  stopSequences?: string[];
  tools?: unknown[];
  toolChoice?: unknown;
};
export type StagehandUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};
export type StagehandModelOptions = {
  azureBaseUrl: string;
  approvedAzureOrigin: string;
  apiKey: string;
  deployment: typeof STAGEHAND_ASTRA_DEPLOYMENT;
  spendPath: string;
  initializeNewLedger?: boolean;
  fetch?: Fetcher;
  maxOutputTokens?: number;
  timeoutMs?: number;
};
type Call = {
  callId: string;
  status: 'reserved' | 'retained' | 'settled';
  estimatedCents: number;
  inputTokenUpperBound: number;
  reservedAt: string;
  retainedAt?: string;
  retainedReason?: 'provider_error' | 'usage_missing' | 'resume_unknown';
  settledAt?: string;
  actualCostCents?: number;
  usage?: StagehandUsage;
};
export type StagehandSpendState = {
  schemaVersion: 1;
  currency: 'USD';
  priceBasis: 'public-openai-estimate';
  azureTariffVerified: false;
  targetCents: typeof STAGEHAND_SPEND_TARGET_CENTS;
  maxCents: typeof STAGEHAND_SPEND_MAX_CENTS;
  settledCents: number;
  reservedCents: number;
  calls: Record<string, Call>;
};
type Result = {
  role: 'assistant';
  content: [{ type: 'text'; text: string }];
  outputFormat: 'json_schema';
  structuredContent: unknown;
  usage: StagehandUsage;
};
type Config = {
  endpoint: string;
  key: string;
  path: string;
  markerPath: string;
  initialize: boolean;
  fetch: Fetcher;
  maxOutput: number;
  timeout: number;
};
type Code =
  | 'APPROVED_ENDPOINT'
  | 'INVALID_OPTIONS'
  | 'UNSUPPORTED_INPUT'
  | 'INPUT_TOO_LARGE'
  | 'BUDGET_EXCEEDED'
  | 'SPEND_LOCKED'
  | 'SPEND_STATE_INVALID'
  | 'SPEND_STATE_WRITE_FAILED'
  | 'PROVIDER_ERROR'
  | 'USAGE_MISSING'
  | 'MODEL_REFUSED'
  | 'MODEL_TRUNCATED'
  | 'RESPONSE_INVALID';
const messages: Record<Code, string> = {
  APPROVED_ENDPOINT: 'Stagehand model requires an approved HTTPS Azure endpoint',
  INVALID_OPTIONS: 'Stagehand model options are invalid; deployment must be gpt-6-astra',
  UNSUPPORTED_INPUT: 'Stagehand model request contains an unsupported shape',
  INPUT_TOO_LARGE: 'Stagehand model request exceeds the bounded input limit',
  BUDGET_EXCEEDED: 'Stagehand model request exceeds the private spend ceiling',
  SPEND_LOCKED: 'Stagehand spend ledger is already in use',
  SPEND_STATE_INVALID: 'Stagehand spend ledger is unreadable; refusing to continue',
  SPEND_STATE_WRITE_FAILED: 'Stagehand spend ledger could not be persisted',
  PROVIDER_ERROR: 'Stagehand Azure model request failed',
  USAGE_MISSING: 'Stagehand Azure response omitted usage; reservation retained',
  MODEL_REFUSED: 'Stagehand Azure model refused the bounded request',
  MODEL_TRUNCATED: 'Stagehand Azure model response was truncated',
  RESPONSE_INVALID: 'Stagehand Azure response did not contain valid structured output',
};
class ModelError extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(messages[code]);
    this.name = 'StagehandModelError';
    this.code = code;
  }
}
const fail = (code: Code): ModelError => new ModelError(code);
const obj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isErrno = (v: unknown, code: string): boolean => obj(v) && v.code === code;
const byteLength = (v: string): number => Buffer.byteLength(v, 'utf8');

function parseUrl(raw: unknown): URL {
  let url: URL;
  try {
    if (typeof raw !== 'string') throw new Error('not a string');
    url = new URL(raw);
  } catch {
    throw fail('APPROVED_ENDPOINT');
  }
  return url;
}

function approvedOrigin(raw: unknown): string {
  const url = parseUrl(raw);
  const azureHost =
    url.hostname.endsWith('.openai.azure.com') || url.hostname.endsWith('.services.ai.azure.com');
  if (
    url.protocol !== 'https:' ||
    !azureHost ||
    url.port ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw fail('APPROVED_ENDPOINT');
  }
  return url.origin;
}

function endpoint(raw: unknown, expectedOrigin: string): string {
  const url = parseUrl(raw);
  const path = url.pathname.replace(/\/+$/, '');
  const azureHost =
    url.hostname.endsWith('.openai.azure.com') || url.hostname.endsWith('.services.ai.azure.com');
  if (
    url.protocol !== 'https:' ||
    !azureHost ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin !== expectedOrigin ||
    (path && path !== '/openai/v1')
  ) {
    throw fail('APPROVED_ENDPOINT');
  }
  return `${expectedOrigin}${path || '/openai/v1'}/responses`;
}

function configure(options: StagehandModelOptions): Config {
  if (
    !obj(options) ||
    !options.apiKey ||
    options.deployment !== STAGEHAND_ASTRA_DEPLOYMENT ||
    typeof options.spendPath !== 'string' ||
    !options.spendPath.startsWith('/')
  ) {
    throw fail('INVALID_OPTIONS');
  }
  const maxOutput = options.maxOutputTokens ?? STAGEHAND_DEFAULT_MAX_OUTPUT_TOKENS;
  const timeout = options.timeoutMs ?? 120_000;
  const fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (
    !integer(maxOutput) ||
    maxOutput < 1 ||
    maxOutput > STAGEHAND_MAX_OUTPUT_TOKENS ||
    !integer(timeout) ||
    timeout < 1 ||
    typeof fetch !== 'function'
  ) {
    throw fail('INVALID_OPTIONS');
  }
  const origin = approvedOrigin(options.approvedAzureOrigin);
  return {
    endpoint: endpoint(options.azureBaseUrl, origin),
    key: options.apiKey,
    path: options.spendPath,
    markerPath: `${options.spendPath}.initialized`,
    initialize: options.initializeNewLedger === true,
    fetch,
    maxOutput,
    timeout,
  };
}

function prepare(
  params: StagehandGenerateParams,
  maxOutput: number,
): { body: Obj; bodyJson: string; inputTokens: number } {
  if (
    !obj(params) ||
    !Array.isArray(params.messages) ||
    params.messages.length === 0 ||
    (params.systemPrompt !== undefined && typeof params.systemPrompt !== 'string')
  )
    throw fail('UNSUPPORTED_INPUT');
  const format = params.responseFormat;
  if (
    !obj(format) ||
    format.type !== 'json_schema' ||
    typeof format.name !== 'string' ||
    !format.name ||
    format.schema === undefined ||
    (format.description !== undefined && typeof format.description !== 'string') ||
    params.tools !== undefined ||
    params.toolChoice !== undefined
  )
    throw fail('UNSUPPORTED_INPUT');
  const input: Obj[] = [];
  if (params.systemPrompt !== undefined) {
    input.push({ role: 'system', content: [{ type: 'input_text', text: params.systemPrompt }] });
  }
  for (const message of params.messages) {
    if (!obj(message) || (message.role !== 'user' && message.role !== 'assistant'))
      throw fail('UNSUPPORTED_INPUT');
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    if (!blocks.length) throw fail('UNSUPPORTED_INPUT');
    const content: Obj[] = [];
    for (const block of blocks) {
      // Image tokenization is provider-specific; observe trial stays text-only.
      if (!obj(block) || block.type !== 'text' || typeof block.text !== 'string')
        throw fail('UNSUPPORTED_INPUT');
      content.push({ type: 'input_text', text: block.text });
    }
    input.push({ role: message.role, content });
  }
  const body: Obj = {
    model: STAGEHAND_ASTRA_DEPLOYMENT,
    input,
    reasoning: { effort: 'high' },
    store: false,
    max_output_tokens: maxOutput,
    text: {
      format: {
        type: 'json_schema',
        name: format.name,
        ...(format.description ? { description: format.description } : {}),
        schema: format.schema,
        strict: true,
      },
    },
  };
  let bodyJson: string;
  try {
    bodyJson = JSON.stringify(body);
  } catch {
    throw fail('UNSUPPORTED_INPUT');
  }
  if (typeof bodyJson !== 'string') throw fail('UNSUPPORTED_INPUT');
  const inputTokens = BODY_ENVELOPE_BYTES + byteLength(bodyJson);
  if (inputTokens >= STAGEHAND_INPUT_TOKEN_LIMIT) throw fail('INPUT_TOO_LARGE');
  return {
    inputTokens,
    body,
    bodyJson,
  };
}

const cost = (input: number, output: number, rate: number): number =>
  Math.max(1, Math.ceil((input * rate + output * OUT_CENTS_PER_M) / 1_000_000));
const fresh = (): StagehandSpendState => ({
  schemaVersion: 1,
  currency: 'USD',
  priceBasis: 'public-openai-estimate',
  azureTariffVerified: false,
  targetCents: STAGEHAND_SPEND_TARGET_CENTS,
  maxCents: STAGEHAND_SPEND_MAX_CENTS,
  settledCents: 0,
  reservedCents: 0,
  calls: {},
});

function parseUsage(raw: unknown): StagehandUsage | null {
  if (!obj(raw)) return null;
  const inputTokens = raw.input_tokens;
  const outputTokens = raw.output_tokens;
  const totalTokens = raw.total_tokens;
  if (
    !integer(inputTokens) ||
    !integer(outputTokens) ||
    !integer(totalTokens) ||
    totalTokens !== inputTokens + outputTokens
  )
    return null;
  const reasoning = obj(raw.output_tokens_details)
    ? raw.output_tokens_details.reasoning_tokens
    : undefined;
  const cached = obj(raw.input_tokens_details) ? raw.input_tokens_details.cached_tokens : undefined;
  let reasoningTokens: number | undefined;
  if (reasoning !== undefined) {
    if (!integer(reasoning) || reasoning > outputTokens) return null;
    reasoningTokens = reasoning;
  }
  let cachedInputTokens: number | undefined;
  if (cached !== undefined) {
    if (!integer(cached) || cached > inputTokens) return null;
    cachedInputTokens = cached;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

const onlyKeys = (value: Obj, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

function parseStoredUsage(raw: unknown): StagehandUsage | null {
  if (!obj(raw)) return null;
  if (
    !onlyKeys(raw, [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'reasoningTokens',
      'cachedInputTokens',
    ])
  )
    return null;
  const inputTokens = raw.inputTokens;
  const outputTokens = raw.outputTokens;
  const totalTokens = raw.totalTokens;
  if (
    !integer(inputTokens) ||
    !integer(outputTokens) ||
    !integer(totalTokens) ||
    totalTokens !== inputTokens + outputTokens
  )
    return null;
  let reasoningTokens: number | undefined;
  if (raw.reasoningTokens !== undefined) {
    if (!integer(raw.reasoningTokens) || raw.reasoningTokens > outputTokens) return null;
    reasoningTokens = raw.reasoningTokens;
  }
  let cachedInputTokens: number | undefined;
  if (raw.cachedInputTokens !== undefined) {
    if (!integer(raw.cachedInputTokens) || raw.cachedInputTokens > inputTokens) return null;
    cachedInputTokens = raw.cachedInputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function parseState(raw: unknown): StagehandSpendState {
  if (
    !obj(raw) ||
    !onlyKeys(raw, [
      'schemaVersion',
      'currency',
      'priceBasis',
      'azureTariffVerified',
      'targetCents',
      'maxCents',
      'settledCents',
      'reservedCents',
      'calls',
    ]) ||
    raw.schemaVersion !== 1 ||
    raw.currency !== 'USD' ||
    raw.priceBasis !== 'public-openai-estimate' ||
    raw.azureTariffVerified !== false ||
    raw.targetCents !== STAGEHAND_SPEND_TARGET_CENTS ||
    raw.maxCents !== STAGEHAND_SPEND_MAX_CENTS ||
    !integer(raw.settledCents) ||
    !integer(raw.reservedCents) ||
    !obj(raw.calls)
  )
    throw fail('SPEND_STATE_INVALID');
  let settled = 0;
  let reserved = 0;
  const calls: Record<string, Call> = {};
  for (const [id, value] of Object.entries(raw.calls)) {
    if (
      !obj(value) ||
      value.callId !== id ||
      (value.status !== 'reserved' && value.status !== 'retained' && value.status !== 'settled') ||
      !integer(value.estimatedCents) ||
      !integer(value.inputTokenUpperBound) ||
      typeof value.reservedAt !== 'string'
    )
      throw fail('SPEND_STATE_INVALID');
    const call = {
      callId: id,
      status: value.status,
      estimatedCents: value.estimatedCents,
      inputTokenUpperBound: value.inputTokenUpperBound,
      reservedAt: value.reservedAt,
    } as Call;
    if (value.status === 'settled') {
      const u = parseStoredUsage(value.usage);
      if (
        !onlyKeys(value, [
          'callId',
          'status',
          'estimatedCents',
          'inputTokenUpperBound',
          'reservedAt',
          'settledAt',
          'actualCostCents',
          'usage',
        ]) ||
        !integer(value.actualCostCents) ||
        !u ||
        typeof value.settledAt !== 'string'
      )
        throw fail('SPEND_STATE_INVALID');
      call.actualCostCents = value.actualCostCents;
      call.usage = u;
      call.settledAt = value.settledAt;
      settled += value.actualCostCents;
    } else {
      if (
        value.status === 'reserved' &&
        !onlyKeys(value, [
          'callId',
          'status',
          'estimatedCents',
          'inputTokenUpperBound',
          'reservedAt',
        ])
      )
        throw fail('SPEND_STATE_INVALID');
      if (
        value.status === 'retained' &&
        (!onlyKeys(value, [
          'callId',
          'status',
          'estimatedCents',
          'inputTokenUpperBound',
          'reservedAt',
          'retainedAt',
          'retainedReason',
        ]) ||
          typeof value.retainedAt !== 'string' ||
          (value.retainedReason !== 'provider_error' &&
            value.retainedReason !== 'usage_missing' &&
            value.retainedReason !== 'resume_unknown'))
      )
        throw fail('SPEND_STATE_INVALID');
      call.retainedReason = value.retainedReason as Call['retainedReason'];
      call.retainedAt = value.retainedAt as string | undefined;
      reserved += value.estimatedCents;
    }
    calls[id] = call;
  }
  if (
    settled !== raw.settledCents ||
    reserved !== raw.reservedCents ||
    settled + reserved > STAGEHAND_SPEND_MAX_CENTS
  )
    throw fail('SPEND_STATE_INVALID');
  return {
    schemaVersion: 1,
    currency: 'USD',
    priceBasis: 'public-openai-estimate',
    azureTariffVerified: false,
    targetCents: STAGEHAND_SPEND_TARGET_CENTS,
    maxCents: STAGEHAND_SPEND_MAX_CENTS,
    settledCents: settled,
    reservedCents: reserved,
    calls,
  };
}

async function ensureInitializationMarker(path: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) !== INITIALIZATION_MARKER) throw fail('SPEND_STATE_INVALID');
    return;
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (!isErrno(error, 'ENOENT')) throw fail('SPEND_STATE_INVALID');
  }

  const parent = dirname(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(INITIALIZATION_MARKER, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    directory = await open(parent, constants.O_RDONLY);
    await directory.sync();
    await directory.close();
    directory = undefined;
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      try {
        if ((await readFile(path, 'utf8')) === INITIALIZATION_MARKER) return;
      } catch {
        // Fall through to the generic fail-closed error.
      }
    }
    throw error instanceof ModelError ? error : fail('SPEND_STATE_WRITE_FAILED');
  } finally {
    await handle?.close().catch(() => undefined);
    await directory?.close().catch(() => undefined);
  }
}

async function load(
  path: string,
  markerPath: string,
  initialize: boolean,
): Promise<StagehandSpendState> {
  let markerPresent = false;
  try {
    markerPresent = (await readFile(markerPath, 'utf8')) === INITIALIZATION_MARKER;
    if (!markerPresent) throw fail('SPEND_STATE_INVALID');
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (!isErrno(error, 'ENOENT')) throw fail('SPEND_STATE_INVALID');
  }

  try {
    const state = parseState(JSON.parse(await readFile(path, 'utf8')));
    if (!markerPresent) await ensureInitializationMarker(markerPath);
    return state;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      if (error instanceof ModelError) throw error;
      throw fail('SPEND_STATE_INVALID');
    }
    if (!initialize || markerPresent) throw fail('SPEND_STATE_INVALID');
    await ensureInitializationMarker(markerPath);
    return fresh();
  }
}

async function write(path: string, state: StagehandSpendState): Promise<void> {
  const parent = dirname(path);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    directory = await open(parent, constants.O_RDONLY);
    await directory.sync();
    await directory.close();
    directory = undefined;
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw fail('SPEND_STATE_WRITE_FAILED');
  } finally {
    await handle?.close().catch(() => undefined);
    await directory?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
  }
}

type Lock = { path: string; handle: Awaited<ReturnType<typeof open>> };
async function acquire(path: string): Promise<Lock> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {
    throw fail('SPEND_LOCKED');
  });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, 'utf8');
    await handle.sync();
    return { path: lockPath, handle };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error instanceof ModelError ? error : fail('SPEND_LOCKED');
  }
}
async function release(lock: Lock): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  await unlink(lock.path).catch((error) => {
    if (!isErrno(error, 'ENOENT')) throw fail('SPEND_LOCKED');
  });
}

function retain(state: StagehandSpendState, id: string, reason: Call['retainedReason']): void {
  const call = state.calls[id];
  if (!call || call.status === 'settled') return;
  call.status = 'retained';
  call.retainedReason = reason;
  call.retainedAt = new Date().toISOString();
}
function settle(state: StagehandSpendState, id: string, u: StagehandUsage): void {
  const call = state.calls[id];
  if (!call || call.status === 'settled') return;
  const actual = cost(u.inputTokens, u.outputTokens, IN_CENTS_PER_M);
  const reserved = state.reservedCents - call.estimatedCents;
  if (reserved < 0 || state.settledCents + actual + reserved > STAGEHAND_SPEND_MAX_CENTS)
    throw fail('BUDGET_EXCEEDED');
  call.status = 'settled';
  call.actualCostCents = actual;
  call.usage = u;
  call.settledAt = new Date().toISOString();
  delete call.retainedAt;
  delete call.retainedReason;
  state.reservedCents = reserved;
  state.settledCents += actual;
}

async function dispatch(
  c: Config,
  bodyJson: string,
): Promise<{
  text: string | null;
  usage: StagehandUsage | null;
  refusal: boolean;
  incomplete: boolean;
  failed: boolean;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeout);
  let response: Response;
  let raw: unknown;
  try {
    response = await c.fetch(c.endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': c.key },
      body: bodyJson,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw fail('PROVIDER_ERROR');
    raw = await response.json();
  } catch (error) {
    throw error instanceof ModelError ? error : fail('PROVIDER_ERROR');
  } finally {
    clearTimeout(timer);
  }
  if (!obj(raw)) throw fail('PROVIDER_ERROR');
  let text = typeof raw.output_text === 'string' ? raw.output_text : null;
  let refusal = false;
  for (const item of Array.isArray(raw.output) ? raw.output : []) {
    if (!obj(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!obj(content)) continue;
      if (content.type === 'refusal') refusal = true;
      if (text === null && content.type === 'output_text' && typeof content.text === 'string')
        text = content.text;
    }
  }
  const incomplete = raw.status === 'incomplete' || obj(raw.incomplete_details);
  return {
    text,
    usage: parseUsage(raw.usage),
    refusal,
    incomplete,
    failed:
      (!incomplete && raw.status !== 'completed') ||
      (raw.error !== undefined && raw.error !== null),
  };
}

async function run(c: Config, params: StagehandGenerateParams): Promise<Result> {
  const prepared = prepare(params, c.maxOutput);
  const estimate = cost(prepared.inputTokens, c.maxOutput, CACHE_WRITE_CENTS_PER_M);
  const lock = await acquire(c.path);
  try {
    const state = await load(c.path, c.markerPath, c.initialize);
    c.initialize = false;
    for (const call of Object.values(state.calls))
      if (call.status === 'reserved') retain(state, call.callId, 'resume_unknown');
    if (
      Object.values(state.calls).some(
        (call) => call.status === 'retained' && call.retainedReason === 'resume_unknown',
      )
    )
      await write(c.path, state);
    if (state.settledCents + state.reservedCents + estimate > STAGEHAND_SPEND_MAX_CENTS)
      throw fail('BUDGET_EXCEEDED');
    const id = randomUUID();
    state.calls[id] = {
      callId: id,
      status: 'reserved',
      estimatedCents: estimate,
      inputTokenUpperBound: prepared.inputTokens,
      reservedAt: new Date().toISOString(),
    };
    state.reservedCents += estimate;
    await write(c.path, state);
    let result;
    try {
      result = await dispatch(c, prepared.bodyJson);
    } catch (error) {
      retain(state, id, 'provider_error');
      await write(c.path, state);
      throw error instanceof ModelError ? error : fail('PROVIDER_ERROR');
    }
    if (!result.usage) {
      retain(state, id, 'usage_missing');
      await write(c.path, state);
      throw fail('USAGE_MISSING');
    }
    if (result.failed) {
      settle(state, id, result.usage);
      await write(c.path, state);
      throw fail('PROVIDER_ERROR');
    }
    if (result.refusal) {
      settle(state, id, result.usage);
      await write(c.path, state);
      throw fail('MODEL_REFUSED');
    }
    if (result.incomplete) {
      settle(state, id, result.usage);
      await write(c.path, state);
      throw fail('MODEL_TRUNCATED');
    }
    if (result.text === null) {
      settle(state, id, result.usage);
      await write(c.path, state);
      throw fail('RESPONSE_INVALID');
    }
    let structured: unknown;
    try {
      structured = JSON.parse(result.text);
    } catch {
      settle(state, id, result.usage);
      await write(c.path, state);
      throw fail('RESPONSE_INVALID');
    }
    settle(state, id, result.usage);
    await write(c.path, state);
    return {
      role: 'assistant',
      content: [{ type: 'text', text: result.text }],
      outputFormat: 'json_schema',
      structuredContent: structured,
      usage: result.usage,
    };
  } finally {
    await release(lock);
  }
}

async function inspect(path: string): Promise<StagehandSpendState> {
  return load(path, `${path}.initialized`, false);
}

/** Factory returns one bounded Stagehand v4 callback plus read-only inspection. */
export function createStagehandModel(options: StagehandModelOptions) {
  const c = configure(options);
  return {
    generate: (params: StagehandGenerateParams) => run(c, params),
    readSpendState: () => inspect(c.path),
  };
}
