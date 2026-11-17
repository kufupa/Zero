import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) throw new Error('trace privacy worker requires a parent port');

try {
  const input = workerData as { rawBytes: Uint8Array; secretValues: string[] };
  const moduleUrl = new URL(
    import.meta.url.endsWith('.ts') ? './trace-privacy.ts' : './trace-privacy.js',
    import.meta.url,
  );
  const { sanitizeTraceArchiveBytes } = await import(moduleUrl.href);
  const bytes = sanitizeTraceArchiveBytes(input.rawBytes, input.secretValues);
  parentPort.postMessage({ ok: true, bytes: new Uint8Array(bytes) });
} catch (error) {
  if (process.env.HMS_PROOF_DIAGNOSTICS === '1' && error instanceof Error) {
    const frames = (error.stack ?? '').split('\n').slice(1).filter((line) =>
      /^\s+at [\w.$/:<> ()-]+:\d+:\d+\)?$/.test(line),
    ).slice(0, 5);
    process.stderr.write(`${JSON.stringify({ type: 'HMS_TRACE_PRIVACY_DIAGNOSTIC', frames })}\n`);
  }
  parentPort.postMessage({ ok: false });
}
