import {
  createStagehandModel,
  STAGEHAND_INPUT_TOKEN_LIMIT,
  type StagehandGenerateParams,
} from '../src/hms/stagehand-model.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

delete process.env.DATABASE_URL;
delete process.env.VITEST_ALLOW_PILOT_RDS;

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

const SECRET = 'azure-key-test-secret';
const PROMPT_SECRET = 'customer-prompt-private-value';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function usage(inputTokens = 14, outputTokens = 8) {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    output_tokens_details: { reasoning_tokens: 3 },
    input_tokens_details: { cached_tokens: 0 },
  };
}

function providerSuccess(content: Record<string, unknown> = { ok: true }) {
  const text = JSON.stringify(content);
  return {
    id: 'resp_test_1',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: usage(),
  };
}

function params(overrides: Partial<StagehandGenerateParams> = {}): StagehandGenerateParams {
  return {
    systemPrompt: 'system instruction',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: PROMPT_SECRET }],
      },
    ],
    responseFormat: {
      type: 'json_schema',
      name: 'Observation',
      description: 'A bounded observation',
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
    temperature: 0.2,
    ...overrides,
  };
}

async function tempSpendPath(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hms-stagehand-model-'));
  return { root, path: join(root, 'spend.json') };
}

function modelOptions(
  spendPath: string,
  fetchImpl: typeof fetch,
  overrides: Record<string, unknown> = {},
) {
  return {
    azureBaseUrl: 'https://approved-resource.openai.azure.com',
    approvedAzureOrigin: 'https://approved-resource.openai.azure.com',
    apiKey: SECRET,
    deployment: 'gpt-6-astra' as const,
    spendPath,
    initializeNewLedger: true,
    fetch: fetchImpl,
    maxOutputTokens: 64,
    ...overrides,
  };
}

describe('Stagehand v4 Azure model callback', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.VITEST_ALLOW_PILOT_RDS;
  });

  afterEach(async () => {
    while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true });
  });

  it('maps the v4 request to the exact Azure Responses route and strict Astra options', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return okResponse(providerSuccess({ ok: true }));
    };

    const model = createStagehandModel(modelOptions(path, fetchImpl));
    const result = await model.generate(params());
    const request = JSON.parse(String(calls[0]!.init?.body));

    expect(String(calls[0]!.input)).toBe(
      'https://approved-resource.openai.azure.com/openai/v1/responses',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.redirect).toBe('error');
    expect(new Headers(calls[0]!.init?.headers).get('api-key')).toBe(SECRET);
    expect(request).toMatchObject({
      model: 'gpt-6-astra',
      reasoning: { effort: 'high' },
      store: false,
      max_output_tokens: 64,
      text: {
        format: {
          type: 'json_schema',
          name: 'Observation',
          strict: true,
        },
      },
    });
    expect(request.temperature).toBeUndefined();
    expect(request.input[0]).toEqual({
      role: 'system',
      content: [{ type: 'input_text', text: 'system instruction' }],
    });
    expect(request.input[1].content).toEqual([{ type: 'input_text', text: PROMPT_SECRET }]);
    expect(request.text.format.schema).toEqual(params().responseFormat.schema);
    expect(result).toMatchObject({
      role: 'assistant',
      outputFormat: 'json_schema',
      structuredContent: { ok: true },
      usage: {
        inputTokens: 14,
        outputTokens: 8,
        totalTokens: 22,
        reasoningTokens: 3,
        cachedInputTokens: 0,
      },
    });
    expect(JSON.stringify(await model.readSpendState())).not.toContain(SECRET);
    expect(JSON.stringify(await model.readSpendState())).not.toContain(PROMPT_SECRET);
  });

  it('rejects non-Azure or origin-mismatched endpoints and any deployment other than gpt-6-astra', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const fetchImpl: typeof fetch = async () => okResponse(providerSuccess());

    expect(() =>
      createStagehandModel(
        modelOptions(path, fetchImpl, { azureBaseUrl: 'http://not-approved.test' }),
      ),
    ).toThrow(/HTTPS/);
    expect(() =>
      createStagehandModel(
        modelOptions(path, fetchImpl, { azureBaseUrl: 'https://not-azure.test' }),
      ),
    ).toThrow(/approved HTTPS Azure endpoint/);
    expect(() =>
      createStagehandModel(
        modelOptions(path, fetchImpl, {
          approvedAzureOrigin: 'https://other-resource.openai.azure.com',
        }),
      ),
    ).toThrow(/approved HTTPS Azure endpoint/);
    expect(() =>
      createStagehandModel(modelOptions(path, fetchImpl, { deployment: 'gpt-5' })),
    ).toThrow(/gpt-6-astra/);
  });

  it('refuses unsupported content or non-schema responses before dispatch', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return okResponse(providerSuccess());
    };
    const model = createStagehandModel(modelOptions(path, fetchImpl));

    await expect(
      model.generate(
        params({
          messages: [
            { role: 'user', content: [{ type: 'tool_use', id: 'secret', name: 'bad', input: {} }] },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
    await expect(
      model.generate(
        params({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  mimeType: 'image/png',
                  data: Buffer.from('fixture-image').toString('base64'),
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
    await expect(
      model.generate(params({ responseFormat: { type: 'text' } })),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
    expect(fetches).toBe(0);
  });

  it('does not expose provider failures, response bodies, key, or prompt', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const providerSecret = 'provider raw body with another-secret';
    const fetchImpl: typeof fetch = async () => new Response(providerSecret, { status: 500 });
    const model = createStagehandModel(modelOptions(path, fetchImpl));

    const error = await model.generate(params()).catch((value: unknown) => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(providerSecret);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(PROMPT_SECRET);
    expect((error as Error & { code?: string }).code).toBe('PROVIDER_ERROR');
  });

  it('refuses requests above the input bound without dispatch', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return okResponse(providerSuccess());
    };
    const model = createStagehandModel(modelOptions(path, fetchImpl));
    const huge = 'x'.repeat(272_000);

    await expect(
      model.generate(
        params({
          messages: [{ role: 'user', content: [{ type: 'text', text: huge }] }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
    expect(fetches).toBe(0);
  });

  it('counts the complete Responses body toward the input bound', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return okResponse(providerSuccess());
    };
    const model = createStagehandModel(modelOptions(path, fetchImpl));

    await expect(
      model.generate(
        params({
          responseFormat: {
            type: 'json_schema',
            name: 'Observation',
            description: 'd'.repeat(STAGEHAND_INPUT_TOKEN_LIMIT),
            schema: params().responseFormat.schema,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
    expect(fetches).toBe(0);
  });

  it('persists unique settled calls and resumes without resetting spend', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    let count = 0;
    const fetchImpl: typeof fetch = async () => {
      count += 1;
      return okResponse(providerSuccess({ ok: count === 1 }));
    };

    await createStagehandModel(modelOptions(path, fetchImpl)).generate(params());
    const first = await createStagehandModel(modelOptions(path, fetchImpl)).readSpendState();
    await createStagehandModel(modelOptions(path, fetchImpl)).generate(params());
    const second = await createStagehandModel(modelOptions(path, fetchImpl)).readSpendState();

    expect(Object.keys(second.calls)).toHaveLength(2);
    expect(new Set(Object.keys(second.calls)).size).toBe(2);
    expect(second.settledCents).toBeGreaterThanOrEqual(first.settledCents);
    expect(second.priceBasis).toBe('public-openai-estimate');
    expect(second.azureTariffVerified).toBe(false);
  });

  it('rejects a reservation at the $50 maximum before dispatch', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const existing = {
      schemaVersion: 1,
      currency: 'USD',
      priceBasis: 'public-openai-estimate',
      azureTariffVerified: false,
      targetCents: 2_500,
      maxCents: 5_000,
      settledCents: 0,
      reservedCents: 4_999,
      calls: {
        retained: {
          callId: 'retained',
          status: 'retained',
          estimatedCents: 4_999,
          inputTokenUpperBound: 1,
          reservedAt: new Date().toISOString(),
          retainedAt: new Date().toISOString(),
          retainedReason: 'provider_error',
        },
      },
    };
    await writeFile(path, JSON.stringify(existing), 'utf8');
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return okResponse(providerSuccess());
    };

    await expect(
      createStagehandModel(modelOptions(path, fetchImpl)).generate(params()),
    ).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    expect(fetches).toBe(0);
  });

  it('retains a reservation left in reserved state after a simulated crash', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const existing = {
      schemaVersion: 1,
      currency: 'USD',
      priceBasis: 'public-openai-estimate',
      azureTariffVerified: false,
      targetCents: 2_500,
      maxCents: 5_000,
      settledCents: 0,
      reservedCents: 1,
      calls: {
        unknown: {
          callId: 'unknown',
          status: 'reserved',
          estimatedCents: 1,
          inputTokenUpperBound: 1,
          reservedAt: new Date().toISOString(),
        },
      },
    };
    await writeFile(path, JSON.stringify(existing), 'utf8');
    const fetchImpl: typeof fetch = async () => okResponse(providerSuccess());
    await createStagehandModel(modelOptions(path, fetchImpl)).generate(params());
    const state = await createStagehandModel(modelOptions(path, fetchImpl)).readSpendState();
    expect(state.calls.unknown?.status).toBe('retained');
    expect(state.calls.unknown?.retainedReason).toBe('resume_unknown');
  });

  it('rejects a concurrent writer while the first provider request owns the lock', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      await held;
      return okResponse(providerSuccess());
    };
    const first = createStagehandModel(modelOptions(path, fetchImpl)).generate(params());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = createStagehandModel(modelOptions(path, fetchImpl)).generate(params());
    await expect(second).rejects.toMatchObject({ code: 'SPEND_LOCKED' });
    release();
    await first;
    expect(fetches).toBe(1);
  });

  it('fails closed on a stale lock instead of reclaiming it automatically', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    await writeFile(`${path}.lock`, JSON.stringify({ pid: 2_147_483_647 }), 'utf8');
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return okResponse(providerSuccess());
    };

    await expect(
      createStagehandModel(modelOptions(path, fetchImpl)).generate(params()),
    ).rejects.toMatchObject({
      code: 'SPEND_LOCKED',
    });
    expect(fetches).toBe(0);
  });

  it('fails closed on corrupt or missing resumed state', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const fetchImpl: typeof fetch = async () => okResponse(providerSuccess());
    await createStagehandModel(modelOptions(path, fetchImpl)).generate(params());
    await writeFile(path, '{not-json', 'utf8');
    await expect(
      createStagehandModel(modelOptions(path, fetchImpl)).generate(params()),
    ).rejects.toMatchObject({
      code: 'SPEND_STATE_INVALID',
    });
    await writeFile(path, '', 'utf8');
    await expect(
      createStagehandModel(modelOptions(path, fetchImpl)).generate(params()),
    ).rejects.toMatchObject({
      code: 'SPEND_STATE_INVALID',
    });
    await rm(path);
    await expect(
      createStagehandModel(modelOptions(path, fetchImpl, { initializeNewLedger: false })).generate(
        params(),
      ),
    ).rejects.toMatchObject({ code: 'SPEND_STATE_INVALID' });
  });

  it('does not reset a missing ledger when initialization was previously durable', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const fetchImpl: typeof fetch = async () => okResponse(providerSuccess());
    await createStagehandModel(modelOptions(path, fetchImpl)).generate(params());
    await rm(path);

    await expect(
      createStagehandModel(modelOptions(path, fetchImpl)).generate(params()),
    ).rejects.toMatchObject({
      code: 'SPEND_STATE_INVALID',
    });
  });

  it('keeps the abort deadline active while reading the provider body', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    let signal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal as AbortSignal;
      return {
        ok: true,
        json: () =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(providerSuccess()), 30);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
              },
              { once: true },
            );
          }),
      } as Response;
    };

    await expect(
      createStagehandModel(modelOptions(path, fetchImpl, { timeoutMs: 5 })).generate(params()),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('retains an ambiguous reservation after timeout/provider failure', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const fetchImpl: typeof fetch = async () => {
      throw new Error(`network body ${PROMPT_SECRET}`);
    };
    const model = createStagehandModel(modelOptions(path, fetchImpl));
    await expect(model.generate(params())).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const state = await model.readSpendState();
    const retained = Object.values(state.calls).filter((call) => call.status === 'retained');
    expect(retained).toHaveLength(1);
    expect(state.reservedCents).toBeGreaterThan(0);
  });

  it('keeps settled calls idempotent across factory resume', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const fetchImpl: typeof fetch = async () =>
      okResponse({
        ...providerSuccess({ ok: true }),
        usage: usage(100, 200),
      });
    const model = createStagehandModel(modelOptions(path, fetchImpl));
    await model.generate(params());
    const first = await model.readSpendState();
    const [firstCallId] = Object.keys(first.calls);
    const firstActual = first.calls[firstCallId!]!.actualCostCents;
    await createStagehandModel(modelOptions(path, fetchImpl)).generate(params());
    const resumed = await createStagehandModel(modelOptions(path, fetchImpl)).readSpendState();
    expect(resumed.calls[firstCallId!]!.status).toBe('settled');
    expect(resumed.calls[firstCallId!]!.actualCostCents).toBe(firstActual);
    expect(resumed.settledCents).toBe(
      Object.values(resumed.calls).reduce((sum, call) => sum + (call.actualCostCents ?? 0), 0),
    );
    expect(resumed.calls[firstCallId!]!.usage?.outputTokens).toBe(200);
  });

  it('retains inconsistent provider usage instead of settling it', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const fetchImpl: typeof fetch = async () =>
      okResponse({
        ...providerSuccess({ ok: true }),
        usage: { ...usage(), total_tokens: 23 },
      });
    const model = createStagehandModel(modelOptions(path, fetchImpl));

    await expect(model.generate(params())).rejects.toMatchObject({ code: 'USAGE_MISSING' });
    const state = await model.readSpendState();
    expect(Object.values(state.calls)[0]?.status).toBe('retained');
    expect(state.reservedCents).toBeGreaterThan(0);
  });

  it('rejects usage detail counts outside their parent totals', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const fetchImpl: typeof fetch = async () =>
      okResponse({
        ...providerSuccess({ ok: true }),
        usage: { ...usage(), output_tokens_details: { reasoning_tokens: 9 } },
      });
    const model = createStagehandModel(modelOptions(path, fetchImpl));

    await expect(model.generate(params())).rejects.toMatchObject({ code: 'USAGE_MISSING' });
    const state = await model.readSpendState();
    expect(Object.values(state.calls)[0]?.status).toBe('retained');
  });

  it('uses output_text once when Responses includes both output forms', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const text = JSON.stringify({ ok: true });
    const fetchImpl: typeof fetch = async () =>
      okResponse({
        ...providerSuccess({ ok: true }),
        output_text: text,
      });
    const result = await createStagehandModel(modelOptions(path, fetchImpl)).generate(params());

    expect(result.content[0].text).toBe(text);
    expect(result.structuredContent).toEqual({ ok: true });
  });

  it('settles usage but rejects a failed Responses status', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const fetchImpl: typeof fetch = async () =>
      okResponse({
        ...providerSuccess({ ok: true }),
        status: 'failed',
        error: { code: 'provider_failure' },
      });
    const model = createStagehandModel(modelOptions(path, fetchImpl));

    await expect(model.generate(params())).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const state = await model.readSpendState();
    expect(Object.values(state.calls)[0]?.status).toBe('settled');
    expect(state.reservedCents).toBe(0);
  });

  it('rejects a refusal or truncation with a fixed safe error', async () => {
    const { root, path } = await tempSpendPath();
    cleanup.push(root);
    const fetchImpl: typeof fetch = async () =>
      okResponse({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens', secret: PROMPT_SECRET },
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: SECRET }] }],
        usage: usage(),
      });
    const model = createStagehandModel(modelOptions(path, fetchImpl));
    const error = await model.generate(params()).catch((value: unknown) => value as Error);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(PROMPT_SECRET);
    expect((error as Error & { code?: string }).code).toBe('MODEL_REFUSED');
  });
});
