import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const actionScript = fileURLToPath(new URL('../scripts/hms-stagehand-action.mjs', import.meta.url));
const temporaryRoots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

async function runAction(input: {
  proof: Record<string, unknown>;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hms-stagehand-action-status-'));
  temporaryRoots.push(root);
  const ownerDir = join(root, '.private/stagehand-trial-20260917');
  await mkdir(ownerDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(ownerDir, 'discovery-owner.json'),
    JSON.stringify({ controlToken: 'a'.repeat(64), marker: 'synthetic-owner-marker' }),
    { mode: 0o600 },
  );

  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/state' && request.method === 'GET') {
      response.writeHead(200);
      response.end(
        JSON.stringify({
          phase: 'ready',
          terminal: false,
          marker: 'synthetic-owner-marker',
          pageUrl: 'http://127.0.0.1:1/synthetic',
        }),
      );
      return;
    }
    if (request.url === '/command' && request.method === 'POST') {
      request.resume();
      response.writeHead(200);
      response.end(JSON.stringify(input.proof));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MOCK_SERVER_ADDRESS_REQUIRED');

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [actionScript, 'account'], {
      cwd: root,
      env: {
        ...process.env,
        HMS_STAGEHAND_CONTROL_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('hms-stagehand-action capture status', () => {
  it('surfaces rejected capture status without equating owner HTTP 200 with completion', async () => {
    const result = await runAction({
      proof: {
        sequence: 7,
        terminal: false,
        violation: null,
        capturePersistence: {
          ok: false,
          partial: true,
          rejectedCount: 1,
          reason: 'UNSAFE_SECRET_CONTENT',
          message: 'SYNTH-RAW-ERROR',
          raw: 'SYNTH-RAW-CAPTURE',
        },
      },
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(output).toMatchObject({
      action: 'account',
      commandSuccess: true,
      captureComplete: false,
      capturePersistence: {
        ok: false,
        partial: true,
        rejectedCount: 1,
        reason: 'UNSAFE_SECRET_CONTENT',
      },
      modelCalls: 0,
    });
    expect(output).not.toHaveProperty('success');
    expect(JSON.stringify(output)).not.toContain('SYNTH-RAW-ERROR');
    expect(JSON.stringify(output)).not.toContain('SYNTH-RAW-CAPTURE');
  });

  it('keeps final capture completion unknown after a clean command acknowledgement', async () => {
    const result = await runAction({
      proof: {
        sequence: 8,
        terminal: false,
        violation: null,
        capturePersistence: { ok: true, partial: false, rejectedCount: 0 },
      },
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(output).toMatchObject({
      action: 'account',
      commandSuccess: true,
      captureComplete: 'unknown',
      capturePersistence: { ok: true, partial: false, rejectedCount: 0 },
    });
    expect(output).not.toHaveProperty('success');
  });
});
