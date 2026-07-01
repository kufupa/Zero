import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function getPostgresSslOptions() {
  const caPath = join(dirname(fileURLToPath(import.meta.url)), '../../deploy/rds-ca-global.pem');
  return { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') } as const;
}
