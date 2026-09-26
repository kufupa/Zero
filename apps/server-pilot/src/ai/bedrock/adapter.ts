export interface ModelInvokeInput {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema?: Record<string, unknown>;
  /** Caller cancellation must reach the approved transport. */
  signal?: AbortSignal;
  /** Absolute epoch deadline; adapters must fail closed after it. */
  deadlineAt?: number;
}

export interface ModelInvokeResult {
  modelId: string;
  output: Record<string, unknown>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    latencyMs: number;
    estimatedCostUsd: number;
    rateTableVersion: string;
  };
  /** Route/model provenance is optional for legacy adapters and required by U5. */
  provenance?: {
    routeId: string;
    protocol: string;
    modelId: string;
    purpose?: 'draft' | 'extraction' | 'shadow' | 'judge';
    usageSource: 'reported' | 'unknown';
  };
}

export interface ModelAdapter {
  invoke(input: ModelInvokeInput): Promise<ModelInvokeResult>;
}
