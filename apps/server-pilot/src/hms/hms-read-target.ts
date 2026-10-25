import { TRPCError } from '@trpc/server';
import {
  PROPERTY_REGISTRY,
  getPropertyRegistration,
  getPropertyTransportIds,
  resolvePropertyTransport,
} from '../../tooling/playwright-quote/property-registry.mjs';
import {
  guardCenturionHmsMailboxOrigin,
  isCenturionMailboxOrigin,
  isDaVinciMailboxOrigin,
  type MailboxHmsOriginFields,
  type MailboxHmsOriginLoadInput,
} from './mailbox-hms-origin-bind.js';
import { hmsProductionOriginForSlot } from './browser-artifacts.js';
import { refuseProperty } from './property-refusal.js';

export type HmsReadBrowserSlot = 'centurion' | 'davinci';

export type HmsReadTarget = {
  propertyCode: string;
  secretId: string;
  browserSlot: HmsReadBrowserSlot;
  origin: string;
  installationEnvName: string;
};

export function staffQuoteInstallationEnvName(propertyCode: string): string {
  return propertyCode === 'HRCEN'
    ? 'RESERVATIONIST_STAFF_QUOTE_CONFIGURATION'
    : `RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_${propertyCode}`;
}

function asReadBrowserSlot(slot: string): HmsReadBrowserSlot | null {
  return slot === 'centurion' || slot === 'davinci' ? slot : null;
}

function targetForRegisteredProperty(propertyCode: string): HmsReadTarget {
  const property = getPropertyRegistration(propertyCode);
  if (!property) return refuseProperty({ code: 'property_unknown' });
  const browserSlot = asReadBrowserSlot(property.browserSlot);
  const origin = browserSlot ? hmsProductionOriginForSlot(browserSlot) : null;
  if (!browserSlot || !origin || !property.credentialSecretRef) {
    return refuseProperty({ code: 'not_set_up' });
  }
  return Object.freeze({
    propertyCode: property.propertyCode,
    secretId: property.credentialSecretRef,
    browserSlot,
    origin,
    installationEnvName: staffQuoteInstallationEnvName(property.propertyCode),
  });
}

/** Worker read_tool hotel: env must name an active registry hotel. Unset/unknown/inactive refuse. */
export function readToolExpectedPropertyCode(env: NodeJS.Dict<string> = process.env): string {
  const code = env.HMS_EXPECTED_PROPERTY_CODE?.trim() ?? '';
  if (!code) return refuseProperty({ code: 'not_set_up' });
  return hmsReadTargetForProperty(code).propertyCode;
}

/** Quote flag `on` needs secret, slot, origin, installation, and a rate/fields profile. */
export function assertPropertyQuoteReady(
  propertyCode: string,
  env: NodeJS.Dict<string> = process.env,
): HmsReadTarget {
  const target = hmsReadTargetForProperty(propertyCode);
  const installation = env[target.installationEnvName];
  const property = getPropertyRegistration(propertyCode);
  if (
    typeof installation !== 'string' ||
    !installation.trim() ||
    !property?.profileFile ||
    !target.secretId ||
    !target.origin
  ) {
    return refuseProperty({ code: 'not_set_up' });
  }
  return target;
}

/** Request-time resolver; registry descriptors remain importable when a property is inactive. */
export function hmsReadTargetForProperty(propertyCode: string): HmsReadTarget {
  const property = getPropertyRegistration(propertyCode);
  if (!property) return refuseProperty({ code: 'property_unknown' });
  if (!property.active) return refuseProperty({ code: 'property_inactive' });
  return targetForRegisteredProperty(property.propertyCode);
}

/** Centurion pane reads: sourced from the property registry. */
export const CENTURION_HMS_READ_TARGET: HmsReadTarget = targetForRegisteredProperty('HRCEN');

/** Da Vinci pane reads: sourced from its isolated registry slot and secret. */
export const DAVINCI_HMS_READ_TARGET: HmsReadTarget = targetForRegisteredProperty('HRDAV');

const KNOWN_READ_TARGETS: readonly HmsReadTarget[] = PROPERTY_REGISTRY.properties
  .filter((property) => property.active)
  .map((property) => hmsReadTargetForProperty(property.propertyCode));

/** Every Da Vinci staff mailbox. External guest mail in these inboxes is still HRDAV. */
export const DAVINCI_STAFF_TRANSPORT_IDS = getPropertyTransportIds('HRDAV');

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

/** Identity classification; active HMS access is checked by the target resolver. */
export function isDaVinciTransport(transportId: string): boolean {
  return DAVINCI_STAFF_TRANSPORT_IDS.includes(transportId.trim());
}

function davinciReadOrRefuse(env?: NodeJS.Dict<string>): HmsReadJobTargetResult {
  const target = hmsReadTargetForProperty(DAVINCI_HMS_READ_TARGET.propertyCode);
  if (!hmsDavinciReadsEnabled(env)) {
    return {
      ok: false,
      code: 'READ_DAVINCI_ORIGIN_REFUSED',
      message: DAVINCI_ORIGIN_REFUSED_MESSAGE,
    };
  }
  return { ok: true, target };
}

/**
 * Maps a mailbox transport or mail origin to the HMS property/secret/slot.
 * Does not apply the env flag; callers that enqueue jobs use readTargetForHmsJob.
 */
export function hmsReadTargetForTransport(
  transportOrOrigin: string | MailboxHmsOriginFields,
): HmsReadTarget {
  if (typeof transportOrOrigin === 'string') {
    const resolved = resolvePropertyTransport(transportOrOrigin);
    if (resolved.kind === 'refusal') return refuseProperty(resolved);
    if (resolved.kind === 'collector') {
      return refuseProperty({ code: 'collector_no_hotel', transportId: resolved.transportId });
    }
    return hmsReadTargetForProperty(resolved.property.propertyCode);
  }
  if (isDaVinciMailboxOrigin(transportOrOrigin)) {
    return hmsReadTargetForProperty(DAVINCI_HMS_READ_TARGET.propertyCode);
  }
  if (isCenturionMailboxOrigin(transportOrOrigin)) {
    return hmsReadTargetForProperty(CENTURION_HMS_READ_TARGET.propertyCode);
  }
  return refuseProperty({ code: 'property_unknown' });
}

/** Flag off: Da Vinci origin/transport still refused. Flag on: job carries the HRDAV target. */
export function readTargetForHmsJob(input: {
  transportId: string;
  origin?: MailboxHmsOriginFields | null;
  env?: NodeJS.Dict<string>;
}): HmsReadJobTargetResult {
  const target = hmsReadTargetForTransport(input.transportId);
  if (target.browserSlot !== 'davinci' && !isDaVinciMailboxOrigin(input.origin ?? {})) {
    return { ok: true, target };
  }
  return davinciReadOrRefuse(input.env);
}

/**
 * Thread-scan #292 guard plus Da Vinci staff transports. Never returns Centurion for a
 * Da Vinci inbox, even when the selected mail has no Da Vinci identity (guest → faith).
 */
export async function resolveHmsReadJobTarget(
  input: MailboxHmsOriginLoadInput & { env?: NodeJS.Dict<string> },
): Promise<HmsReadJobTargetResult> {
  const target = hmsReadTargetForTransport(input.transportId);
  if (target.browserSlot === 'davinci') return davinciReadOrRefuse(input.env);
  const guard = await guardCenturionHmsMailboxOrigin(input);
  if (guard.ok) return { ok: true, target };
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
