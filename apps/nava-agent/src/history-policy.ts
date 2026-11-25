/** Exact historical HMS choices. Shared by live Postgres lookup and the replay twin. */
export const HISTORY_FIELDS = {
  rateplan: 'rate_plan', roomtype: 'room_type', mealplan: 'board', guaranteetype: 'guarantee_type',
  araccountname: 'ar_account_name', billingreference: 'billing_reference', company: 'organization_name', ta1: 'agency_name',
} as const;
type NativeField = keyof typeof HISTORY_FIELDS;
export type HistoryKey = 'booker_email' | 'booker_domain' | 'company' | 'ta1' | 'guest_id';
export type PolicyKeys = Partial<Record<HistoryKey, string | null>>;
export type PolicyRow = {key_type: HistoryKey; key: string; field: NativeField; value: string; support: number; agreement: number; last_seen: string};

const KEY_ORDER = ['booker_email', 'company', 'ta1', 'guest_id', 'booker_domain'] as const;
const aliases: Record<string, NativeField> = Object.fromEntries(Object.entries(HISTORY_FIELDS).map(([key, field]) => [field, key as NativeField]));
export const exactHistoryKey = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim().toLowerCase() : '';

export function historyRowKey(type: HistoryKey, key: string) {
  return `${type}:${exactHistoryKey(key)}`;
}

export function policyKeys(keys: PolicyKeys): Array<[HistoryKey, string]> {
  return KEY_ORDER.flatMap(type => {
    const key = exactHistoryKey(keys[type]);
    return key ? [[type, key] as [HistoryKey, string]] : [];
  });
}

export function policyField(value: string): NativeField | undefined {
  return Object.hasOwn(HISTORY_FIELDS, value) ? value as NativeField : Object.hasOwn(aliases, value) ? aliases[value] : undefined;
}

export function policyValue(field: NativeField, value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  if (field === 'billingreference') return /\d/.test(text) && text.length <= 50 ? text : '';
  return text;
}

export function historyFieldAllowed(type: HistoryKey, field: NativeField) {
  if (field === 'company' || field === 'ta1') return type === 'booker_email' || type === 'booker_domain';
  if (field === 'billingreference') return type === 'booker_email' || type === 'guest_id';
  return field !== 'araccountname' || type !== 'booker_domain';
}

export function eligiblePolicyRow(row: PolicyRow) {
  return row.support >= 2 && row.agreement >= 0.6 && row.agreement <= 1
    && historyFieldAllowed(row.key_type, row.field) && (row.field !== 'billingreference' || row.agreement === 1);
}

export function indexHistoryPolicy(input: unknown): Record<string, PolicyRow[]> {
  if (!Array.isArray(input)) throw new Error('Expected history policy rows');
  const index: Record<string, PolicyRow[]> = {};
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid history policy row');
    const keyType = raw.key_type as HistoryKey;
    const key = exactHistoryKey(raw.key);
    const field = policyField(String(raw.field));
    if (!KEY_ORDER.includes(keyType) || !field) continue;
    const row: PolicyRow = {
      key_type: keyType, key, field, value: policyValue(field, raw.value),
      support: Number(raw.support), agreement: Number(raw.agreement), last_seen: String(raw.last_seen ?? ''),
    };
    if (!key || !row.value || !Number.isSafeInteger(row.support) || !Number.isFinite(Date.parse(row.last_seen)) || !eligiblePolicyRow(row)) continue;
    const group = index[historyRowKey(keyType, key)] ??= [];
    const prev = group.findIndex(other => other.field === row.field);
    if (prev === -1) group.push(row);
    else if (row.support > group[prev].support) group[prev] = row;
  }
  return index;
}

export function bookingPolicyKeys(fields: Record<string, unknown>, sender?: PolicyKeys): PolicyKeys {
  return {
    ...sender,
    company: exactHistoryKey(fields.organization_name),
    ta1: exactHistoryKey(fields.agency_name),
    guest_id: exactHistoryKey(fields.guest_profile_id),
  };
}
