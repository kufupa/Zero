import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLiveDepositLedgerManifest,
  buildLiveFolioReadManifest,
} from '../src/hms/live-read-manifest.js';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../src/hms/request-manifests');

function writeEnvelope(input: {
  file: string;
  toolId: string;
  discoveryOperationId: string;
  surface: string;
  functionName: string;
  listPath: string;
  preTransmissionEvidence: string[];
  deniedActions: string[];
  manifest: ReturnType<typeof buildLiveFolioReadManifest>;
}): string {
  const envelope = {
    schemaVersion: 1,
    toolId: input.toolId,
    toolVersion: '1.0.0',
    discoveryOperationId: input.discoveryOperationId,
    surface: input.surface,
    functionName: input.functionName,
    listPath: input.listPath,
    preTransmissionEvidence: input.preTransmissionEvidence,
    deniedActions: input.deniedActions,
    valuesCaptured: false,
    manifest: input.manifest,
  };
  const out = join(root, input.file);
  mkdirSync(dirname(out), { recursive: true });
  const body = `${JSON.stringify(envelope, null, 2)}\n`;
  writeFileSync(out, body);
  return createHash('sha256').update(body).digest('hex');
}

const folioSha = writeEnvelope({
  file: 'hms_read_folio.folio.1.0.0.json',
  toolId: 'hms_read_folio',
  discoveryOperationId: 'folio_summary',
  surface: 'folio',
  functionName: 'OSRESS',
  listPath: '/web/base/OSRESS.search',
  preTransmissionEvidence: [
    'infor_user_guide_working_with_folios',
    'soft_capture_abort_post_settle_refund_print',
    'live_osress_open_foliobalance_field_2026-08-06',
    'live_osress_search_exact_binding_2026-08-06',
  ],
  deniedActions: [
    'post',
    'transfer',
    'settle',
    'refund',
    'void',
    'email',
    'print',
    'export',
    'report_execution',
    'advance_deposit_form',
  ],
  manifest: buildLiveFolioReadManifest(origin),
});

const depositSha = writeEnvelope({
  file: 'hms_read_folio.deposit-ledger.1.0.0.json',
  toolId: 'hms_read_folio',
  discoveryOperationId: 'deposit_ledger_summary',
  surface: 'deposit_ledger',
  functionName: 'OSLEDG',
  listPath: '/web/base/OSLEDG.DLD',
  preTransmissionEvidence: [
    'infor_user_guide_deposit_ledger',
    'soft_capture_abort_save_excel_advance_deposit',
    'live_osledg_open_deposit_property_ledger_2026-08-06',
    'live_osledg_lst_grid_envelope_2026-08-06',
    'live_property_ledger_deposit_ledger_menu_2026-08-07',
    'live_osledg_dld_confirmationnumber_2026-08-07',
    'live_osledg_dld_body_closingdate_property_2026-08-07',
  ],
  deniedActions: [
    'post',
    'transfer',
    'settle',
    'refund',
    'void',
    'email',
    'print',
    'export',
    'report_execution',
    'advance_deposit_form',
    'payment_card_capture',
  ],
  manifest: buildLiveDepositLedgerManifest(origin),
});

// Company: no manifest — BLOCKED_COMPANY_READ_SURFACE_UNPROVEN (billing fields absent).

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      folioSha,
      depositSha,
      companyManifest: null,
      companyBlocker: 'BLOCKED_COMPANY_READ_SURFACE_UNPROVEN',
    },
    null,
    2,
  ),
);
