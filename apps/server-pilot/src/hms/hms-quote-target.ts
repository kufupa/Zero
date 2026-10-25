import { TRPCError } from '@trpc/server';
import { hmsDavinciMakeQuoteEnabled } from '../env.js';
import {
  DAVINCI_HMS_READ_TARGET,
  DAVINCI_ORIGIN_REFUSED_MESSAGE,
  assertPropertyQuoteReady,
  hmsReadTargetForTransport,
  type HmsReadTarget,
} from './hms-read-target.js';
import {
  guardCenturionHmsMailboxOrigin,
  isDaVinciMailboxOrigin,
  type MailboxHmsOriginFields,
  type MailboxHmsOriginLoadInput,
} from './mailbox-hms-origin-bind.js';

/** Same staff copy as the Centurion refuse. Quote flag off keeps that refuse. */
export const DAVINCI_QUOTE_REFUSED_MESSAGE = DAVINCI_ORIGIN_REFUSED_MESSAGE;

export type HmsQuoteJobTargetResult =
  | { ok: true; target: HmsReadTarget }
  | { ok: false; code: 'QUOTE_DAVINCI_DISABLED'; message: string };

function davinciQuoteOrRefuse(env?: NodeJS.Dict<string>): HmsQuoteJobTargetResult {
  if (!hmsDavinciMakeQuoteEnabled(env)) {
    return {
      ok: false,
      code: 'QUOTE_DAVINCI_DISABLED',
      message: DAVINCI_QUOTE_REFUSED_MESSAGE,
    };
  }
  return {
    ok: true,
    target: assertPropertyQuoteReady(DAVINCI_HMS_READ_TARGET.propertyCode, env),
  };
}

/**
 * Quote-only mailbox → property. Flag off (the default) keeps the Centurion refuse.
 * Does not open create/amend/cancel. Unknown codes stay unknown.
 */
export function quoteTargetForTransport(
  transportId: string,
  env: NodeJS.Dict<string> = process.env,
): HmsQuoteJobTargetResult {
  const target = hmsReadTargetForTransport(transportId);
  if (target.browserSlot !== 'davinci') return { ok: true, target };
  return davinciQuoteOrRefuse(env);
}

/** Worker/queue re-check: Da Vinci transport or origin needs HMS_DAVINCI_MAKE_QUOTE=on. */
export function quoteTargetForHmsJob(input: {
  transportId: string;
  origin?: MailboxHmsOriginFields | null;
  env?: NodeJS.Dict<string>;
}): HmsQuoteJobTargetResult {
  const target = hmsReadTargetForTransport(input.transportId);
  if (target.browserSlot !== 'davinci' && !isDaVinciMailboxOrigin(input.origin ?? {})) {
    return { ok: true, target };
  }
  return davinciQuoteOrRefuse(input.env);
}

/**
 * Thread-scan plus Da Vinci staff transports. Never returns Centurion for a Da Vinci inbox.
 * Flag off: same refuse as #292. Flag on: HRDAV.
 */
export async function resolveHmsQuoteJobTarget(
  input: MailboxHmsOriginLoadInput & { env?: NodeJS.Dict<string> },
): Promise<HmsQuoteJobTargetResult> {
  const target = hmsReadTargetForTransport(input.transportId);
  if (target.browserSlot === 'davinci') return davinciQuoteOrRefuse(input.env);
  const guard = await guardCenturionHmsMailboxOrigin(input);
  if (guard.ok) return { ok: true, target };
  return davinciQuoteOrRefuse(input.env);
}

/** Quote routes: Da Vinci origins pass only when HMS_DAVINCI_MAKE_QUOTE=on. */
export async function assertHmsQuoteOriginAllowed(
  input: MailboxHmsOriginLoadInput & { env?: NodeJS.Dict<string> },
): Promise<HmsReadTarget> {
  const resolved = await resolveHmsQuoteJobTarget(input);
  if (!resolved.ok) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: resolved.message });
  }
  return resolved.target;
}
