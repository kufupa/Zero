import type { ProposalDraft } from './schema.js';

export function pointerParts(path: string): string[] | null {
  if (!path.startsWith('/') || /~(?![01])/.test(path)) return null;
  const parts = path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  return parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part)) ? null : parts;
}

export function editablePointer(parts: string[]): boolean {
  return (parts[0]==='bookings' && /^\d+$/.test(parts[1]??'') && parts[2]==='fields' && parts.length>=4)
    || (parts[0]==='actions' && /^\d+$/.test(parts[1]??'') && parts[2]==='details' && parts.length>=4)
    || (parts.length===1 && parts[0]==='reply_draft');
}

function resolves(value: unknown, parts: string[]): boolean {
  if (parts.length === 0) return true;
  const [part, ...rest] = parts;
  if (Array.isArray(value)) {
    return /^(0|[1-9]\d*)$/.test(part) && Number(part) < value.length && resolves(value[Number(part)], rest);
  }
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return false;
  return resolves(Object.getOwnPropertyDescriptor(value, part)?.value, rest);
}

const missingQuotePaths: Record<string, string> = {
  '/property': '/actions/0/details/property_code',
  '/property_code': '/actions/0/details/property_code',
  '/arrival_date': '/actions/0/details/groups/0/arrival_date',
  '/departure_date': '/actions/0/details/groups/0/departure_date',
  '/rooms': '/actions/0/details/groups/0/rooms',
  '/room_quantity_and_type': '/actions/0/details/groups/0/room_quantity_and_type',
  '/occupancy': '/actions/0/details/groups/0/occupancy',
  '/board': '/actions/0/details/groups/0/board',
  '/meal_plan': '/actions/0/details/groups/0/board',
};

export function normalizeProposalFields(draft: ProposalDraft): {kind:'valid'; draft:ProposalDraft} | {kind:'invalid'; path:string} {
  const scaffold = draft.workflow === 'quote' && draft.disposition === 'needs_info' && !draft.actions.length && draft.field_specs.some(field => field.editable && field.path !== '/reply_draft' && field.path !== 'reply_draft');
  const actions = scaffold ? [{
    id: 'quote-input', type: 'quote', booking_ids: [],
    details: {quote_id:'quote-input',property_code:null,groups:[{group_id:'stay-input',arrival_date:null,departure_date:null,rooms:null,room_quantity_and_type:null,occupancy:null,board:null}]},
  }] : draft.actions;
  const value = {...draft, actions};
  const seen = new Set<string>();
  const fields: ProposalDraft['field_specs'] = [];
  for (const field of draft.field_specs) {
    const pointer = field.path.startsWith('/') ? field.path : '/' + field.path;
    const path = scaffold && Object.hasOwn(missingQuotePaths, pointer) ? missingQuotePaths[pointer] : pointer;
    const parts = pointerParts(path);
    if (!parts || !resolves(value, parts) || (field.editable && !editablePointer(parts)) || seen.has(path)) return {kind:'invalid',path};
    seen.add(path);
    fields.push(scaffold && path.startsWith('/actions/0/details/')
      ? {...field,path,provenance:'unknown',evidence:[]}
      : {...field,path});
  }
  return {kind:'valid',draft:{...value,field_specs:fields}};
}
