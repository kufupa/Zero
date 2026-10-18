import { TRPCError } from '@trpc/server';
import {
  guardCenturionHmsMailboxOrigin,
  isDaVinciMailboxOrigin,
  type MailboxHmsOriginFields,
  type MailboxHmsOriginLoadInput,
} from './mailbox-hms-origin-bind.js';

export type HmsReadBrowserSlot = 'centurion' | 'davinci';

export type HmsReadTarget = {
  propertyCode: string;
  secretId: string;
  browserSlot: HmsReadBrowserSlot;
};

/** Centurion pane reads: existing secret name and borrowed-browser slot. */
export const CENTURION_HMS_READ_TARGET: HmsReadTarget = Object.freeze({
  propertyCode: 'HRCEN',
  secretId: 'nava-zero/server-pilot/infor-hms-read',
  browserSlot: 'centurion',
});

/** Da Vinci pane reads: HRDAV secret name and a slot that must not share Centurion CDP. */
export const DAVINCI_HMS_READ_TARGET: HmsReadTarget = Object.freeze({
  propertyCode: 'HRDAV',
  secretId: 'nava-zero/server-pilot/infor-hms-read-davinci',
  browserSlot: 'davinci',
});

const KNOWN_READ_TARGETS: readonly HmsReadTarget[] = [
  CENTURION_HMS_READ_TARGET,
  DAVINCI_HMS_READ_TARGET,
];

/** Every Da Vinci staff mailbox. External guest mail in these inboxes is still HRDAV. */
export const DAVINCI_STAFF_TRANSPORT_IDS = [
  'transport-davinci',
  'transport-faith',
  'transport-ayanda',
  'transport-epick',
  'transport-kmgidi',
] as const;

const DAVINCI_STAFF_TRANSPORT_SET: ReadonlySet<string> = new Set(DAVINCI_STAFF_TRANSPORT_IDS);

/** Staff-facing copy when a Da Vinci-origin thread must not use Centurion HMS. */
export const DAVINCI_ORIGIN_REFUSED_MESSAGE =
  'This mail is for Da Vinci — Centurion HMS not searched';

export type HmsReadJobTargetResult =
  | { ok: true; target: HmsReadTarget }
  | { ok: false; code: 'READ_DAVINCI_ORIGIN_REFUSED'; message: string };

/** Exact `on`. Off (the default) keeps the #292 refuse. */
export function hmsDavinciReadsEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.HMS_DAVINCI_READS === 'on';
}

export function isDaVinciTransport(transportId: string): boolean {
  return DAVINCI_STAFF_TRANSPORT_SET.has(transportId);
}

function davinciReadOrRefuse(env?: NodeJS.Dict<string>): HmsReadJobTargetResult {
  if (!hmsDavinciReadsEnabled(env)) {
    return {
      ok: false,
      code: 'READ_DAVINCI_ORIGIN_REFUSED',
      message: DAVINCI_ORIGIN_REFUSED_MESSAGE,
    };
  }
  return { ok: true, target: DAVINCI_HMS_READ_TARGET };
}

/**
 * Maps a mailbox transport or mail origin to the HMS property/secret/slot.
 * Does not apply the env flag; callers that enqueue jobs use readTargetForHmsJob.
 */
export function hmsReadTargetForTransport(
  transportOrOrigin: string | MailboxHmsOriginFields,
): HmsReadTarget {
  if (typeof transportOrOrigin === 'string') {
    return isDaVinciTransport(transportOrOrigin)
      ? DAVINCI_HMS_READ_TARGET
      : CENTURION_HMS_READ_TARGET;
  }
  return isDaVinciMailboxOrigin(transportOrOrigin)
    ? DAVINCI_HMS_READ_TARGET
    : CENTURION_HMS_READ_TARGET;
}

/** Flag off: Da Vinci origin/transport still refused. Flag on: job carries the HRDAV target. */
export function readTargetForHmsJob(input: {
  transportId: string;
  origin?: MailboxHmsOriginFields | null;
  env?: NodeJS.Dict<string>;
}): HmsReadJobTargetResult {
  const daVinci =
    isDaVinciTransport(input.transportId) || isDaVinciMailboxOrigin(input.origin ?? {});
  if (!daVinci) return { ok: true, target: CENTURION_HMS_READ_TARGET };
  return davinciReadOrRefuse(input.env);
}

/**
 * Thread-scan #292 guard plus Da Vinci staff transports. Never returns Centurion for a
 * Da Vinci inbox, even when the selected mail has no Da Vinci identity (guest → faith).
 */
export async function resolveHmsReadJobTarget(
  input: MailboxHmsOriginLoadInput & { env?: NodeJS.Dict<string> },
): Promise<HmsReadJobTargetResult> {
  if (isDaVinciTransport(input.transportId)) return davinciReadOrRefuse(input.env);
  const guard = await guardCenturionHmsMailboxOrigin(input);
  if (guard.ok) return { ok: true, target: CENTURION_HMS_READ_TARGET };
  return davinciReadOrRefuse(input.env);
}

/** Pane read routes: Da Vinci origins pass only when HMS_DAVINCI_READS=on. */
export async function assertHmsReadOriginAllowed(
  input: MailboxHmsOriginLoadInput,
): Promise<HmsReadTarget> {
  const resolved = await resolveHmsReadJobTarget(input);
  if (!resolved.ok) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: resolved.message });
  }
  return resolved.target;
}

/** Job metrics may only carry one of the two frozen read targets. Unknown shapes are rejected. */
export function parseHmsReadTarget(raw: unknown): HmsReadTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return (
    KNOWN_READ_TARGETS.find(
      (target) =>
        target.propertyCode === value.propertyCode &&
        target.secretId === value.secretId &&
        target.browserSlot === value.browserSlot,
    ) ?? null
  );
}

/** Extra metrics for a job that must not run on the Centurion slot. Centurion jobs omit the key. */
export function hmsReadTargetJobMetrics(
  target: HmsReadTarget,
): { hmsReadTarget: HmsReadTarget } | null {
  if (target.browserSlot !== 'davinci') return null;
  return { hmsReadTarget: target };
}

export class HmsReadActorRequiredError extends Error {
  constructor() {
    super('staff-kicked HMS read requires actorUserId');
    this.name = 'HmsReadActorRequiredError';
  }
}

export type HmsReadAuditMetrics = {
  actorKind: 'user' | 'system' | 'h1';
  actorUserId: string | null;
  propertyCode: string;
  slotId: HmsReadBrowserSlot;
};

/** Staff/system/h1 audit for a pane HMS read. Never stores NAVAAI. Never `unknown`. */
export function hmsReadAuditMetrics(input: {
  actorKind: 'user' | 'system' | 'h1';
  actorUserId?: string | null;
  target: HmsReadTarget;
}): HmsReadAuditMetrics {
  if (input.actorKind === 'user') {
    const actorUserId = input.actorUserId?.trim() ?? '';
    if (!actorUserId) throw new HmsReadActorRequiredError();
    return {
      actorKind: 'user',
      actorUserId,
      propertyCode: input.target.propertyCode,
      slotId: input.target.browserSlot,
    };
  }
  return {
    actorKind: input.actorKind,
    actorUserId: null,
    propertyCode: input.target.propertyCode,
    slotId: input.target.browserSlot,
  };
}
