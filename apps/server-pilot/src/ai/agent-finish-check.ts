export type AgentFinishVerdict = { ok: boolean; errors: string[] };

const REQUIRED_KEYS = ['tests_pass', 'typecheck_new', 'sha', 'files', 'tests'] as const;
const GIT_SHA = /^[0-9a-f]{7,40}$/i;
const PLACEHOLDER_SHA = /^(0+|deadbeef+|tbd|todo|placeholder|sha|head|unknown)$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function listedPaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim());
}

export function evaluateAgentFinishCheck(input: unknown): AgentFinishVerdict {
  const errors: string[] = [];
  const check = record(input);
  if (!check) return { ok: false, errors: ['check must be an object'] };

  for (const key of REQUIRED_KEYS) {
    if (!(key in check)) errors.push(`missing ${key}`);
  }

  if ('tests_pass' in check && check.tests_pass !== true) errors.push('tests_pass must be true');
  if ('typecheck_new' in check && check.typecheck_new !== 0) errors.push('typecheck_new must be 0');
  if ('files' in check && !listedPaths(check.files)) errors.push('files not listed');
  if ('tests' in check && !listedPaths(check.tests)) errors.push('tests not listed');
  if ('sha' in check) {
    const sha = typeof check.sha === 'string' ? check.sha.trim() : '';
    if (!GIT_SHA.test(sha) || PLACEHOLDER_SHA.test(sha)) errors.push('placeholder sha');
  }

  return { ok: errors.length === 0, errors };
}

export function evaluateAgentFinishCheckJson(text: string): AgentFinishVerdict {
  try {
    return evaluateAgentFinishCheck(JSON.parse(text) as unknown);
  } catch {
    return { ok: false, errors: ['invalid json'] };
  }
}
