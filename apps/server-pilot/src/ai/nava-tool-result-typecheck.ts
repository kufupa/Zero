import type { adaptExistingToolResult } from './nava-tool-result.js';

type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Assert<T extends true> = T;
type RequiredData = ReturnType<typeof adaptExistingToolResult<{
  outcome: string; data: { documentCode: string };
}>>['data'];
type LegacyData = ReturnType<typeof adaptExistingToolResult<{
  outcome: string; rows: string[];
}>>['data'];
type OptionalData = ReturnType<typeof adaptExistingToolResult<{
  outcome: string; data?: { documentCode: string }; rows: string[];
}>>['data'];

/** Compiled with the server source: explicit data wins, while optional data may fall back. */
export type NavaToolResultTypeAssertions = [
  Assert<Equal<RequiredData, { documentCode: string } | undefined>>,
  Assert<Equal<LegacyData, { rows: string[] } | undefined>>,
  Assert<Equal<OptionalData, { documentCode: string } | { rows: string[] } | undefined>>,
];
