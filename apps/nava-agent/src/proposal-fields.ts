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

export function validChildAges(count: unknown, ages: unknown): boolean {
  return typeof count==='number' && Number.isInteger(count) && count>=0 && Array.isArray(ages) && ages.length===count
    && ages.every((age:unknown)=>typeof age==='number' && Number.isInteger(age) && age>=0 && age<=17);
}

function createStaffFields(draft: ProposalDraft): ProposalDraft {
  const fieldSpecs=[...draft.field_specs];
  const bookings=draft.bookings.map((booking,index)=>{
    const fields={...booking.fields};
    const root=`/bookings/${index}/fields`;
    if(!Object.hasOwn(fields,'child_count')) fields.child_count=fields.children ?? (Array.isArray(fields.child_ages) ? fields.child_ages.length : 0);
    if(!Object.hasOwn(fields,'child_ages')) fields.child_ages=[];
    delete fields.children;
    for(const [key,label,control] of [['child_count','Children','number'],['child_ages','Child ages','text']] as const) {
      const path=`${root}/${key}`;
      const paths=[path,path.slice(1),...(key==='child_count'?[`${root}/children`,`${root}/children`.slice(1)]:[])];
      const existing=fieldSpecs.findIndex(spec=>paths.includes(spec.path));
      if(existing>=0) fieldSpecs[existing]={...fieldSpecs[existing],path,editable:true,control};
      else fieldSpecs.push({path,label,control,editable:true,provenance:'default',required:false,error:null,options:[],evidence:[]});
    }
    if(draft.disposition==='propose') {
      const path=`${root}/guarantee_type`;
      if(!Object.hasOwn(fields,'guarantee_type')) fields.guarantee_type=null;
      const existing=fieldSpecs.findIndex(spec=>spec.path===path || spec.path===path.slice(1));
      if(existing>=0) fieldSpecs[existing]={...fieldSpecs[existing],path,editable:true,required:true,control:'text'};
      else fieldSpecs.push({path,label:'Guarantee type',editable:true,required:true,control:'text',provenance:'unknown',error:null,options:[],evidence:[]});
    }
    return {...booking,fields};
  });
  return {...draft,bookings,field_specs:fieldSpecs};
}

export function normalizeProposalFields(draft: ProposalDraft): {kind:'valid'; draft:ProposalDraft} | {kind:'invalid'; path:string} {
  if(draft.workflow==='create') draft=createStaffFields(draft);
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
