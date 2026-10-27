import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLiveSentEmailListManifest } from '../src/hms/live-read-manifest.js';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const manifest = buildLiveSentEmailListManifest(origin);
const envelope = {
  schemaVersion: 1,
  toolId: 'shared',
  toolVersion: '1.0.0',
  discoveryOperationId: 'sent_email_list',
  surface: 'sent_email',
  functionName: 'PSSNEL',
  listPath: '/web/base/PSSNEL.HDR',
  preTransmissionEvidence: [
    'infor_user_guide_sent_email_view_only',
    'soft_capture_abort_mutations_print_resend',
    'live_pssnel_open_200_2026-08-06',
    'live_pssnel_hdr_grid_envelope_2026-08-06',
  ],
  deniedActions: [
    'open_attachment',
    'preview',
    'resend',
    'send',
    'print',
    'export',
    'generate',
    'document_byte_fetch',
  ],
  valuesCaptured: false,
  manifest,
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(
  here,
  '../src/hms/request-manifests/shared/sent-email.list.1.json',
);
mkdirSync(dirname(out), { recursive: true });
const body = `${JSON.stringify(envelope, null, 2)}\n`;
writeFileSync(out, body);
const sha = createHash('sha256').update(body).digest('hex');
// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    out,
    bytes: body.length,
    sha256: sha,
    rules: manifest.rules.length,
  }),
);
