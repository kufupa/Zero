import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const composeEditorSource = readFileSync(
  new URL('../hooks/use-compose-editor.ts', import.meta.url),
  'utf8',
);
const aiChatSource = readFileSync(
  new URL('../components/create/ai-chat.tsx', import.meta.url),
  'utf8',
);

describe('useComposeEditor inline file handling', () => {
  it('defaults inline file handling to enabled while accepting an opt-out', () => {
    expect(composeEditorSource).toContain('enableInlineFileHandling = true');
    expect(composeEditorSource).toContain('enableInlineFileHandling?: boolean;');
  });

  it('adds current FileHandler configuration only when inline handling is enabled', () => {
    expect(composeEditorSource).toMatch(
      /\.\.\.\(enableInlineFileHandling\s*\?\s*\[\s*FileHandler\.configure\(\{/,
    );
    expect(composeEditorSource.match(/FileHandler\.configure\(/g)).toHaveLength(1);
    expect(composeEditorSource).toContain(
      "allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp']",
    );
    expect(composeEditorSource).toContain('onDrop: (currentEditor, files, pos) =>');
    expect(composeEditorSource).toContain('onPaste: (currentEditor, files, htmlContent) =>');
  });

  it('keeps AI chat on default inline file handling', () => {
    expect(aiChatSource).toContain('const editor = useComposeEditor({');
    expect(aiChatSource).not.toContain('enableInlineFileHandling');
  });
});
