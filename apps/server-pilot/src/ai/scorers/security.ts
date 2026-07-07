import { enforceInboundMailPolicy } from '../security/policy.js';
import { redactSecrets } from '../security/redact.js';

export function scoreSecurityFixture(input: {
  body: string;
  requestedTools?: string[];
  mustFail: boolean;
  mustRedact?: boolean;
}): { id: string; pass: boolean; score: number; detail?: string } {
  try {
    enforceInboundMailPolicy({
      body: input.body,
      requestedTools: input.requestedTools,
    });
    if (input.mustRedact) {
      const redacted = redactSecrets(input.body);
      const pass = !redacted.includes('supersecret');
      return {
        id: 'security-redaction',
        pass,
        score: pass ? 1 : 0,
        detail: pass ? undefined : 'secret leaked in redaction output',
      };
    }
    return {
      id: 'security-policy',
      pass: !input.mustFail,
      score: input.mustFail ? 0 : 1,
      detail: input.mustFail ? 'expected policy failure' : undefined,
    };
  } catch (error) {
    return {
      id: 'security-policy',
      pass: input.mustFail,
      score: input.mustFail ? 1 : 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
