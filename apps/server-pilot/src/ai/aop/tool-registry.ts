import type { createTool } from '@mastra/core/tools';

/**
 * The only tools the reservationist agent accepts through `aopTools`.
 * Each entry must be a pure helper (pick/format over its inputs): no send,
 * no HMS write, no IO. Add tools here in code review, never at call sites.
 */
export const AOP_TOOL_REGISTRY: Readonly<Record<string, ReturnType<typeof createTool>>> = Object.freeze({});
