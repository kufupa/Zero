import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const { createModelAdapter } = await import(path.join(root, 'dist/ai/bedrock/factory.js'));
const { classifyWorkflowMailTriage } = await import(path.join(root, 'dist/ai/workflows/mail-triage.js'));
const postgres = (await import('postgres')).default;
const sql = postgres(url, { ssl: sslOptions(), max: 2 });

async function main() {
  const msg = (await sql`
    SELECT * FROM message WHERE id = '1321b8d0-d74f-4ea8-8b18-64faeb23f6b3';
  `)[0];

  console.log('Testing triage on message:', msg.subject);
  console.log('Text body length:', msg.text_body?.length, 'HTML body length:', msg.html_body?.length);

  const adapter = createModelAdapter();
  try {
    const rawBody = (msg.text_body && msg.text_body.trim().length > 0) ? msg.text_body : (msg.html_body || '');
    const result = await classifyWorkflowMailTriage({
      transportId: 'transport-centurion',
      threadId: msg.thread_id,
      triggerMessageId: msg.id,
      messages: [{
        id: msg.id,
        from: msg.from_address,
        to: msg.to_addresses,
        cc: msg.cc_addresses,
        bcc: msg.bcc_addresses,
        subject: msg.subject,
        body: rawBody,
        createdAt: msg.created_at,
        receivedAt: msg.received_at,
        sentAt: msg.sent_at,
        direction: msg.direction
      }],
      from: msg.from_address,
      subject: msg.subject,
      body: rawBody,
      to: msg.to_addresses,
      cc: msg.cc_addresses,
      bcc: msg.bcc_addresses,
      asOf: new Date().toISOString(),
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v6'
    }, adapter);

    console.log('Result status: SUCCESS');
    console.log('Output:', JSON.stringify(result.output, null, 2));
  } catch (err) {
    console.error('Classification threw error:', err);
  }

  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
