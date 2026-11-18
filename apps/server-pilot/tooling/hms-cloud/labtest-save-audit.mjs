// Captures the two approved Labtest Save paths after HMS login.
export async function withLabtestSaveAudit(page, directory, operation) {
  if (!directory) return operation();
  let audit;
  try {
    const { createAudit } = await import('./fetch-quote.mjs');
    audit = await createAudit(directory, { trace: true });
    await audit.start(page);
  } catch {
    console.info('nava_labtest_save_audit', JSON.stringify({ directory, status: 'start_failed' }));
  }
  try {
    return await operation();
  } finally {
    if (audit) {
      await audit.checkpoint('end').catch(() => {});
      const report = await audit.finish().catch(() => null);
      console.info('nava_labtest_save_audit', JSON.stringify({ directory, trace: report?.trace?.status,
        screenshots: report?.screenshots?.length ?? 0, status: report?.status ?? 'failed' }));
    }
  }
}
