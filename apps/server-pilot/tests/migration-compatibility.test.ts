import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { deploymentSandbox } from './helpers/deploy-sandbox.js';
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const serverRoot = fileURLToPath(new URL('../', import.meta.url));
vi.setConfig({ testTimeout: 20_000 });

function cli(url?: string) {
  const env = { ...process.env, DATABASE_URL: url };
  delete env.TEST_DATABASE_URL;
  delete env.VITEST_ALLOW_PILOT_RDS;
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/check-migration-compatibility.ts'],
    {
      cwd: serverRoot,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
}

describe('read-only migration compatibility CLI on PostgreSQL', () => {
  it('required existing ingestion suites fail instead of skipping without a reachable explicit test DB', () => {
    for (const url of [undefined, 'postgresql://postgres@127.0.0.1:1/unused?sslmode=disable']) {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          "await import('./tests/helpers/test-db.ts')",
        ],
        {
          cwd: serverRoot,
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            DATABASE_URL: undefined,
            TEST_DATABASE_URL: url,
            CONFIRM_DISPOSABLE_TEST_DB: '1',
            INGESTION_DB_TEST_REQUIRED: '1',
            VITEST_ALLOW_PILOT_RDS: undefined,
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/requires TEST_DATABASE_URL|Ingestion regressions require/);
    }
  });

  it('accepts every committed migration and the real schema', async () => {
    await withIngestionDb(
      async ({ url, sql }) => {
        const before = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
        const result = cli(url);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('compatible');
        expect(await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(before);
      },
      { seed: false },
    );
  });

  it('refuses activation from the production 0023 boundary', async () => {
    await withIngestionDb(
      async ({ url }) => {
        const result = cli(url);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('pending');
      },
      { through: 23, seed: false },
    );
  });

  it('refuses missing ledger, mismatched hashes, and unknown newer history', async () => {
    await withIngestionDb(
      async ({ url, sql }) => {
        await sql`UPDATE drizzle.__drizzle_migrations SET hash = 'wrong' WHERE id = 1`;
        expect(cli(url).stderr).toContain('mismatch');
        await sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = 1`;
        expect(cli(url).stderr).toContain('mismatch');
        await sql`DROP TABLE drizzle.__drizzle_migrations`;
        expect(cli(url).stderr).toContain('ledger');
      },
      { seed: false },
    );
    await withIngestionDb(
      async ({ url, sql }) => {
        await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('unknown', 9999999999999)`;
        expect(cli(url).stderr).toContain('newer');
      },
      { seed: false },
    );
  });

  it('refuses current ledger with missing required column or table', async () => {
    await withIngestionDb(
      async ({ url, sql }) => {
        await sql`ALTER TABLE ai_workflow_run DROP COLUMN read_request`;
        expect(cli(url).stderr).toContain('ai_workflow_run.read_request');
        await sql`DROP TABLE mail_baseline_projection`;
        expect(cli(url).stderr).toContain('mail_baseline_projection');
        await sql`ALTER TABLE ai_workflow_run DROP COLUMN priority`;
        expect(cli(url).stderr).toContain('ai_workflow_run.priority');
        await sql`DROP TABLE work_event`;
        expect(cli(url).stderr).toContain('work_event');
      },
      { seed: false },
    );
  });

  it('refuses missing conflict arbiter and primary key indexes', async () => {
    await withIngestionDb(
      async ({ url, sql }) => {
        await sql`DROP INDEX ai_workflow_run_idempotency_uidx`;
        expect(cli(url).stderr).toContain('ai_workflow_run_idempotency_uidx');
        await sql`ALTER TABLE ai_workflow_run DROP CONSTRAINT ai_workflow_run_pkey`;
        expect(cli(url).stderr).toContain('ai_workflow_run.id');
      },
      { seed: false },
    );
  });

  it('refuses changed partial unique index predicates', async () => {
    await withIngestionDb(
      async ({ url, sql }) => {
        await sql`DROP INDEX message_ingest_uidl_uidx`;
        await sql`CREATE UNIQUE INDEX message_ingest_uidl_uidx ON message (ingest_mailbox_id, pop3_uidl) WHERE direction = 'outbound'`;
        expect(cli(url).stderr).toContain('message_ingest_uidl_uidx');
      },
      { seed: false },
    );
  });

  it('refuses a changed application column type', async () => {
    await withIngestionDb(
      async ({ url, sql }) => {
        await sql`ALTER TABLE ai_workflow_run ALTER COLUMN read_request TYPE text USING read_request::text`;
        expect(cli(url).stderr).toContain('type');
      },
      { seed: false },
    );
  });

  it('fails closed without a DB URL or on an unreachable DB', () => {
    expect(cli().stderr).toContain('DATABASE_URL required');
    const result = cli('postgresql://postgres@127.0.0.1:1/unused?sslmode=disable');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('compatibility');
  });
});

describe('schema gate precedes operational activation', () => {
  it.each(['deploy-ec2.sh', 'ops-restart.sh', 'pm2-boot.sh'])(
    '%s refuses before build/runtime/process mutations',
    async (file) => {
      await withIngestionDb(
        async ({ url }) => {
          const sandbox = deploymentSandbox(url);
          try {
            const result = sandbox.run(file);
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('pending');
            expect(existsSync(sandbox.marker)).toBe(false);
          } finally {
            sandbox.close();
          }
        },
        { through: 23, seed: false },
      );
    },
  );

  it.each([false, true])(
    'ops-deploy refuses before remote env bootstrap (existing=%s)',
    async (existing) => {
      await withIngestionDb(
        async ({ url }) => {
          const sandbox = deploymentSandbox(url);
          try {
            const common = join(sandbox.server, '.env.remote-common');
            const admin = join(sandbox.server, '.env.remote-admin');
            if (existing) {
              writeFileSync(common, 'unchanged common');
              writeFileSync(admin, 'unchanged admin');
            }
            const result = sandbox.run('ops-deploy.sh');
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('pending');
            expect(existsSync(sandbox.marker)).toBe(false);
            expect(existsSync(common)).toBe(existing);
            expect(existsSync(admin)).toBe(existing);
            if (existing) {
              expect(readFileSync(common, 'utf8')).toBe('unchanged common');
              expect(readFileSync(admin, 'utf8')).toBe('unchanged admin');
            }
          } finally {
            sandbox.close();
          }
        },
        { through: 23, seed: false },
      );
    },
  );

  it('explicit migration runs before verification and remote env bootstrap', async () => {
    await withIngestionDb(
      async ({ url }) => {
        const sandbox = deploymentSandbox(url);
        try {
          writeFileSync(
            join(sandbox.root, 'migrate.mjs'),
            `import postgres from ${JSON.stringify(join(serverRoot, 'node_modules/postgres/src/index.js'))};\nimport {readMigrationFiles} from ${JSON.stringify(join(serverRoot, 'node_modules/drizzle-orm/migrator.js'))};\nconst sql=postgres(process.env.DATABASE_URL,{ssl:false,onnotice:()=>{}});\nfor(const migration of readMigrationFiles({migrationsFolder:${JSON.stringify(join(serverRoot, 'drizzle'))}}).slice(24)){await sql.begin(async tx=>{for(const statement of migration.sql)await tx.unsafe(statement);await tx\`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES(\x24{migration.hash},\x24{migration.folderMillis})\`;});}\nawait sql.end();\n`,
          );
          sandbox.run('ops-deploy.sh', ['--migrate']);
          expect(readFileSync(sandbox.env.EVENTS!, 'utf8')).toBe('migrate\nbootstrap\n');
          expect(cli(url).status).toBe(0);
        } finally {
          sandbox.close();
        }
      },
      { through: 23, seed: false },
    );
  });

  it('quiesced assets-only deploy skips DB gate and server activation', async () => {
    await withIngestionDb(
      async ({ url }) => {
        const sandbox = deploymentSandbox(url);
        try {
          const result = sandbox.run('deploy-ec2.sh', ['--quiesced']);
          expect(result.stderr).not.toContain('pending');
          expect(readFileSync(sandbox.marker, 'utf8')).toBe('sudo');
        } finally {
          sandbox.close();
        }
      },
      { through: 23, seed: false },
    );
  });
});
