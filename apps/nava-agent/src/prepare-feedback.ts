import { z } from 'zod';
import { attachmentsUnconfirmed } from './attachment-gate.js';
import type { Workflow } from './schema.js';
import type { ToolResult } from './tool-registry.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,79}$/);
const labels = new Map([
  ['guest', 'guest profile'], ['stay.arrival', 'arrival date'], ['stay.departure', 'departure date'],
  ['stay.dateRange', 'stay dates'], ['stay.adults', 'adult count'], ['stay.childAges', 'child ages'],
  ['stay.childCount', 'child count'], ['room.roomType', 'room type'], ['room.roomTypeForCharge', 'charged room type'],
  ['room.ratePlan', 'rate plan'], ['room.ratePlanCriteria', 'rate plan'], ['room.rateAvailability', 'rate availability'],
  ['guaranteeType', 'guarantee type'], ['guaranteeType.staging', 'guarantee type'], ['sourceOfBusiness', 'booking source'],
]);
const messages = new Map([
  ['guest_ambiguous', 'More than one Infor guest profile matched. Select the correct profile.'],
  ['guest_choice_required', 'Select a guest profile before preparing again.'],
  ['guest_not_found', 'Infor could not find the guest profile. Verify the guest in Infor.'],
  ['guest_email_unverified', 'Infor could not verify the guest email against the selected profile.'],
  ['room_type_not_unique', 'Infor could not confirm the selected room type. Check the room code.'],
  ['CURRENT_RATE_CODE_UNVERIFIED', 'Infor did not confirm this rate code for the selected stay.'],
  ['RATE_SHOP_CRITERIA_UNAVAILABLE', 'Infor could not confirm the rate for these stay details. Check the rate code.'],
  ['RATE_PRICE_UNCONFIRMED', 'Infor could not confirm the price for this rate.'],
  ['RATE_AVAILABILITY_UNVERIFIED', 'Infor could not verify availability for this rate.'],
  ['rate_availability_unverified', 'Infor could not verify availability for this rate.'],
  ['HMS_BROWSER_HOLD', 'Infor is still holding a session for this guest and arrival. Wait for it to close before preparing again.'],
  ['INVALID_CREATE_TARGET', 'Check the guest first name, last name, and arrival date.'],
]);
const optionalIdentifier = identifier.optional().catch(undefined);
const nativeRejection = z.object({
  issue: optionalIdentifier, field: optionalIdentifier, missing: z.array(identifier).catch([]),
  ratePlanIssue: z.object({ issue: optionalIdentifier }).optional().catch(undefined),
});
export const prepareRejection = z.object({ issues: z.array(identifier).max(2), fields: z.array(identifier).max(12) }).strict();
type PrepareRejection = z.infer<typeof prepareRejection>;

export function readPrepareRejection(data: unknown, code: string | undefined): PrepareRejection {
  const result = z.object({ native: nativeRejection.optional() }).safeParse(data);
  const native = result.success ? result.data.native : undefined;
  const issues = [native?.issue, native?.ratePlanIssue?.issue].filter((issue): issue is string => issue !== undefined);
  if (!issues.length && code && messages.has(code)) issues.push(code);
  const fields = [native?.field, ...(native?.missing ?? [])].filter((field): field is string => field !== undefined);
  return { issues: [...new Set(issues)], fields: [...new Set(fields)].slice(0, 12) };
}

export function describePrepareRejection({ issues, fields }: PrepareRejection): string {
  const reasons = issues.map(issue => messages.get(issue) ?? `Infor rejected Prepare (${issue}).`);
  if (fields.length) reasons.push(`Check: ${[...new Set(fields.map(field => labels.get(field) ?? field))].join(', ')}.`);
  return reasons.join(' ') || 'HMS Prepare did not complete.';
}

const rowBase = {id:z.string().min(1),booking_id:z.string().nullable(),label:z.string(),native_path:z.string(),
  quote_id:z.string().optional(),group_id:z.string().optional()};
const displayRow = z.discriminatedUnion('kind', [
  z.object({...rowBase,kind:z.literal('text'),value:z.string().nullable()}),
  z.object({...rowBase,kind:z.literal('code'),code:z.string().nullable(),meaning:z.string().nullable()}),
  z.object({...rowBase,kind:z.literal('availability'),status:z.enum(['available','unavailable','restricted','unknown']),rooms_available:z.number().finite().nullable()}),
  z.object({...rowBase,kind:z.literal('money'),amount:z.string().nullable(),currency:z.string().nullable(),
    unit:z.enum(['night','stay','room','person']).nullable(),date:z.string().nullable(),basis:z.enum(['native','calculated']),official:z.boolean()}),
]);
const nativePrice = z.object({
  averageRate:z.string().nullable().optional(),totalRate:z.string().nullable().optional(),currency:z.string().nullable().optional(),
});
const createObserved=z.object({
  arrival:z.string().optional(),departure:z.string().optional(),adults:z.union([z.string(),z.number()]).optional(),
  childAges:z.array(z.number()).optional(),roomType:z.string().optional(),roomTypeForCharge:z.string().optional(),
  ratePlan:z.string().optional(),guaranteeType:z.string().optional(),sourceOfBusiness:z.string().optional(),
  track:z.string().optional(),mealPlan:z.string().optional(),
}).optional().catch(undefined);
const envelope = z.object({native_result:z.unknown(),display_rows:z.array(z.unknown()).optional(),
  observed_fields:z.unknown(),coverage:z.unknown(),cancellation_fee:z.unknown(),
  native:z.object({ratePlanAvailability:nativePrice.nullable().optional(),applied:createObserved,
    stage:optionalIdentifier,issue:optionalIdentifier,
    detail:z.object({issue:optionalIdentifier}).optional().catch(undefined),
  }).optional(),
  rate_choices:z.unknown(),guest_candidates:z.unknown(),track_choices:z.unknown(),
}).passthrough();

export function stageFeedback({result,workflow,bookingId,revision,jobId,quoteId}:{
  result:ToolResult|null;workflow:Workflow;bookingId:string|null;revision:number;jobId:string;quoteId?:string;
}) {
  const capture=envelope.safeParse(result?.data).data;
  const rate=capture?.native?.ratePlanAvailability;
  const failedStep=workflow==='create' && !result?.ok ? capture?.native?.stage : undefined;
  const detailIssue=workflow==='create' && !result?.ok ? capture?.native?.detail?.issue ?? capture?.native?.issue : undefined;
  const observed=capture?.observed_fields ?? (workflow==='create'?capture?.native?.applied:undefined);
  const rows=(capture?.display_rows ?? []).flatMap(value=>{
    const row=displayRow.safeParse(value);
    return row.success ? [row.data] : [];
  });
  if (workflow==='create' && result?.ok && !rows.length && rate?.currency) {
    for (const [key,label,unit] of [['averageRate','Average nightly rate','night'],['totalRate','Stay total','stay']] as const) {
      const amount=rate[key];
      if(typeof amount==='string') rows.push({id:unit,booking_id:bookingId,kind:'money',label,amount,unit,
        native_path:`/native/ratePlanAvailability/${key}`,currency:rate.currency,date:null,basis:'native',official:true});
    }
  }
  const native=workflow==='create' ? {
    native:rate || failedStep || detailIssue ? {
      ...(rate?{ratePlanAvailability:rate}:{}),...(failedStep?{stage:failedStep}:{}),...(detailIssue?{detail:{issue:detailIssue}}:{}),
    } : null,
    rate_choices:capture?.rate_choices ?? null,guest_candidates:capture?.guest_candidates ?? null,
    track_choices:capture?.track_choices ?? null,
  } : capture?.native_result ?? result?.data ?? null;
  const bounded=native===null || Buffer.byteLength(JSON.stringify(native) ?? '')<=2_000_000;
  const code=bounded?result?.error?.code ?? 'STAFF_JOB_CHANGED':'NATIVE_RESULT_TOO_LARGE';
  const ok=!!result?.ok && bounded;
  const attachmentsBlocked=code===attachmentsUnconfirmed.code;
  const prepare=readPrepareRejection(result?.data,code);
  const hasCreateFeedback=workflow==='create' && (prepare.issues.length>0 || prepare.fields.length>0);
  const read=workflow==='quote' || workflow==='triage';
  const action=read?'native read':'Prepare';
  const error=ok ? null : {
    code, outcome:'known', operation:'staff_stage',
    message:attachmentsBlocked?attachmentsUnconfirmed.message:hasCreateFeedback?describePrepareRejection(prepare):
      code==='NATIVE_RESULT_TOO_LARGE'?'Infor returned more details than Nava can show.':
      code==='STAFF_JOB_CHANGED' || code==='STAFF_SOURCE_CHANGED'?'The selected source or proposal revision changed.':
      result?.error?.message.slice(0,240) ?? `HMS ${action} did not complete.`,
    recovery:attachmentsBlocked?attachmentsUnconfirmed.message:`Review the proposal and run ${action} again.`,
    ...(hasCreateFeedback?{prepare}:{}),
  };
  const hasCapture=workflow==='create' ? !!rate || !!failedStep || !!detailIssue || observed!==undefined || capture?.guest_candidates!=null
    || capture?.rate_choices!=null || capture?.track_choices!=null
    : native!==null;
  const stage=bounded && (ok || hasCapture) ? {
    state:ok?'prepared':'incomplete',revision,job_id:jobId,...(quoteId?{quote_id:quoteId}:{}),
    summary:[ok?`HMS ${action} complete. Nothing saved.`:`HMS ${action} incomplete. Nothing saved.`,
      ...(failedStep?[`Infor stopped at ${failedStep}${detailIssue?` (${detailIssue})`:''}.`]:[])],
    native_result:native,display_rows:rows,
    ...(observed!==undefined?{observed_fields:observed}:{}),
    ...(capture?.coverage!==undefined?{coverage:capture.coverage}:{}),
    ...(capture?.cancellation_fee!==undefined?{cancellation_fee:capture.cancellation_fee}:{}),
  } : null;
  return {stage,error};
}
