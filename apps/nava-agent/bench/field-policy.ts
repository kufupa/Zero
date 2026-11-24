/**
 * Lead-authored staff-field policies (contract U3/U7). Modes only — no weights.
 * Quote children path uses /children; Create uses child_count.
 */
import type {Workflow} from './types.js';

export const FIELD_POLICY_VERSION = 'nava.field-policy/v1';

export type FieldPolicyMode =
  | 'exact'
  | 'semantic'
  | 'allowed_set'
  | 'deterministic_default'
  | 'required_abstention'
  | 'outcome_only'
  | 'not_observable';

export type FieldPolicy = {
  path: string;
  mode: FieldPolicyMode;
  unit: string;
  workflow: Workflow[];
  allowed?: string[];
  default?: string;
  note?: string;
};

/** Mirror of contract Product Contract + U7 field inventory. */
export const FIELD_POLICIES: FieldPolicy[] = [
  {path: '/bookings/*/fields/first_name', mode: 'exact', unit: 'booking', workflow: ['create', 'amend']},
  {path: '/bookings/*/fields/last_name', mode: 'exact', unit: 'booking', workflow: ['create', 'amend']},
  {path: '/bookings/*/fields/arrival_date', mode: 'exact', unit: 'booking', workflow: ['create', 'amend', 'quote']},
  {path: '/bookings/*/fields/departure_date', mode: 'exact', unit: 'booking', workflow: ['create', 'amend', 'quote']},
  {path: '/bookings/*/fields/adults', mode: 'exact', unit: 'booking', workflow: ['create', 'amend', 'quote']},
  {path: '/bookings/*/fields/child_count', mode: 'exact', unit: 'booking', workflow: ['create', 'amend'], note: 'Quote uses /children'},
  {path: '/actions/*/details/groups/*/rooms/*/children', mode: 'exact', unit: 'quote_room', workflow: ['quote']},
  {path: '/bookings/*/fields/room_type', mode: 'semantic', unit: 'booking', workflow: ['create', 'amend'], note: 'catalogue code when attributable; never from occupancy alone'},
  {path: '/bookings/*/fields/board', mode: 'allowed_set', unit: 'booking', workflow: ['create', 'amend', 'quote'], allowed: ['RO', 'BB', 'DBB']},
  {path: '/bookings/*/fields/rate_plan', mode: 'required_abstention', unit: 'booking', workflow: ['create'], note: 'printed price is not native rate code'},
  {path: '/bookings/*/fields/agency_name', mode: 'semantic', unit: 'booking', workflow: ['create']},
  {path: '/bookings/*/fields/organization_name', mode: 'semantic', unit: 'booking', workflow: ['create'], note: 'employer ≠ agency; no credit from past payer'},
  {path: '/bookings/*/fields/guarantee_type', mode: 'allowed_set', unit: 'booking', workflow: ['create'], allowed: ['AVOUCH', 'CNFREC'], note: 'canonical aliases only; reject unknown'},
  {path: '/bookings/*/fields/billing_reference', mode: 'exact', unit: 'booking', workflow: ['create']},
  {path: '/bookings/*/fields/source_of_business', mode: 'deterministic_default', unit: 'booking', workflow: ['create'], default: 'EMA', note: 'code-owned on initial email proposal; not model hit'},
  {path: '/bookings/*/fields/booking_source', mode: 'deterministic_default', unit: 'booking', workflow: ['create'], default: 'EMA', note: 'alias of source_of_business'},
  {path: '/bookings/*/fields/bed_preference', mode: 'deterministic_default', unit: 'booking', workflow: ['create'], default: 'STQN', note: 'staff-editable application default; not guest evidence — shadow tracks corrections'},
  {path: '/bookings/*/reservation_id', mode: 'exact', unit: 'booking', workflow: ['amend', 'cancel', 'filing'], note: 'unverified target → not observed'},
  {path: '/bookings/*/fields/confirmation_number', mode: 'exact', unit: 'booking', workflow: ['filing', 'amend', 'cancel']},
  {path: '/actions/*/type', mode: 'allowed_set', unit: 'action', workflow: ['filing'], allowed: ['voucher_submission', 'payment_proof_submission']},
  {path: '/actions/*/details/attachment_id', mode: 'exact', unit: 'action', workflow: ['filing']},
  {path: '/actions/*/details/cancellation_reason', mode: 'semantic', unit: 'action', workflow: ['cancel'], note: 'native reason vs free-text guest note separated'},
  {path: 'native_availability', mode: 'outcome_only', unit: 'offer', workflow: ['quote'], note: 'cannot infer from draft'},
  {path: 'native_price', mode: 'not_observable', unit: 'offer', workflow: ['quote', 'create'], note: 'do not invent prices'},
  {path: 'native_rate_code_from_letter', mode: 'not_observable', unit: 'booking', workflow: ['create']},
  {path: 'original_ar_from_refund', mode: 'required_abstention', unit: 'booking', workflow: ['create'], note: 'never derive original A/R from Refund Account'},
  {path: 'inventory_from_letter', mode: 'not_observable', unit: 'offer', workflow: ['quote']},
];

export const UNREPRESENTED_MATERIAL_FIELDS = [
  'track',
  'market_segment',
  'credit_entitlement_from_history',
] as const;

export function fieldPolicyDocument() {
  return {
    schema: FIELD_POLICY_VERSION,
    version: FIELD_POLICY_VERSION,
    source: 'contract.md U3 + U7 field policies',
    policies: FIELD_POLICIES,
    unrepresented_material_fields: [...UNREPRESENTED_MATERIAL_FIELDS],
    note: 'No weights. Sparse labels not promoted to headline metrics.',
  };
}

function wildcardToRegex(path: string): RegExp {
  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

/** Paths that are code-owned defaults — excluded from model-quality denominators. */
export function isDeterministicDefaultPath(path: string): boolean {
  const leaf = path.split('/').pop() ?? '';
  return leaf === 'source_of_business' || leaf === 'booking_source'
    || FIELD_POLICIES.some(policy => policy.mode === 'deterministic_default'
      && policy.default === 'EMA'
      && wildcardToRegex(policy.path).test(path));
}

export function matchFieldPolicy(path: string, workflow?: Workflow): FieldPolicy | undefined {
  return FIELD_POLICIES.find(policy =>
    wildcardToRegex(policy.path).test(path)
    && (workflow === undefined || policy.workflow.includes(workflow)));
}
