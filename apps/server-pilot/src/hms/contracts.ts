/**
 * Docs/corpus-backed HMS capability contract for fail-closed read discovery.
 * Live HMS mutation surfaces stay out of autonomousAllowed / active_read.
 */

export type CapabilityRow = {
  id: string;
  officialDocs: string[];
  corpusThreadIds: number[];
  phase: 'active_read' | 'roadmap_read' | 'future_write';
  credentialRequirement: 'documented_read_screen' | 'view_only' | 'human_supervised';
  autonomousAllowed: boolean;
  mutationRisk: string;
  evidenceNeeded: string[];
};

/**
 * Frozen capability matrix rows. Source of truth for discovery allowlist.
 * Keep in sync with docs/infor-hms/capability-matrix.md.
 */
export const CAPABILITY_ROWS: readonly CapabilityRow[] = [
  {
    id: 'login',
    officialDocs: [
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428565917.html',
    ],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'documented_read_screen',
    autonomousAllowed: true,
    mutationRisk: 'auth session only; no PMS mutation on login GET/POST itself beyond session establish',
    evidenceNeeded: [
      'login URL origin matches manifest',
      'tenant/property header verification',
      'redacted gate JSON on unknown request',
    ],
  },
  {
    id: 'reservation-search',
    officialDocs: [
      'https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/osresv_help.html',
    ],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: true,
    mutationRisk: 'Guest Stay list/search read; must not open New Record or Stay Wizard mutate paths',
    evidenceNeeded: [
      'search by confirmation/external ref/bounded surname+date',
      'result ambiguity handling',
      'no create/amend controls exercised',
    ],
  },
  {
    id: 'room-availability',
    officialDocs: [
      'https://docs.infor.com/hms/3.8.x/en-us/hmsolh/s_t1424428570987.html',
    ],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: true,
    mutationRisk: 'Front Desk > Availability > Room Availability is inventory view only; never CRS Check Availability',
    evidenceNeeded: [
      'start date + room type observation',
      'inventory counts only',
      'separate from Display Rates (no merged bookable offer)',
    ],
  },
  {
    id: 'display-rates',
    officialDocs: [
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428571268.html',
    ],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: true,
    mutationRisk: 'Front Desk > Availability > Display Rates calculates prices; does not bind inventory or create reservation',
    evidenceNeeded: [
      'rate plan + room cost calculation',
      'amount basis / currency / inclusions unresolved fields',
      'bookable remains false until quote constraints resolve',
    ],
  },
  {
    id: 'crs-check-availability',
    officialDocs: [
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428583967.html',
    ],
    corpusThreadIds: [],
    phase: 'future_write',
    credentialRequirement: 'human_supervised',
    autonomousAllowed: false,
    mutationRisk:
      'Official CRS docs: Check Availability creates a new reservation record — forbidden for autonomous discovery',
    evidenceNeeded: [
      'fixture-only write validation plan',
      'human-supervised live validation before any production registry entry',
    ],
  },
  {
    id: 'write-forms',
    officialDocs: [
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428600707.html',
    ],
    corpusThreadIds: [],
    phase: 'future_write',
    credentialRequirement: 'human_supervised',
    autonomousAllowed: false,
    mutationRisk: 'Property Forms / any submit-save-create-amend-cancel path; mutation prohibited in Wave 1A',
    evidenceNeeded: [
      'synthetic fixture write adapters first',
      'production write requires authorization + idempotency + audit',
    ],
  },
  {
    id: 'sent-email-audit',
    officialDocs: [
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html',
    ],
    corpusThreadIds: [],
    phase: 'roadmap_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: false,
    mutationRisk: 'Wave 1B read; deferred from autonomous discovery until foundation green',
    evidenceNeeded: ['delivery state fields', 'attachment metadata without re-send'],
  },
  {
    id: 'folio-read',
    officialDocs: [
      'https://docs.infor.com/hms/2024.x/en-us/hmsolh/s_t1424428571861-2.html',
    ],
    corpusThreadIds: [],
    phase: 'roadmap_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: false,
    mutationRisk: 'Wave 2 finance read; deferred; never post/settle/refund',
    evidenceNeeded: ['balance + charges + payments read-only'],
  },
] as const;

/** IDs allowed for autonomous discovery (active_read + autonomousAllowed). */
export function activeDiscoveryCapabilities(): string[] {
  return CAPABILITY_ROWS.filter(
    (row) => row.phase === 'active_read' && row.autonomousAllowed,
  ).map((row) => row.id);
}
