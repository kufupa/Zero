export type ExtractionReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export const EXTRACTION_DEFAULT_PROMPT_MAX_CHARS = 200_000;
const MIN_EXTRACTION_PROMPT_MAX_CHARS = 1_000;
const MAX_EXTRACTION_PROMPT_MAX_CHARS = 1_000_000;

export function extractionReasoningEffort(
  env: NodeJS.ProcessEnv = process.env,
): ExtractionReasoningEffort {
  const raw = env.EXTRACTION_REASONING_EFFORT?.trim() || 'max';
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max') return raw;
  throw new Error(`env EXTRACTION_REASONING_EFFORT must be low|medium|high|max, got: ${raw}`);
}

export function extractionPromptMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXTRACTION_PROMPT_MAX_CHARS?.trim();
  if (!raw) return EXTRACTION_DEFAULT_PROMPT_MAX_CHARS;
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_EXTRACTION_PROMPT_MAX_CHARS ||
    parsed > MAX_EXTRACTION_PROMPT_MAX_CHARS
  ) {
    throw new Error(
      `env EXTRACTION_PROMPT_MAX_CHARS must be an integer between ${MIN_EXTRACTION_PROMPT_MAX_CHARS} and ${MAX_EXTRACTION_PROMPT_MAX_CHARS}, got: ${raw}`,
    );
  }
  return parsed;
}

export function extractionVisionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.EXTRACTION_VISION?.trim();
  if (raw === undefined || raw === '') return true;
  if (raw === 'on' || raw === 'true' || raw === '1') return true;
  if (raw === 'off' || raw === 'false' || raw === '0') return false;
  throw new Error(`env EXTRACTION_VISION must be on|off|true|false|1|0, got: ${raw}`);
}
