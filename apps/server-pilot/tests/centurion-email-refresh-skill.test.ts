import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const skillPath = fileURLToPath(
  new URL('../../../.cursor/skills/centurion-email-refresh/SKILL.md', import.meta.url),
);

describe('connected mailbox refresh skill contract', () => {
  it('requires a metadata gate and approved private raw path', () => {
    const skill = readFileSync(skillPath, 'utf8');
    const compact = skill.replace(/\s+/g, ' ');

    expect(compact).toContain('metadata-only read-only gate');
    expect(compact).toContain('active connected transport');
    expect(compact).toContain('active connected transport set is non-empty;');
    expect(compact).toContain('transport IDs are deterministically sorted and bound to one');
    expect(compact).toContain('`asOf` value');
    expect(compact).toContain('every later message, thread, and KPI selection is constrained');
    expect(compact).toContain(
      'must not read bodies, subjects, addresses, attachment names, or raw MIME.',
    );
    expect(compact).toContain(
      'no quarantine, address-derived, named-source, or inferred fallback enters scope.',
    );
    expect(compact).toContain('approved local private raw-dump path');
    expect(compact).toContain('must not emit mail content to stdout or stderr');
    expect(compact).toContain('BLOCKED_LOCAL_PRIVATE_DB_ACCESS_UNAVAILABLE');
    expect(compact).toContain('Never use an allow-empty scope');
    expect(compact).toContain(
      'Raw PII must never travel via terminal stdout/stderr, Git, web, remote MCP/API, or docs.',
    );
    expect(compact).toContain('Approved remote raw-corpus transfer is allowed');
    expect(compact).toContain('byte-count plus SHA-256 verification');
  });

  it('does not embed named-source or remote-transfer workflows', () => {
    const skill = readFileSync(skillPath, 'utf8');

    expect(skill).not.toMatch(/\bcenturion\b/i);
    expect(skill).not.toMatch(/\bpenny\b/i);
    expect(skill).not.toMatch(/\baws\s+s3\b/i);
    expect(skill).not.toMatch(/\bs3:\/\//i);
    expect(skill).not.toMatch(/ssm-run-command/i);
  });
});
