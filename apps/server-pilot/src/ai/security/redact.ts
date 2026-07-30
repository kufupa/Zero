const SECRET_PATTERNS: RegExp[] = [
  /smtp[_-]?password\s*[:=]\s*\S+/gi,
  /pop3[_-]?password\s*[:=]\s*\S+/gi,
  /\bpassword\s*[:=]\s*\S+/gi,
  /\b(jsessionid|csrftckt|cookie|set-cookie)\s*[:=]\s*\S+/gi,
  /bearer\s+[a-z0-9._-]+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /arn:aws:secretsmanager:[^\s"']+/gi,
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
];

const SYSTEM_PROMPT_PATTERN = /(<system>|<\/system>|system prompt:|# system)/gi;

export function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  return output;
}

export function redactSystemPrompt(input: string): string {
  return input.replace(SYSTEM_PROMPT_PATTERN, '[REDACTED_SYSTEM]');
}

export function redactTracePayload(input: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(input);
  const redacted = redactSystemPrompt(redactSecrets(json));
  return JSON.parse(redacted) as Record<string, unknown>;
}
