export const DEMO_FEATURES = {
  showWorkQueues: true,
  showAiDraftPreview: true,
  showAssistantChatUi: false,
} as const;

export type DemoFeatureKey = keyof typeof DEMO_FEATURES;
