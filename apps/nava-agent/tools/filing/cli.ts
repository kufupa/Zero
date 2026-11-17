import { readFileSync } from 'node:fs';
import { inspect, prepare, type ToolContext, type ToolResult, type TrustedAttachment } from './index.js';

// The only bytes this CLI can supply are generated in memory for Labtest.
function fixturePdf(): Buffer {
  const stream = 'BT /F1 12 Tf 20 90 Td (Nava Labtest fixture) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${value}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some(flag => !['--labtest', '--fixture', '--shared-admission', '--inspect'].includes(flag)) ||
      (flags.has('--fixture') && (!flags.has('--labtest') || flags.has('--inspect')))) throw new Error('INVALID_CLI_OPTIONS');
  const input: unknown = JSON.parse(readFileSync(0, 'utf8'));
  const context: ToolContext = { sessionId: 'filing-cli', mode: flags.has('--labtest') ? 'labtest' : 'live' };
  // The CLI operator supplies the selected booking; production must bind this to the session's authorized selection.
  const booking = typeof input === 'object' && input !== null && 'booking' in input &&
    typeof input.booking === 'object' && input.booking !== null ? input.booking : null;
  context.authorizeTarget = async target => Boolean(booking && 'id' in booking && 'property_code' in booking &&
    'reservation_id' in booking && target.sessionId === context.sessionId && target.bookingId === booking.id &&
    target.propertyCode === booking.property_code && target.reservationId === booking.reservation_id);
  if (flags.has('--fixture')) {
    context.resolveAttachment = async ref => ref.messageId === 'labtest-message' &&
      ref.attachmentId === 'labtest-pdf' && ref.handle === 'generated-labtest-pdf'
      ? { ...ref, name: 'nava-labtest.pdf', mimeType: 'application/pdf', bytes: fixturePdf() } satisfies TrustedAttachment
      : null;
  }
  const run = flags.has('--inspect') ? inspect : prepare;
  let result: ToolResult;
  if (flags.has('--shared-admission')) {
    // Operator must supply the existing shared admission DB in this process's native environment.
    const moduleUrl = new URL('../../../server-pilot/tooling/hms-cloud/cloud-session.mjs', import.meta.url);
    const cloud = await import(moduleUrl.href);
    const property = typeof input === 'object' && input !== null && 'booking' in input &&
      typeof input.booking === 'object' && input.booking !== null && 'property_code' in input.booking
      ? input.booking.property_code : undefined;
    if (typeof property !== 'string') throw new Error('PROPERTY_REQUIRED');
    result = await cloud.withCloudCredentialLease(property, (lease: unknown) =>
      run(input, { ...context, hmsCredentialLease: lease }), { readOnly: true });
  } else {
    result = await run(input, context);
  }
  // Real guest identity, attachment names and native captures never go to shared stdout.
  const data = result.data && typeof result.data === 'object' && 'documents' in result.data && Array.isArray(result.data.documents)
    ? { loaded_documents: result.data.documents.length, full_coverage_verified: false } : {};
  process.stdout.write(`${JSON.stringify({ ok: result.ok, outcome: result.ok ? (flags.has('--inspect') ? 'documents_read' : 'prepared') : 'refused',
    ...data, error: result.error })}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'CLI_FAILED';
  process.stdout.write(`${JSON.stringify({ ok: false, outcome: 'refused', error:
    { code, message: 'Filing CLI could not run.', retryable: false, outcome: 'known' } })}\n`);
  process.exitCode = 1;
});
