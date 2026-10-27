import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLiveGroupBlockListManifest } from '../src/hms/live-read-manifest.js';

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
  manifest: ReturnType<typeof buildLiveGroupBlockListManifest>;
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

const groupSha = writeEnvelope({
  file: 'hms_group_block_read.aggregate-list.1.0.0.json',
  toolId: 'hms_group_block_read',
  discoveryOperationId: 'group_block_list',
  surface: 'group_block',
  functionName: 'GSGRPB',
  listPath: '/web/base/GSGRPB.LST',
  preTransmissionEvidence: [
    'infor_user_guide_group_booking',
    'soft_capture_abort_save_generate_print',
    'live_gsgrpb_open_module_groups_propgroupbooking_2026-08-06',
    'live_gsgrpb_lst_grid_envelope_2026-08-06',
  ],
  deniedActions: [
    'save',
    'create',
    'amend',
    'assign',
    'release',
    'rooming_list',
    'block_tab_direct_entry',
    'quick_entry',
    'room_assignment',
    'document_tabs',
    'focus',
    'input',
    'change',
    'blur',
    'print',
    'copy',
  ],
  manifest: buildLiveGroupBlockListManifest(origin),
});

// Event: no manifest — BLOCKED_EVENT_READ_SURFACE_UNPROVEN (Events menu absent).

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      groupSha,
      eventManifest: null,
      eventBlocker: 'BLOCKED_EVENT_READ_SURFACE_UNPROVEN',
      groupLiveBlocker: 'BLOCKED_GROUP_BLOCK_AGGREGATE_COUNTS_UNPROVEN',
    },
    null,
    2,
  ),
);
