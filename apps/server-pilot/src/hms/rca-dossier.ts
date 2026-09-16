/**
 * Phase B RCA dossier v1 — closed, PII-free machine schema + eval stub loader.
 * No private values, guest fields, or free-form private-looking keys.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { READ_TOOL_IDS, READ_TOOLS, type ReadToolId } from './read-tools.js';

const sha256Hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'expected lowercase sha256 hex');

/** Named blocker codes only — BLOCKED_* tokens, no free text. */
export const rcaBlockerCodeSchema = z
  .string()
  .regex(/^BLOCKED_[A-Z][A-Z0-9_]*$/, 'expected BLOCKED_* code');

/** Sanitized operator symptom: short, no @, no long digit runs. */
export const rcaSanitizedSymptomSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((s) => !s.includes('@'), 'symptom must not look like an address')
  .refine(
    (s) => !/\d{6,}/.test(s),
    'symptom must not contain long numeric runs',
  );

export const rcaStructuralObservationSchema = z
  .object({
    routeClass: z.string().min(1).max(64),
    envelopeDiscriminator: z.string().min(1).max(64),
    fingerprintDigest: sha256Hex.optional(),
  })
  .strict();

export const rcaDossierV1Schema = z
  .object({
    toolId: z.enum(READ_TOOL_IDS),
    toolVersion: z.string().min(1).max(32),
    symptom: rcaSanitizedSymptomSchema,
    structuralObservation: rcaStructuralObservationSchema,
    assumptionsVerified: z.array(z.string().min(1).max(200)).max(32),
    assumptionsInvalidated: z.array(z.string().min(1).max(200)).max(32),
    causalChain: z.array(z.string().min(1).max(200)).max(32),
    prediction: z.string().min(1).max(400),
    failingTestPath: z.string().min(1).max(260).optional(),
    redCommand: z.string().min(1).max(400).optional(),
    greenCommand: z.string().min(1).max(400).optional(),
    verificationCommands: z.array(z.string().min(1).max(400)).max(16),
    liveArtifactIds: z.array(z.string().uuid()).max(16),
    unresolvedGaps: z.array(rcaBlockerCodeSchema).max(32),
    nativeRequestDifferentialDigest: sha256Hex.optional(),
    negativeCertificateDigest: sha256Hex.optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type RcaDossierV1 = z.infer<typeof rcaDossierV1Schema>;

/** Tools that need an empirical discovery/RCA loop (fixture_verified or live matrix). */
export const RCA_DOSSIER_REQUIRED_TOOL_IDS = [
  'hms_find_reservation',
  'hms_quote_stay',
  'hms_list_documents',
  'hms_sent_email_audit',
  'hms_read_folio',
  'hms_company_account_read',
  'hms_group_block_read',
  'hms_event_read',
] as const satisfies readonly ReadToolId[];

export type RcaDossierRequiredToolId =
  (typeof RCA_DOSSIER_REQUIRED_TOOL_IDS)[number];

const here = dirname(fileURLToPath(import.meta.url));

export function defaultRcaDossierDir(): string {
  return join(here, '..', '..', 'evals', 'hms', 'rca-dossiers');
}

export function rcaDossierPathFor(
  toolId: ReadToolId,
  dir: string = defaultRcaDossierDir(),
): string {
  return join(dir, `${toolId}.json`);
}

export function parseRcaDossier(raw: unknown): RcaDossierV1 {
  return rcaDossierV1Schema.parse(raw);
}

export function loadRcaDossier(
  toolId: ReadToolId,
  dir: string = defaultRcaDossierDir(),
): RcaDossierV1 {
  const path = rcaDossierPathFor(toolId, dir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `RCA dossier missing or unreadable for ${toolId}: ${path}`,
      { cause: error },
    );
  }
  const dossier = parseRcaDossier(parsed);
  if (dossier.toolId !== toolId) {
    throw new Error(
      `RCA dossier toolId mismatch: file=${toolId} payload=${dossier.toolId}`,
    );
  }
  const expectedVersion = READ_TOOLS[toolId].version;
  if (dossier.toolVersion !== expectedVersion) {
    throw new Error(
      `RCA dossier toolVersion mismatch for ${toolId}: dossier=${dossier.toolVersion} registry=${expectedVersion}`,
    );
  }
  return dossier;
}
