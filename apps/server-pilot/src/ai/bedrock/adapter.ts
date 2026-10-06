export interface ModelInvokeInput {
  modelId: string;
  /** Provider-enforced completion ceiling for budgeted extraction. */
  maxOutputTokens?: number;
  /** Conservative request byte ceiling, including file bytes. */
  maxInputBytes?: number;
  systemPrompt: string;
  userPrompt: string;
  /** Only server-admitted private file bytes; never URLs or storage keys. */
  files?: readonly { filename: string; mediaType: string; data: Uint8Array }[];
  /** Original server-admitted raster bytes; image parts remain visual customer claims. */
  images?: readonly { filename: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; data: Uint8Array }[];
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
  /** Optional durable admission for a bounded multi-call extraction; it is not a model dispatch. */
  reserveCalls?(count: number, signal: AbortSignal): Promise<void>;
  invoke(input: ModelInvokeInput): Promise<ModelInvokeResult>;
}
