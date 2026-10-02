import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const writer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../deploy/write-ec2-env.sh'), 'utf8');

describe('Outlook v4 production environment writer (source only; never execute against AWS)', () => {
  it('retrieves a separate operator-provisioned Secrets Manager key and persists it server-side', () => {
    expect(writer).toContain('OUTLOOK_DEVICE_WRAPPING_KEY_SECRET_NAME');
    expect(writer).toMatch(/aws secretsmanager get-secret-value[\s\S]*--secret-id "\$OUTLOOK_DEVICE_WRAPPING_KEY_SECRET_NAME"/);
    expect(writer).toMatch(/NAVA_OUTLOOK_DEVICE_WRAPPING_KEY=\$\(quote_val "\$NAVA_OUTLOOK_DEVICE_WRAPPING_KEY"\)/);
    expect(writer).not.toMatch(/append_env NAVA_OUTLOOK_DEVICE_WRAPPING_KEY/);
  });

  it('validates exactly 32 canonical base64 bytes before replacing the production env', () => {
    expect(writer).toContain('Buffer.from(raw, "base64")');
    expect(writer).toContain('bytes.length !== 32');
    expect(writer).toContain('bytes.toString("base64") !== raw');
    expect(writer.indexOf('bytes.length !== 32')).toBeLessThan(writer.indexOf('ENV_PATH='));
    expect(writer).not.toMatch(/openssl rand|randomBytes\(|randomUUID\(/);
  });
});
