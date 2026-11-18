// Captures the two approved Labtest Save paths after HMS login.
export async function withLabtestSaveAudit(page, directory, operation) {
  if (!directory) return operation();
  const { createAudit } = await import('./fetch-quote.mjs');
  const audit = await createAudit(directory, { trace: true });
  try {
    await audit.start(page);
    return await operation();
  } finally {
    await audit.checkpoint('end').catch(() => {});
    const report = await audit.finish().catch(() => null);
    console.info('nava_labtest_save_audit', JSON.stringify({ directory, trace: report?.trace?.status,
      screenshots: report?.screenshots?.length ?? 0, status: report?.status ?? 'failed' }));
  }
}
