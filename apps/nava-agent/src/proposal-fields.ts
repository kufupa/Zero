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

function createChildFields(draft: ProposalDraft): ProposalDraft {
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
    return {...booking,fields};
  });
  return {...draft,bookings,field_specs:fieldSpecs};
}

export function withCreateNativeFields(draft: ProposalDraft): ProposalDraft {
  if(draft.workflow!=='create' || draft.disposition!=='propose') return draft;
  const fieldSpecs=[...draft.field_specs];
  const bookings=draft.bookings.map((booking,index)=>{
    const fields={...booking.fields};
    for(const [key,label,required,control] of [
      ['room_type','Room type',true,'combobox'], ['rate_plan','Rate plan',true,'combobox'],
      ['source_of_business','Booking source',true,'combobox'], ['track','Track',true,'combobox'],
      ['guarantee_type','Guarantee type',true,'text'], ['guest_profile_id','Guest profile ID',false,'text'],
      ['first_name','Guest first name',true,'text'], ['last_name','Guest last name',true,'text'],
      ['guest_email','Guest email',false,'text'],
      ['agency_name','Booking agency',false,'text'], ['agency_id','Booking agency ID',false,'text'],
    ] as const) {
      const path=`/bookings/${index}/fields/${key}`;
      const existing=fieldSpecs.findIndex(spec=>spec.path===path || spec.path===path.slice(1));
      if(!Object.hasOwn(fields,key)) fields[key]=null;
      if(existing>=0) fieldSpecs[existing]={...fieldSpecs[existing],path,editable:true,required,control};
      else fieldSpecs.push({path,label,editable:true,required,control,provenance:'unknown',error:null,options:[],evidence:[]});
    }
    return {...booking,fields};
  });
  return {...draft,bookings,field_specs:fieldSpecs};
}

export function withQuoteStaffFields(draft: ProposalDraft): ProposalDraft {
  if(draft.workflow!=='quote') return draft;
  const fieldSpecs=[...draft.field_specs];
  const actions=draft.actions.map((action,actionIndex)=>{
    if(action.type!=='quote' || !action.details || typeof action.details!=='object' || Array.isArray(action.details)) return action;
    const add=(path:string,label:string,control:'date'|'number'|'text',required:boolean)=>{
      const existing=fieldSpecs.findIndex(spec=>spec.path===path || spec.path===path.slice(1));
      if(existing>=0) fieldSpecs[existing]={...fieldSpecs[existing],path,editable:true,control};
      else fieldSpecs.push({path,label,editable:true,required,control,provenance:'unknown',error:null,options:[],evidence:[]});
    };
    const details={...action.details};
    if(!Object.hasOwn(details,'property_code')) details.property_code=null;
    add(`/actions/${actionIndex}/details/property_code`,'Property','text',true);
    if(!Array.isArray(details.groups)) return {...action,details};
    const groups=details.groups.map((value,groupIndex)=>{
      if(!value || typeof value!=='object' || Array.isArray(value)) return value;
      const group:Record<string,unknown>={...value};
      const groupRoot=`/actions/${actionIndex}/details/groups/${groupIndex}`;
      if(!Object.hasOwn(group,'arrival_date')) group.arrival_date=null;
      if(!Object.hasOwn(group,'departure_date')) group.departure_date=null;
      add(`${groupRoot}/arrival_date`,'Arrival','date',true);
      add(`${groupRoot}/departure_date`,'Departure','date',true);
      if(!Array.isArray(group.rooms)) return group;
      const rooms=group.rooms.map((value:unknown,roomIndex:number)=>{
        if(!value || typeof value!=='object' || Array.isArray(value)) return value;
        const room:Record<string,unknown>={...value};
        const root=`${groupRoot}/rooms/${roomIndex}`;
        for(const [key,label,control,required] of [
          ['quantity','Rooms','number',true], ['adults','Adults','number',true], ['children','Children','number',false],
          ['child_ages','Child ages','text',false], ['required','Required room and rate','text',false],
        ] as const) {
          if(!Object.hasOwn(room,key)) room[key]=key==='required'?{}:null;
          add(`${root}/${key}`,label,control,required);
        }
        return room;
      });
      return {...group,rooms};
    });
    return {...action,details:{...details,groups}};
  });
  return {...draft,actions,field_specs:fieldSpecs};
}

export function normalizeProposalFields(draft: ProposalDraft): {kind:'valid'; draft:ProposalDraft} | {kind:'invalid'; path:string} {
  if(draft.workflow==='create') draft=withCreateNativeFields(createChildFields(draft));
  if(draft.workflow==='quote') draft=withQuoteStaffFields(draft);
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
