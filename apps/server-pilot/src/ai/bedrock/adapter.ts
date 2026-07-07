export interface ModelInvokeInput {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema?: Record<string, unknown>;
}

export interface ModelInvokeResult {
  modelId: string;
  output: Record<string, unknown>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
}

export interface ModelAdapter {
  invoke(input: ModelInvokeInput): Promise<ModelInvokeResult>;
}
