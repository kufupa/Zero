import { describe, expect, it } from 'vitest';
import {
  EXTRACTION_DEFAULT_PROMPT_MAX_CHARS,
  extractionPromptMaxChars,
  extractionReasoningEffort,
  extractionVisionEnabled,
} from '../src/ai/extraction/config.js';

describe('inbound extraction env', () => {
  it('defaults Azure Luna reasoning to max and accepts explicit supported effort values', () => {
    expect(extractionReasoningEffort({})).toBe('max');
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      expect(extractionReasoningEffort({ EXTRACTION_REASONING_EFFORT: effort })).toBe(effort);
    }
    expect(() => extractionReasoningEffort({ EXTRACTION_REASONING_EFFORT: 'none' })).toThrow(
      /EXTRACTION_REASONING_EFFORT/,
    );
  });

  it('defaults the user-prompt cap to 200,000 characters and validates an override', () => {
    expect(EXTRACTION_DEFAULT_PROMPT_MAX_CHARS).toBe(200_000);
    expect(extractionPromptMaxChars({})).toBe(200_000);
    expect(extractionPromptMaxChars({ EXTRACTION_PROMPT_MAX_CHARS: '120000' })).toBe(120_000);
    for (const raw of ['0', '-1', '1.2', 'abc']) {
      expect(() => extractionPromptMaxChars({ EXTRACTION_PROMPT_MAX_CHARS: raw })).toThrow(
        /EXTRACTION_PROMPT_MAX_CHARS/,
      );
    }
  });

  it('enables extraction vision by default and supports explicit on/off values', () => {
    expect(extractionVisionEnabled({})).toBe(true);
    for (const value of ['on', 'true', '1']) {
      expect(extractionVisionEnabled({ EXTRACTION_VISION: value })).toBe(true);
    }
    for (const value of ['off', 'false', '0']) {
      expect(extractionVisionEnabled({ EXTRACTION_VISION: value })).toBe(false);
    }
    expect(() => extractionVisionEnabled({ EXTRACTION_VISION: 'maybe' })).toThrow(/EXTRACTION_VISION/);
  });
});
