import type { ModelAdapter, ModelInvokeInput, ModelInvokeResult } from './adapter.js';

export type LocalModelRoutePurpose = 'draft' | 'extraction' | 'shadow' | 'judge';

export type LocalModelRouteEvidence = {
  routeId: string;
  /** The sole workflow purpose authorized to use this route. */
  purpose: LocalModelRoutePurpose;
  protocol: 'in_process';
  access: 'current_app';
  egress: 'none';
  retention: 'bounded';
  usage: 'reported';
  modelId: string;
};

export type LocalModelTransportRequest = {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  files?: ModelInvokeInput['files'];
  images?: ModelInvokeInput['images'];
  maxOutputTokens?: number;
  maxInputBytes?: number;
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type LocalModelTransportResult = {
  /** The approved transport returns structured JSON or a JSON string. */
  output: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
};

export type LocalModelTransport = (
  request: LocalModelTransportRequest,
) => Promise<LocalModelTransportResult>;

export type LocalModelAdapterConfig = {
  route?: LocalModelRouteEvidence;
  transport: LocalModelTransport;
  defaultModelId?: string;
  /** Real admission/budget reservation supplied by the installed transport owner. */
  reserveCalls?: ModelAdapter['reserveCalls'];
};

export class LocalModelRouteUnavailableError extends Error {
  readonly code = 'LOCAL_MODEL_ROUTE_UNAVAILABLE';

  constructor(message = 'approved local model route is unavailable') {
    super(message);
    this.name = 'LocalModelRouteUnavailableError';
  }
}

export class LocalModelAdapter implements ModelAdapter {
  private readonly route: LocalModelRouteEvidence;
  private readonly transport: LocalModelTransport;
  private readonly defaultModelId: string;
  readonly reserveCalls?: ModelAdapter['reserveCalls'];

  constructor(config: LocalModelAdapterConfig) {
    if (!config.route) throw new LocalModelRouteUnavailableError();
    if (typeof config.transport !== 'function') {
      throw new LocalModelRouteUnavailableError('approved local model transport is unavailable');
    }
    if (config.reserveCalls !== undefined && typeof config.reserveCalls !== 'function') {
      throw new LocalModelRouteUnavailableError('approved local model reservation is unavailable');
    }
    if (
      !config.route.routeId ||
      !config.route.purpose ||
      config.route.protocol !== 'in_process' ||
      config.route.access !== 'current_app' ||
      config.route.egress !== 'none' ||
      config.route.retention !== 'bounded' ||
      config.route.usage !== 'reported' ||
      !config.route.modelId
    ) {
      throw new LocalModelRouteUnavailableError(
        'approved local model route evidence is incomplete',
      );
    }
    if (config.defaultModelId !== undefined && config.defaultModelId !== config.route.modelId) {
      throw new LocalModelRouteUnavailableError(
        'approved local model default does not match route evidence',
      );
    }
    this.route = config.route;
    this.transport = config.transport;
    this.defaultModelId = config.defaultModelId ?? config.route.modelId;
    if (config.reserveCalls) {
      const reserveCalls = config.reserveCalls;
      this.reserveCalls = async (count, signal) => {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(count) || count < 1) throw new Error('local model reservation count invalid');
        await reserveCalls(count, signal);
        signal.throwIfAborted();
      };
    }
  }

  async invoke(input: ModelInvokeInput): Promise<ModelInvokeResult> {
    if (!input.modelId) {
      throw new LocalModelRouteUnavailableError('local model id is required');
    }
    const modelId = input.modelId === 'approved-local' ? this.defaultModelId : input.modelId;
    if (modelId !== this.route.modelId) {
      throw new LocalModelRouteUnavailableError(
        `model is not approved for local ${this.route.purpose} route`,
      );
    }
    const callerSignal = input.signal;
    if (callerSignal?.aborted) throw abortError('local model invocation aborted');
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      throw abortError('local model invocation deadline exceeded');
    }

    // The in-process transport owns the actual model call. We only compose a
    // cancellation signal; no URL/client/socket is initialized here.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    const remaining =
      input.deadlineAt === undefined ? undefined : Math.max(0, input.deadlineAt - Date.now());
    const timeout =
      remaining === undefined ? undefined : setTimeout(() => controller.abort(), remaining);

    try {
      const result = await this.transport({
        modelId,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        ...(input.files?.length ? { files: input.files } : {}),
        ...(input.images?.length ? { images: input.images } : {}),
        ...(input.maxOutputTokens ? {maxOutputTokens:input.maxOutputTokens} : {}),
        ...(input.maxInputBytes ? {maxInputBytes:input.maxInputBytes} : {}),
        responseSchema: input.responseSchema,
        // Preserve the caller signal identity when there is no deadline;
        // deadline-bound calls use the merged controller signal so either
        // cancellation source reaches the in-process transport.
        signal: callerSignal && input.deadlineAt === undefined ? callerSignal : controller.signal,
      });
      if (callerSignal?.aborted || controller.signal.aborted) {
        throw abortError('local model invocation aborted');
      }
      const output = parseLocalModelOutput(result.output);
      const usage = validateUsage(result.usage);
      return {
        modelId,
        output,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
          latencyMs: usage.latencyMs,
          estimatedCostUsd: 0,
          rateTableVersion: `local:${this.route.routeId}`,
        },
        provenance: {
          routeId: this.route.routeId,
          protocol: this.route.protocol,
          modelId,
          purpose: this.route.purpose,
          usageSource: 'reported',
        },
      };
    } catch (error) {
      if (isAbortError(error) || callerSignal?.aborted || controller.signal.aborted) {
        throw abortError('local model invocation aborted');
      }
      if (error instanceof LocalModelRouteUnavailableError) throw error;
      if (error instanceof Error && error.message === 'local model output was not valid JSON')
        throw error;
      // Do not pass transport payloads, credentials, or prompt contents into
      // a generic model error. The route remains safe to retry/manual-review.
      throw new Error('local model invocation failed safely');
    } finally {
      if (timeout) clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function parseLocalModelOutput(output: unknown): Record<string, unknown> {
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output);
    } catch {
      throw new Error('local model output was not valid JSON');
    }
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('local model output was not valid JSON');
  }
  return output as Record<string, unknown>;
}

function validateUsage(
  usage: LocalModelTransportResult['usage'],
): LocalModelTransportResult['usage'] {
  if (
    !usage ||
    !Number.isInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    !Number.isFinite(usage.latencyMs) ||
    usage.latencyMs < 0
  ) {
    throw new Error('local model usage was not reported');
  }
  return usage;
}

export function createLocalModelAdapter(config: LocalModelAdapterConfig): LocalModelAdapter {
  return new LocalModelAdapter(config);
}
