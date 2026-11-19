import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {CaseCard} from '../types.js';

export const DEFAULT_DATA_ROOT='/home/orca/.local/share/zero/bench/replay-bench-20261119';

export type TwinPdf = {
  sent_at?:string;
  filed_at?:string;
  pdf_fields?:Record<string,unknown>;
  fields?:Record<string,unknown>;
  [key:string]:unknown;
};

export type TwinAnchor = {
  confirmation:string;
  hms_capture_later?:string;
  hms_fields:Record<string,unknown>;
  pdfs?:TwinPdf[];
  [key:string]:unknown;
};

export type TwinProfile = {
  nativeId:string;
  firstName?:string|null;
  lastName?:string|null;
  email?:string|null;
  mobile?:string|null;
  fields?:Array<{name?:string;value?:unknown;rawValue?:unknown}>;
  [key:string]:unknown;
};

type BaseWorld = {
  anchors:TwinAnchor[];
  anchorsByConfirmation:Map<string,TwinAnchor>;
  profiles:TwinProfile[];
  catalog:Record<string,unknown>;
};

const baseCache=new Map<string,BaseWorld>();
const object=(value:unknown):Record<string,unknown> =>
  value!==null && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};

function jsonl<T>(path:string):T[] {
  return readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as T);
}

function loadBase(root:string):BaseWorld {
  const cached=baseCache.get(root);
  if(cached) return cached;
  const anchors=jsonl<TwinAnchor>(join(root,'world/anchors.jsonl'));
  const profilesFile=JSON.parse(readFileSync(join(root,'world/profiles.json'),'utf8')) as {profiles?:TwinProfile[]};
  const catalog=JSON.parse(readFileSync(join(root,'catalog/catalog.json'),'utf8')) as Record<string,unknown>;
  const base={
    anchors,
    anchorsByConfirmation:new Map(anchors.map(anchor=>[anchor.confirmation,anchor])),
    profiles:profilesFile.profiles ?? [],
    catalog,
  };
  baseCache.set(root,base);
  return base;
}

export function quoteKey(arrival:string,departure:string,room:string):string {
  return `${arrival}|${departure}|${room}`.toLowerCase();
}

function loadQuotes(value:unknown,target:Map<string,unknown>):void {
  if(Array.isArray(value)) {
    for(const item of value) loadQuotes(item,target);
    return;
  }
  const row=object(value);
  const arrival=String(row.arrival_date ?? row.arrivalDate ?? '');
  const departure=String(row.departure_date ?? row.departureDate ?? '');
  const room=String(row.room ?? row.room_code ?? row.roomCode ?? row.room_type ?? row.roomType ?? '');
  if(arrival && departure && room) target.set(quoteKey(arrival,departure,room),row.result ?? row.response ?? row.value ?? row);
  for(const [key,item] of Object.entries(row)) {
    if(key.includes('|') || /^\d{4}-\d\d-\d\d[/:]/.test(key)) target.set(key.toLowerCase().replaceAll('/', '|'),item);
  }
}

function initialDocuments(card:CaseCard):Array<Record<string,unknown>> {
  const direct=(card.documents ?? object(card.later_hms).documents) as unknown;
  return Array.isArray(direct) ? direct.map(item=>({...object(item)})) : [];
}

function bookingFields(input:Record<string,unknown>):Record<string,unknown> {
  const booking=object(input.booking);
  return {...object(booking.fields),...object(object(input.action).details)};
}

export class TwinWorld {
  readonly anchors:TwinAnchor[];
  readonly anchorsByConfirmation:Map<string,TwinAnchor>;
  readonly profiles:TwinProfile[];
  readonly catalog:Record<string,unknown>;
  readonly quotes=new Map<string,unknown>();
  readonly reservations=new Map<string,Record<string,unknown>>();
  readonly documents:Array<Record<string,unknown>>;
  readonly coverage={quoteMisses:0};
  readonly anchor?:TwinAnchor;
  saveCount=0;

  constructor(readonly caseCard:CaseCard,root=process.env.NAVA_BENCH_DATA_ROOT ?? DEFAULT_DATA_ROOT) {
    const base=loadBase(root);
    this.anchors=base.anchors;
    this.anchorsByConfirmation=base.anchorsByConfirmation;
    this.profiles=base.profiles;
    this.catalog=base.catalog;
    const confirmation=caseCard.real_confirmation ?? caseCard.confirmation ?? undefined;
    this.anchor=confirmation ? base.anchorsByConfirmation.get(confirmation) : undefined;
    if(confirmation) {
      const later=object(object(caseCard.later_hms).fields);
      this.reservations.set(confirmation,{...(this.anchor?.hms_fields ?? {}),...later,confirmation});
    }
    loadQuotes(caseCard.quotes,this.quotes);
    loadQuotes(object(caseCard.world).quotes,this.quotes);
    loadQuotes(caseCard.recorded_prices,this.quotes);
    this.documents=initialDocuments(caseCard);
  }

  save(input:unknown):Record<string,unknown> {
    const request=object(input);
    const workflow=String(request.workflow ?? this.caseCard.workflow);
    const original=String(object(request.booking).reservation_id ?? this.caseCard.real_confirmation ?? this.caseCard.confirmation ?? '');
    const fields=bookingFields(request);
    const caseId=this.caseCard.case_id.replace(/[^a-z0-9-]/gi,'-');
    const confirmation=`TWIN-${caseId}-${++this.saveCount}`;
    const current={...(this.reservations.get(original) ?? this.anchor?.hms_fields ?? {})};
    if(workflow==='cancel') current.status='Cancelled';
    else if(workflow==='filing') {
      const prepared=object(request.prepared);
      const document={...object(prepared.document),...object(object(request.action).details),filed_at:new Date().toISOString()};
      this.documents.push(document);
    } else Object.assign(current,fields);
    current.confirmation=confirmation;
    this.reservations.set(confirmation,current);
    if(original && workflow!=='create') this.reservations.set(original,current);
    return {
      confirmation,
      reservation_id:confirmation,
      readback:{confirmation,nativeStayId:confirmation,fields:current,documents:[...this.documents]},
    };
  }
}

export function loadTwinWorld(caseCard:CaseCard,root?:string):TwinWorld {
  return new TwinWorld(caseCard,root);
}
