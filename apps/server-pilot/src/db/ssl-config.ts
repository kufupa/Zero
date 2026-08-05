import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function getPostgresSslOptions(databaseUrl?: string) {
  if (databaseUrl) {
    try {
      const host = new URL(databaseUrl).hostname.toLowerCase();
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
        return false as const;
      }
    } catch {
      // Invalid URLs remain fail-closed on RDS CA verification.
    }
  }
  const caPath = join(dirname(fileURLToPath(import.meta.url)), '../../deploy/rds-ca-global.pem');
  return { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') } as const;
}
