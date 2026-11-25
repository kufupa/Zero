import type { ProposalDraft } from './schema.js';
import { withCancelReviewFields } from '../tools/cancel/index.js';
import { createNonNativeFields, createNoteAliases, createReservationNote, createStaffNoteLabels, isCreateRateCode } from '../tools/create/schema.js';
import { isEmptyQuoteGroup } from '../tools/quote/schema.js';
import { normalizeGuaranteeCode } from './guarantee-normalize.mjs';

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

function createOccupancyFields(draft: ProposalDraft): ProposalDraft {
  const fieldSpecs=[...draft.field_specs];
  const bookings=draft.bookings.map((booking,index)=>{
    const fields={...booking.fields};
    const root=`/bookings/${index}/fields`;
    const defaultAdults=fields.adults==null || fields.adults==='';
    if(defaultAdults) fields.adults=1;
    let defaultChildren=false;
    const childPaths=new Set([`${root}/child_count`,`${root}/child_count`.slice(1),`${root}/children`,`${root}/children`.slice(1)]);
    const childrenMentioned=fieldSpecs.some(spec=>childPaths.has(spec.path) && spec.evidence.length>0);
    if(fields.child_count==null) {
      if(typeof fields.children==='number') fields.child_count=fields.children;
      else if(typeof fields.children==='string' && /^\d+$/.test(fields.children.trim())) fields.child_count=Number(fields.children.trim());
      else if(Array.isArray(fields.child_ages)) fields.child_count=fields.child_ages.length;
      else if(fields.children!=null && fields.children!=='') fields.child_count=fields.children;
      else if(childrenMentioned) fields.child_count=null;
      else {fields.child_count=0; defaultChildren=true;}
    }
    if(fields.child_ages==null) fields.child_ages=fields.child_count===0 ? [] : null;
    delete fields.children;
    for(const [key,label,control,defaulted] of [
      ['adults','Adults','number',defaultAdults], ['child_count','Children','number',defaultChildren],
      ['child_ages','Child ages','text',defaultChildren],
    ] as const) {
      const path=`${root}/${key}`;
      const paths=new Set([path,path.slice(1),...(key==='child_count'?[`${root}/children`,`${root}/children`.slice(1)]:[])]);
      const existing=fieldSpecs.findIndex(spec=>paths.has(spec.path));
      const unknown=fields[key]==null;
      if(existing>=0) fieldSpecs[existing]={...fieldSpecs[existing],path,editable:true,control,required:true,
        ...(defaulted?{provenance:'default' as const,error:null,evidence:[]} : unknown?{provenance:'unknown' as const}:{})};
      else fieldSpecs.push({path,label,control,editable:true,provenance:defaulted?'default':unknown?'unknown':'ai',required:true,error:null,options:[],evidence:[]});
    }
    return {...booking,fields};
  });
  return {...draft,bookings,field_specs:fieldSpecs};
}

/** Native guarantee picker choices — mirrors cloud-create-policy.mjs CREATE_GUARANTEES (no inference). */
export const CREATE_GUARANTEE_OPTIONS = [
  {value: 'AVOUCH', label: 'Awaiting Voucher', meaning: null},
  {value: 'CNFREC', label: 'Confirmation Received', meaning: null},
  {value: 'DEPREQ', label: 'Deposit Requested', meaning: null},
  {value: 'GRPDEF', label: 'Group Definite', meaning: null},
  {value: 'GTDAGT', label: 'Guaranteed By Agent', meaning: null},
  {value: 'GTDCMP', label: 'Guaranteed By Company', meaning: null},
  {value: 'GTDCC', label: 'Guaranteed By Credit Card', meaning: null},
  {value: 'GTDDEP', label: 'Guaranteed By Deposit', meaning: null},
  {value: 'NGG', label: 'Non-Guaranteed Group', meaning: null},
  {value: 'NGI', label: 'Non-Guaranteed Individual', meaning: null},
] as const;

export function withCreateNativeFields(draft: ProposalDraft): ProposalDraft {
  if(draft.workflow!=='create' || !['propose','needs_info','staff_review'].includes(draft.disposition)) return draft;
  const fieldSpecs=draft.field_specs.map(spec=>Object.hasOwn(createStaffNoteLabels,spec.path.split('/').at(-1) ?? '')
    ? {...spec,required:false} : spec);
  const bookings=draft.bookings.map((booking,index)=>{
    const fields={...booking.fields};
    if(index===0 && draft.actions.some(action=>action.type==='create')) {
      fields.room_count=draft.bookings.length;
      const path='/bookings/0/fields/room_count';
      if(!fieldSpecs.some(spec=>spec.path===path)) fieldSpecs.unshift({path,label:'Number of rooms (1–8)',editable:true,required:true,control:'number',provenance:'staff',error:null,options:[],evidence:[]});
    }
    for(const [key,label,required,control] of [
      ['room_type','Room type',true,'combobox'], ['rate_plan','Rate plan',true,'combobox'],
      ['source_of_business','Booking source',true,'combobox'], ['track','Track',true,'combobox'],
      ['guarantee_type','Guarantee type',true,'select'], ['guest_profile_id','Guest profile ID',false,'text'],
      ['first_name','Guest first name',true,'text'], ['last_name','Guest last name',true,'text'],
      ['arrival_date','Arrival',true,'date'], ['departure_date','Departure',true,'date'],
      ['guest_email','Guest email',false,'text'],
      ['profile_create_new','Create a new Guest Profile, even if Infor finds the same name',false,'checkbox'],
      ['profile_mobile','New Guest Profile mobile',false,'text'], ['profile_email','New Guest Profile email',false,'text'],
      ['agency_name','Booking agency',false,'text'], ['agency_id','Booking agency ID',false,'text'],
      ['organization_name','Company',false,'text'], ['organization_id','Company ID',false,'text'],
      ['ar_account_name','A/R account',false,'text'], ['ar_account_id','A/R account ID',false,'text'],
      ['billing_reference','Billing reference',false,'text'],
      ['booker_name','Booker name',false,'text'], ['booker_contact','Booker contact',false,'text'],
      ['reason_for_stay','Reason for stay',false,'text'], ['note','Reservation note',false,'textarea'],
      ['guest_opt_in','Guest opt-in',false,'checkbox'],
      ['cms_send','Send Infor confirmation (CMS)',false,'checkbox'], ['cms_message_id','CMS message ID',false,'text'],
      ['cms_recipient','CMS recipient email',false,'text'],
    ] as const) {
      const path=`/bookings/${index}/fields/${key}`;
      const existing=fieldSpecs.findIndex(spec=>spec.path===path || spec.path===path.slice(1));
      if(key==='note' && typeof fields.reservation_note==='string') fields.note=createReservationNote({note:fields.note,reservation_note:fields.reservation_note});
      if(!Object.hasOwn(fields,key)) fields[key]=createFieldDefault(key,fields);
      const guaranteeOpts = key==='guarantee_type' ? [...CREATE_GUARANTEE_OPTIONS] : [];
      if(existing>=0) {
        const prev=fieldSpecs[existing];
        fieldSpecs[existing]={...prev,path,editable:true,required,control,
          ...(key==='guarantee_type' && !(prev.options?.length) ? {options:guaranteeOpts} : {})};
      } else fieldSpecs.push({path,label,editable:true,required,control,provenance:'unknown',error:null,
        options:guaranteeOpts,evidence:[]});
    }
    delete fields.reservation_note;
    return {...booking,fields};
  });
  return {...draft,bookings,field_specs:fieldSpecs.filter(spec=>!/^\/?bookings\/\d+\/fields\/reservation_note$/.test(spec.path))};
}

function isLabtestGuest(fields: Record<string, unknown>) {
  return fields.first_name==='Proof' && fields.last_name==='Labtest';
}

function createFieldDefault(key: string, fields: Record<string, unknown>): string | boolean | null {
  if(key==='cms_send') return !isLabtestGuest(fields);
  if(key==='cms_message_id') return '03';
  if(key==='cms_recipient') return typeof fields.guest_email==='string' && fields.guest_email ? fields.guest_email : null;
  if(key==='guest_opt_in' || key==='profile_create_new') return false;
  if(key==='profile_email') return typeof fields.guest_email==='string' ? fields.guest_email : null;
  return null;
}

/**
 * Field keys staff must fill before Create Prepare or Go. Generic: every required field spec that is blank blocks,
 * so whatever the model failed to extract surfaces as an empty required box rather than a silent default.
 */
export function missingCreateFields(draft: ProposalDraft, operation: 'stage' | 'go', index = 0): string[] {
  const fields=draft.bookings[index]?.fields ?? {};
  const blank=(value: unknown)=>value==null || (typeof value==='string' && !value.trim());
  const root=`/bookings/${index}/fields/`;
  // Prepare needs the stay and party (HMS then offers rate/track/guest choices); Go needs every required field.
  const missing=new Set(['arrival_date','departure_date','adults','first_name','last_name'].filter(key=>blank(fields[key])));
  if(!validChildAges(fields.child_count,fields.child_ages)) missing.add(fields.child_count==null?'child_count':'child_ages');
  if(operation==='stage') return [...missing];
  for(const spec of draft.field_specs) {
    const path=spec.path.startsWith('/')?spec.path:'/'+spec.path;
    if(spec.required && path.startsWith(root) && !path.slice(root.length).includes('/') && blank(fields[path.slice(root.length)])) missing.add(path.slice(root.length));
  }
  if(fields.cms_send===true) {
    if(isLabtestGuest(fields)) missing.add('cms_send');
    for(const key of ['cms_message_id','cms_recipient']) if(blank(fields[key])) missing.add(key);
  }
  return [...missing];
}

/** Amend booking.fields keys the native adapter can stage. Free-text invents like room_mix are stripped. */
export const AMEND_SUPPORTED_FIELD_KEYS = new Set([
  'arrival_date', 'departure_date', 'adults', 'child_count', 'room_type', 'rate_plan',
  'first_name', 'last_name', 'booker_name', 'booker_contact', 'reservation_note', 'note',
]);

export function withAmendSupportedFields(draft: ProposalDraft): ProposalDraft {
  if (draft.workflow !== 'amend') return draft;
  const warnings = [...draft.warnings];
  const bookings = draft.bookings.map(booking => {
    const fields = {...booking.fields};
    for (const key of Object.keys(fields)) {
      if (AMEND_SUPPORTED_FIELD_KEYS.has(key)) continue;
      if (key === 'room_mix' || /room/i.test(key)) {
        warnings.push(`Unsupported amend field ${key}; map room changes to catalogue room_type via hms_read_catalogue.`);
      } else {
        warnings.push(`Dropped unsupported amend field ${key}.`);
      }
      delete fields[key];
    }
    for (const key of ['rate_plan', 'room_type'] as const) {
      const code = booking.property_code === 'HRCEN' ? hrcenCode(key, fields[key], fields.board) : null;
      if (code) fields[key] = code;
    }
    return {...booking, fields};
  });
  const field_specs = draft.field_specs.filter(spec => {
    const path = spec.path.startsWith('/') ? spec.path : `/${spec.path}`;
    const match = path.match(/^\/bookings\/\d+\/fields\/([^/]+)$/);
    return !match || AMEND_SUPPORTED_FIELD_KEYS.has(match[1]!);
  });
  return {...draft, bookings, field_specs, warnings};
}

function blank(value:unknown):boolean {
  return value==null || value==='';
}

function asRecord(value:unknown):Record<string,unknown> {
  return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}

function asNumber(value:unknown):number|null {
  return typeof value==='number' && Number.isFinite(value) ? value : null;
}

/** Occupancy / room-type wording → adults when email already stated it. */
function adultsFromWording(...values:unknown[]):number|null {
  for(const value of values) {
    if(typeof value!=='string' || !value.trim()) continue;
    const text=value.toLowerCase();
    if(/\bsingle\b/.test(text)) return 1;
    if(/\b(?:double|twin|triple|family)\b/.test(text)) return /\btriple\b/.test(text) ? 3 : 2;
  }
  return null;
}

/** DD/MM/YYYY (and close forms) from field evidence → ISO date. */
export function parseQuoteEvidenceDate(quote:unknown):string|null {
  if(typeof quote!=='string') return null;
  const match=quote.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if(!match) return null;
  const iso=`${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`))
    && new Date(`${iso}T00:00:00Z`).toISOString().slice(0,10)===iso ? iso : null;
}

/** Lift nested criteria / wording into native quote room fields. Never invent party size. */
export function liftQuoteRoomFields(room:Record<string,unknown>, fallback:{board?:unknown;rate_preference?:unknown}={}):Record<string,unknown> {
  const criteria=asRecord(room.criteria);
  const next={...room};
  if(blank(next.room_type) && typeof criteria.room_type==='string') next.room_type=criteria.room_type;
  if(blank(next.board)) {
    const board=criteria.board ?? fallback.board;
    if(typeof board==='string' && board.trim()) next.board=/bed and breakfast/i.test(board) ? 'BB'
      : /dinner/i.test(board) ? 'DBB' : /room only/i.test(board) ? 'RO' : board;
  }
  if(typeof next.room_type==='string' && next.room_type.trim()) {
    const code=hrcenCode('room_type', next.room_type, next.board ?? fallback.board);
    if(code) next.room_type=code;
  }
  if(blank(next.rate_preference) && typeof fallback.rate_preference==='string') next.rate_preference=fallback.rate_preference;
  if(blank(next.adults)) next.adults=asNumber(criteria.adults)
    ?? adultsFromWording(criteria.occupancy,next.room_type,criteria.room_type,next.guest_name);
  if(blank(next.children)) next.children=asNumber(criteria.children)
    ?? (Array.isArray(criteria.child_ages) ? criteria.child_ages.length : Array.isArray(next.child_ages) ? next.child_ages.length : 0);
  if(blank(next.child_ages)) next.child_ages=Array.isArray(criteria.child_ages) ? criteria.child_ages
    : (asNumber(next.children) ?? 0)===0 ? [] : next.child_ages;
  if(blank(next.quantity) && typeof next.guest_name==='string' && next.guest_name.trim()) next.quantity=1;
  if(blank(next.adults) && typeof next.guest_name==='string' && next.guest_name.trim()) next.adults=1;
  return next;
}

/** Prepare-time normalize for quote action details (criteria lift + top-level rate pass-through). */
export function normalizeQuoteActionDetails(details:unknown):unknown {
  if(!details || typeof details!=='object' || Array.isArray(details)) return details;
  const root={...details as Record<string,unknown>};
  if(!Array.isArray(root.groups)) return root;
  const rate=root.rate_preference, board=root.board;
  root.groups=root.groups.map(value=>{
    if(!value || typeof value!=='object' || Array.isArray(value)) return value;
    const group={...value as Record<string,unknown>};
    if(!Array.isArray(group.rooms)) return group;
    group.rooms=group.rooms.map(room=>room && typeof room==='object' && !Array.isArray(room)
      ? liftQuoteRoomFields({...room as Record<string,unknown>},{board:group.board ?? board,rate_preference:rate}) : room);
    return group;
  });
  return root;
}

export function withQuoteStaffFields(draft: ProposalDraft): ProposalDraft {
  if(draft.workflow!=='quote') return draft;
  const fieldSpecs=[...draft.field_specs];
  const separateQuotes=draft.actions.filter(action=>action.type==='quote').length>1;
  const actions=draft.actions.map((action,actionIndex)=>{
    if(action.type!=='quote' || !action.details || typeof action.details!=='object' || Array.isArray(action.details)) return action;
    const add=(path:string,label:string,control:'date'|'number'|'text',required:boolean)=>{
      const existing=fieldSpecs.findIndex(spec=>spec.path===path || spec.path===path.slice(1));
      if(existing>=0) fieldSpecs[existing]={...fieldSpecs[existing],path,editable:true,control};
      else fieldSpecs.push({path,label,editable:true,required,control,provenance:'unknown',error:null,options:[],evidence:[]});
    };
    const details={...asRecord(normalizeQuoteActionDetails(action.details))};
    if(separateQuotes || typeof details.party_name==='string') {
      if(typeof details.party_name!=='string') details.party_name='';
      add(`/actions/${actionIndex}/details/party_name`,'Guest or party name','text',false);
    }
    if(!Object.hasOwn(details,'property_code')) details.property_code=null;
    add(`/actions/${actionIndex}/details/property_code`,'Property','text',true);
    if(!Array.isArray(details.groups)) return {...action,details};
    if(details.groups.some(isEmptyQuoteGroup) && details.groups.some(group=>group && typeof group==='object' &&
      !Array.isArray(group) && Array.isArray(group.rooms) && group.rooms.length>0)) {
      const roomGroups:unknown[]=[], manualGroups:unknown[]=[];
      const base=`/actions/${actionIndex}/details/`;
      details.groups.forEach((group,index)=>{
        const manual=isEmptyQuoteGroup(group), target=manual?manualGroups:roomGroups;
        const from=`${base}groups/${index}`, to=`${base}${manual?'manual_groups':'groups'}/${target.length}`;
        target.push(group);
        for(let i=0;i<fieldSpecs.length;i++) {
          const path=fieldSpecs[i].path.replace(/^\/?/,'/');
          if(path===from || path.startsWith(from+'/')) fieldSpecs[i]={...fieldSpecs[i],path:to+path.slice(from.length)};
        }
      });
      details.groups=roomGroups;
      details.manual_groups=manualGroups;
    }
    const groups=details.groups.map((value,groupIndex)=>{
      if(!value || typeof value!=='object' || Array.isArray(value)) return value;
      const group:Record<string,unknown>={...value};
      const groupRoot=`/actions/${actionIndex}/details/groups/${groupIndex}`;
      if(!Object.hasOwn(group,'arrival_date')) group.arrival_date=null;
      if(!Object.hasOwn(group,'departure_date')) group.departure_date=null;
      for(const key of ['arrival_date','departure_date'] as const) {
        if(!blank(group[key])) continue;
        const path=`${groupRoot}/${key}`, bare=path.slice(1);
        const evidence=fieldSpecs.find(spec=>spec.path===path || spec.path===bare)?.evidence ?? [];
        const iso=evidence.map(item=>parseQuoteEvidenceDate(item.quote)).find((value):value is string=>!!value);
        if(iso) group[key]=iso;
      }
      add(`${groupRoot}/arrival_date`,'Arrival','date',true);
      add(`${groupRoot}/departure_date`,'Departure','date',true);
      if(!Array.isArray(group.rooms)) return group;
      group.board ??= details.board ?? 'BB';
      if(group.rooms.length) add(`${groupRoot}/board`,'Meal plan','text',false);
      const rooms=group.rooms.map((value:unknown,roomIndex:number)=>{
        if(!value || typeof value!=='object' || Array.isArray(value)) return value;
        const room=liftQuoteRoomFields({...value as Record<string,unknown>},{
          board:group.board ?? details.board, rate_preference:details.rate_preference});
        const root=`${groupRoot}/rooms/${roomIndex}`;
        for(const [key,label,control,required] of [
          ['quantity','Rooms','number',true], ['adults','Adults','number',true], ['children','Children','number',false],
          ['child_ages','Child ages','text',false], ['required','Required room and rate','text',false],
        ] as const) {
          if(!Object.hasOwn(room,key)) room[key]=key==='required'?{}:key==='quantity'?1:key==='children'?
            (Array.isArray(room.child_ages)?room.child_ages.length:0):
            key==='child_ages' && room.children===0?[]:null;
          add(`${root}/${key}`,label,control,required);
        }
        if(Object.hasOwn(room,'board')) add(`${root}/board`,'Room meal plan','text',false);
        if(Object.hasOwn(room,'room_type')) add(root+'/room_type','Requested room type','text',false);
        if(Object.hasOwn(room,'rate_preference')) add(root+'/rate_preference','Requested rate','text',false);
        return room;
      });
      return {...group,rooms};
    });
    const extras=Array.isArray(details.extras)?details.extras:[];
    if(groups.some(group=>group && typeof group==='object' && !Array.isArray(group) && Array.isArray(group.rooms) &&
      group.rooms.some(room=>room && typeof room==='object' && /\b(?:dbb|dinner)\b/i.test(String(room.board ?? group.board)))) &&
      !extras.some(extra=>extra && typeof extra==='object' && /\bdinner\b/i.test(String(extra.description)))) {
      details.extras=[...extras,{description:'Dinner add-on (hotel to confirm price)',quantity:null,price:null}];
    }
    return {...action,details:{...details,groups}};
  });
  return {...draft,actions,field_specs:fieldSpecs};
}

/** Explicit BB/DBB/RO only (DBB before BB). Unrecognized → null (keep raw for staff). */
export function normalizeMemoryBoard(board: unknown): 'BB' | 'DBB' | 'RO' | null {
  const raw = String(board ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === 'BB' || upper === 'DBB' || upper === 'RO') return upper;
  if (/\bDBB\b|DINNER/.test(upper)) return 'DBB';
  if (/\bROOM\s*ONLY\b|\bRO\b/.test(upper)) return 'RO';
  if (/BED\s*(?:AND|&)\s*BREAKFAST|\bB\s*&\s*B\b|\bBB\b|BREAKFAST/.test(upper)) return 'BB';
  return null;
}

/** Create-only room: catalogue code or exact category+bed (or singleton class). Bed/class alone → null. */
export function createRoomTypeCode(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const upper = raw.toUpperCase();
  if (/^(?:STQN|STWN|SKNG|DLXQN|DLXTWN|DLXKNG|EXKNG|LUXKNG|SUITE)$/.test(upper)) return upper;
  const text = raw.toLowerCase();
  const bed = /\btwin\b/.test(text) ? 'TWN' : /\bking\b/.test(text) ? 'KNG'
    : /\bqueen\b|\bdouble\b|\bsingle\b/.test(text) ? 'QN' : null;
  const deluxe = /\bdeluxe\b|\bdlx\b/.test(text);
  const lux = /\blux(?:ury)?\b/.test(text);
  const exec = /\bexec(?:utive)?\b/.test(text);
  const std = /\bstandard\b|\bstd\b/.test(text);
  const suite = /\bsuite\b/.test(text);
  if (suite && !deluxe && !lux && !exec && !std) return 'SUITE';
  if (lux) return bed === null || bed === 'KNG' ? 'LUXKNG' : null;
  if (exec) return bed === null || bed === 'KNG' ? 'EXKNG' : null;
  if (deluxe && bed) return `DLX${bed}`;
  if ((std || /\bdouble\b/.test(text)) && bed) return ({TWN: 'STWN', KNG: 'SKNG', QN: 'STQN'} as const)[bed];
  return null;
}

const CREATE_STQN_DEFAULT_QUOTE = 'Default Standard Queen (STQN) — verify bed/availability';
function shouldDefaultCreateRoomToStqn(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw) return true;
  return /^(?:(?:a|1|one)\s+)?(?:standard|std|single)(?:\s+(?:standard|std|single))?(?:\s+rooms?)?$/i.test(raw);
}

/** HRCEN rate/room wording → native code. Shared Amend/Quote mapper — do not tighten Create guesses here. */
export function hrcenCode(kind:'rate_plan'|'room_type',value:unknown,board:unknown):string|null {
  if(typeof value!=='string' || !value.trim()) return null;
  const text=value.toLowerCase(), meal=String(board ?? '').toUpperCase();
  const plan=/\bdbb\b|dinner/.test(text) || meal==='DBB' ? 'DBB' : /\bro\b|room only/.test(text) || meal==='RO' ? 'RO' : 'BB';
  if(kind==='rate_plan') {
    if(/\bgds government\b/.test(text)) return plan==='RO' ? null : plan==='DBB' ? 'NGDGDB' : 'NGDGB';
    if(/\bed rate\b|\beducational\b/.test(text)) return 'EDU';
    if(/^[A-Z0-9]{1,12}$/.test(value.trim()) && value.trim()!=='BAR') return null;
    if(/\bgov/.test(text)) return {BB:'NGOVB',DBB:'NGOVDB',RO:'NGOVRO'}[plan];
    if(/\bcomp\b|complimentary/.test(text)) return {BB:'CMPBB',DBB:'CMPDBB',RO:'CMPRO'}[plan];
    if(/\bbar\b|best available|rack/.test(text)) return plan==='DBB' ? null : plan==='RO' ? 'BARRO' : 'BAR';
    if(/corporate|negotiated|contract/.test(text)) return plan==='DBB' ? null : plan==='RO' ? 'NCORRO' : 'NCOR1B';
    return null;
  }
  if(/^[A-Z0-9]{1,12}$/.test(value.trim()) && !/^(?:DELUXE|DLX|LUX|LUXURY)$/.test(value.trim())) return null;
  const bed=/twin/.test(text) ? 'TWN' : /king/.test(text) ? 'KNG' : 'QN';
  if(/suite/.test(text)) return 'SUITE';
  if(/deluxe|\bdlx\b/.test(text)) return `DLX${bed}`;
  if(/\blux(ury)?\b/.test(text)) return 'LUXKNG';
  if(/exec/.test(text)) return 'EXKNG';
  if(/standard|single|double|queen|twin|king|\bstd\b/.test(text)) return {TWN:'STWN',KNG:'SKNG',QN:'STQN'}[bed];
  return null;
}

export function createTrackDefault(fields: Record<string,unknown>): string | null {
  const rate=String(fields.rate_plan ?? '');
  return rate.startsWith('NGOV')?'GOV':rate.startsWith('NCOR')?'COR':
    ['BAR','BARRO'].includes(rate)?'BAR':rate==='NGDS3B'?'GDSN':rate==='NG156B'?'COR':
    ['CMPBB','CMPDBB','CMPRO'].includes(rate)?'COM':null;
}

function createGuaranteeDefault(_fields: Record<string,unknown>): string | null {
  // Hardcoded NG156B→GTDCMP / CMPBB→CNFREC removed; party_booking_memory fills silent blanks.
  return null;
}

/** Keep digit-bearing PO/order/voucher refs; prefer Order/PO token when compound. */
function normalizeBillingReference(raw: string, fields: Record<string, unknown>): string | null {
  const ref = raw.trim();
  if (!ref) return null;
  const agency = typeof fields.agency_name === 'string' ? fields.agency_name.trim() : '';
  const org = typeof fields.organization_name === 'string' ? fields.organization_name.trim() : '';
  const sameParty = (agency && ref.toLowerCase() === agency.toLowerCase())
    || (org && ref.toLowerCase() === org.toLowerCase());
  // Strip purely alphabetic company-name copies only.
  if (sameParty && !/\d/.test(ref)) return null;
  // Compound "Voucher X; Order Y" → prefer Order/PO segment when present.
  const parts = ref.split(/[;|,]/).map(part => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const orderish = parts.find(part => /\b(?:order|po|p\.?o\.?)\b/i.test(part) && /\d/.test(part));
    if (orderish) return orderish.slice(0, 50);
  }
  return ref.slice(0, 50);
}

function expandCreateQuantity(draft: ProposalDraft): ProposalDraft {
  const [first]=draft.bookings;
  const count=first?.fields.quantity;
  if(draft.bookings.length!==1 || typeof count!=='number' || !Number.isInteger(count) || count<2 || count>8 ||
    !draft.actions.some(action=>action.type==='create' && action.booking_ids.includes(first.id))) return draft;
  const {quantity:_quantity,...fields}=first.fields;
  const bookings=Array.from({length:count},(_,index)=>({...first,id:index===0?first.id:first.id+':'+index,fields:{...fields}}));
  const paths=(path:string)=>/^\/?bookings\/0\/fields\/quantity$/.test(path) ? [] :
    /^\/?bookings\/0\//.test(path) ? bookings.map((_,index)=>path.replace('bookings/0/', 'bookings/'+index+'/')) : [path];
  return {...draft,bookings,missing:draft.missing.flatMap(paths),
    actions:draft.actions.map(action=>action.type==='create'?{...action,booking_ids:action.booking_ids.flatMap(id=>
      id===first.id?bookings.map(booking=>booking.id):[id])}:action),
    field_specs:draft.field_specs.flatMap(spec=>paths(spec.path).map(path=>({...spec,path})))};
}

export function normalizeProposalFields(draft: ProposalDraft, quoteProperty?:string): {kind:'valid'; draft:ProposalDraft} | {kind:'invalid'; path:string} {
  if(draft.workflow==='create') {
    draft=withCreateNativeFields(createOccupancyFields(expandCreateQuantity(draft)));
    const fieldSpecs=[...draft.field_specs];
    const warnings=[...draft.warnings];
    const nonNativeFields = new Set<string>([...createNoteAliases,...createNonNativeFields]);
    const bookings=draft.bookings.map((booking,index)=>{
      if(booking.property_code!=='HRCEN') return booking;
      const fields={...booking.fields};
      const forRoom=draft.bookings.length>1 ? 'Room '+(index+1)+': ' : '';
      for(const [key,label] of Object.entries(createStaffNoteLabels)) {
        if(fields[key]!=null && fields[key]!=='') warnings.push(forRoom+label+': '+String(fields[key]));
      }
      fields.note=createReservationNote(fields);
      for(const key of nonNativeFields) delete fields[key];
      if(typeof fields.billing_reference==='number' && Number.isSafeInteger(fields.billing_reference)) {
        fields.billing_reference=String(fields.billing_reference);
      }
      if(typeof fields.billing_reference==='string') {
        const ref=normalizeBillingReference(fields.billing_reference, fields);
        fields.billing_reference=ref;
      }
      if(typeof fields.guarantee_type==='string' && fields.guarantee_type.trim()) {
        const code=normalizeGuaranteeCode(fields.guarantee_type);
        if(code) fields.guarantee_type=code;
      }
      // Canonicalize explicit board after note/warnings keep requested wording.
      const boardCanon=normalizeMemoryBoard(fields.board);
      if(boardCanon) fields.board=boardCanon;
      for(const key of ['rate_plan','room_type'] as const) {
        const requested=fields[key];
        const code=key==='room_type' ? createRoomTypeCode(fields[key]) : hrcenCode(key,fields[key],fields.board);
        if(code) fields[key]=code;
        else if(key==='rate_plan' && /\bdbb\b|dinner/i.test(`${fields.board ?? ''} ${fields[key] ?? ''}`)
          && /\bbar\b|best available|rack|corporate|negotiated|contract|\bNCOR1B\b/i.test(String(fields[key] ?? ''))) fields[key]=null;
        if(key==='rate_plan' && requested!=null && requested!=='' && !isCreateRateCode(fields[key])) {
          warnings.push(forRoom+'Requested rate: '+String(requested)+'. Select an Infor rate plan.');
          fields[key]=null;
        }
      }
      if(shouldDefaultCreateRoomToStqn(fields.room_type)) {
        const roomPath=`/bookings/${index}/fields/room_type`;
        const roomSpec=fieldSpecs.findIndex(field=>field.path===roomPath || field.path===roomPath.slice(1));
        const existing=roomSpec>=0 ? fieldSpecs[roomSpec] : null;
        if(!existing || (existing.provenance!=='staff' && !existing.error)) {
          fields.room_type='STQN';
          const evidence=existing?.evidence.length ? existing.evidence
            : [{message_id:'default_room',attachment_id:null,quote:CREATE_STQN_DEFAULT_QUOTE}];
          if(roomSpec>=0) fieldSpecs[roomSpec]={...fieldSpecs[roomSpec],path:roomPath,provenance:'default',error:null,evidence};
          else fieldSpecs.push({path:roomPath,label:'Room type',provenance:'default',editable:true,required:true,error:null,control:'combobox',options:[],evidence});
        }
      }
      for(const [key,value] of [['track',createTrackDefault(fields)],['guarantee_type',createGuaranteeDefault(fields)]] as const) {
        const current=fields[key];
        if(value===null || (current!=null && (typeof current!=='string' || current.trim()))) continue;
        const path=`/bookings/${index}/fields/${key}`;
        const spec=fieldSpecs.findIndex(field=>field.path===path || field.path===path.slice(1));
        if(spec>=0 && (fieldSpecs[spec].provenance==='staff' || fieldSpecs[spec].evidence.length || fieldSpecs[spec].error)) continue;
        fields[key]=value;
        if(spec>=0) fieldSpecs[spec]={...fieldSpecs[spec],path,provenance:'default',error:null,evidence:[]};
      }
      // Initial HRCEN email Create only: code-owned EMA with default provenance. Ignore model source.
      // Authenticated staff edits (provenance staff) win; track/market/credit untouched. Non-HRCEN skipped above.
      if(booking.property_code==='HRCEN') {
        const path=`/bookings/${index}/fields/source_of_business`;
        const spec=fieldSpecs.findIndex(field=>field.path===path || field.path===path.slice(1));
        const existing=spec>=0 ? fieldSpecs[spec] : null;
        if(!existing || (existing.provenance!=='staff' && !existing.error)) {
          fields.source_of_business='EMA';
          if(spec>=0) fieldSpecs[spec]={...fieldSpecs[spec],path,provenance:'default',error:null,evidence:[]};
          else fieldSpecs.push({path,label:'Booking source',provenance:'default',editable:true,required:true,error:null,control:'combobox',options:[],evidence:[]});
        }
      }
      return {...booking,fields};
    });
    const mapped=(path:string)=>/^\/?bookings\/(\d+)\/fields\/([^/]+)$/.exec(path);
    const nonNative=(path:string)=>{const m=mapped(path);return m && bookings[Number(m[1])]?.property_code==='HRCEN' && nonNativeFields.has(m[2]);};
    draft={...draft,bookings,warnings,missing:draft.missing.filter(path=>!nonNative(path)),
      field_specs:fieldSpecs.filter(spec=>!nonNative(spec.path))};
  }
  if(draft.workflow==='quote') draft=withQuoteStaffFields(draft);
  if(draft.workflow==='amend') draft=withAmendSupportedFields(draft);
  if(draft.workflow==='cancel') draft=withCancelReviewFields(draft);
  const scaffold = draft.workflow === 'quote' && draft.disposition === 'needs_info' && !draft.actions.length && draft.field_specs.some(field => field.editable && field.path !== '/reply_draft' && field.path !== 'reply_draft');
  const actions = scaffold ? [{
    id: 'quote-input', type: 'quote', booking_ids: [],
    details: {quote_id:'quote-input',property_code: draft.field_specs.some(field =>
      /(?:^|\/)property_code$/.test(field.path) && (field.error || field.evidence.length)) ? null : quoteProperty ?? null,groups:[{group_id:'stay-input',arrival_date:null,departure_date:null,rooms:null,room_quantity_and_type:null,occupancy:null,board:null}]},
  }] : draft.actions;
  const value = {...draft, actions};
  const seen = new Set<string>();
  const fields: ProposalDraft['field_specs'] = [];
  for (const field of draft.field_specs) {
    const pointer = field.path.startsWith('/') ? field.path : '/' + field.path;
    if (draft.workflow === 'cancel' && field.editable && /^\/bookings\/(0|[1-9]\d*)\/(reservation_id|property_code)$/.test(pointer)) continue;
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
