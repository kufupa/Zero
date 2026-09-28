/**
 * Bound, read-only adapter for the observed OSRESV.TRC response.
 *
 * TRC is not JSON in the browser response.  It is a small JSON-ish
 * `pageData` envelope with a grid.  This module extracts only that envelope,
 * uses a bounded structural parser (never eval), and binds the result to the
 * already-correlated HDR/LST parent supplied by the caller.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  buildBoundNotesTracesReadRule,
  NOTES_TRACES_READ_PATH,
} from './notes-traces-manifest.js';
import {
  HmsRuntimeError,
  type HmsPage,
  type HmsReadSession,
} from '../../../../../../apps/server-pilot/src/hms/runtime.js';
import type { ValidatedFolioDetailValues } from '../../../../../../apps/server-pilot/src/hms/folio-read-facade.js';

export { NOTES_TRACES_READ_PATH };

export const NOTES_TRACES_MAX_BYTES = 32 * 1024;
export const NOTES_TRACES_MAX_ROWS = 50;
export const NOTES_TRACES_MAX_SOURCE_ROWS = 256;
export const NOTES_TRACES_MAX_TEXT_CHARS = 2_000;

/** Exact TRC grid identity observed in the approved network-11/19 captures. */
export const NOTES_TRACES_EXPECTED_DATASPY_ID = '1777';
export const NOTES_TRACES_EXPECTED_GRID_ID = '1662';
export const NOTES_TRACES_EXPECTED_GRID_NAME = 'OSGSTR';
const NOTES_TRACES_EXPECTED_GRID_TYPE = 'LIST.HEAD_DATA.STORED';

/** Names observed in network-11 OSRESV.TRC grid metadata. */
export const OBSERVED_TRACES_FIELD_NAMES = [
  'aliasname',
  'created',
  'createdby',
  'definedtrace',
  'department',
  'description',
  'fromdeliverydate_sort',
  'guestname_filter',
  'offsetfrom',
  'reservationstayid',
  'tracedeliveryoptions',
  'tracestatus',
  'updated',
  'updatedby',
  'traceid',
  'tracedeliverymethod',
  'selectcheck',
  'guestname',
  'topic',
  'tracedetails',
  'duedate',
  'tracestatus_display',
  'users',
  'emailaddress',
  'department_display',
  'tracedeliverymethod_display',
  'tracedeliveryoptions_display',
  'fromdeliverydate',
  'todeliverydate',
  'offsetfrom_display',
  'days',
  'completed',
  'cancelled',
  'duringcheckinprocess',
  'duringcheckoutprocess',
  'atrecordviewonlystatusreserved',
  'atrecordviewonlystatusinhouse',
  'atrecordviewallstatus',
] as const;

export type NotesTracesParentBinding = {
  propertyCode: 'HRCEN';
  confirmationNumber: string;
  reservationStayId: string;
  resourceRef?: string;
};

export type NotesTracesSourceItem = {
  traceId: string;
  reservationStayId: string;
  traceDetails: string | null;
  topic: string | null;
  description: string | null;
  created: string | null;
  dueDate: string | null;
  updated: string | null;
  deliveryMethod: string | null;
  statusCode: string | null;
  statusDisplay: string | null;
  /** Deliberately null: no state-code mapping is proven by the empty capture. */
  status: null;
  completed: boolean | null;
  cancelled: boolean | null;
  createdBy: string | null;
  users: string | null;
};

export type NotesTracesPage = {
  returnedCount: number;
  hasMore: boolean | null;
  nextCursor: null;
};

export type NotesTracesReadIssue = {
  code: 'TRUNCATED' | 'EMPTY_SOURCE' | 'METADATA_INCONSISTENT' | 'PAGING_UNSUPPORTED';
  count: number;
};

export type NotesTracesSourceMetadata = {
  records: number;
  clientRows: number;
  currentCursorPosition: number;
  hasMore: boolean;
  dataspyId: string;
  gridId: string;
  gridName: string;
};

export type NotesTracesReadResult = {
  parentBinding: NotesTracesParentBinding;
  sourceHash: string;
  /** Stable digest of validated TRC rows/field schema for cursor binding. */
  cursorHash: string;
  sourceCount: number;
  /** Source-declared count; sourceCount remains the parsed DATA row count. */
  declaredSourceCount: number;
  sourceMetadata: NotesTracesSourceMetadata;
  items: NotesTracesSourceItem[];
  /** All validated rows before the public page slice. */
  allItems: NotesTracesSourceItem[];
  completeness: 'complete' | 'partial';
  sourceCompleteness: 'complete' | 'partial';
  sourceIssues: NotesTracesReadIssue[];
  page: NotesTracesPage;
  issues: NotesTracesReadIssue[];
};

export type NotesTracesReadInput = {
  parentBinding: NotesTracesParentBinding;
  detailValues: ValidatedFolioDetailValues;
  limit?: number;
};

const parentBindingSchema = z
  .object({
    propertyCode: z.literal('HRCEN'),
    confirmationNumber: z.string().min(1).max(64),
    reservationStayId: z.string().min(1).max(64),
    resourceRef: z.string().min(1).max(256).optional(),
  })
  .strict();

export class NotesTracesParseError extends Error {
  readonly code:
    | 'MALFORMED_RESPONSE'
    | 'OVERSIZED_BODY'
    | 'INVALID_RESPONSE'
    | 'PARENT_MISMATCH'
    | 'DUPLICATE_TRACE_ID';

  constructor(
    code: NotesTracesParseError['code'],
    message = 'OSRESV.TRC response rejected',
  ) {
    super(`${code}: ${message}`);
    this.name = 'NotesTracesParseError';
    this.code = code;
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return NOTES_TRACES_MAX_ROWS;
  if (!Number.isInteger(limit) || limit < 1 || limit > NOTES_TRACES_MAX_ROWS) {
    throw new NotesTracesParseError('INVALID_RESPONSE', 'invalid page limit');
  }
  return limit;
}

function objectLike(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function keyFor(value: Record<string, unknown>, key: string): string | null {
  const lower = key.toLowerCase();
  const matches = Object.keys(value).filter((candidate) => candidate.toLowerCase() === lower);
  return matches.length === 1 ? matches[0]! : null;
}

function member(value: Record<string, unknown>, key: string): unknown {
  const actual = keyFor(value, key);
  return actual === null ? undefined : value[actual];
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true;
  if (normalized === 'false' || normalized === 'no' || normalized === '0') return false;
  return null;
}

function stableSourceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSourceValue);
  const object = objectLike(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableSourceValue(child)]),
  );
}

function sourceHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableSourceValue(value)), 'utf8')
    .digest('hex');
}

function tracesCursorHash(
  rows: NotesTracesSourceItem[],
  fieldNames: string[] = [...OBSERVED_TRACES_FIELD_NAMES],
): string {
  return sourceHash({ fields: [...fieldNames].sort(), rows });
}

function metadataFieldNames(envelope: Record<string, unknown>): string[] {
  const grid = objectLike(member(envelope, 'grid'));
  const result = grid ? objectLike(member(grid, 'GRIDRESULT')) : null;
  const gridValue = result ? objectLike(member(result, 'GRID')) : null;
  const fieldsContainer = gridValue ? objectLike(member(gridValue, 'FIELDS')) : null;
  const fields = fieldsContainer ? member(fieldsContainer, 'FIELD') : null;
  if (!Array.isArray(fields)) return [...OBSERVED_TRACES_FIELD_NAMES];
  const names = fields
    .map((field) => {
      const object = objectLike(field);
      return object ? scalar(member(object, 'name')) : null;
    })
    .filter((name): name is string => name !== null);
  return names.length > 0 ? names : [...OBSERVED_TRACES_FIELD_NAMES];
}

/** Find a balanced object while respecting quoted strings and escaped bytes. */
function balancedObject(input: string, start: number): string | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

/** Apply only the observed, bounded JSON-ish repairs. */
function normalizeEnvelope(input: string): string {
  return input
    .replace(/\\-/g, '-')
    .replace(/([,{]\s*)([A-Za-z_$][\w$]*):/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
}

function parseEnvelope(input: string): Record<string, unknown> {
  try {
    const direct = JSON.parse(input) as unknown;
    const object = objectLike(direct);
    if (object) {
      const pageData = objectLike(member(object, 'pageData'));
      if (pageData) return pageData;
      return object;
    }
  } catch {
    // The live response is JSON-ish; use the bounded pageData extractor below.
  }

  const marker = /(?:["']pageData["']|\bpageData\b)\s*:/gi.exec(input);
  if (!marker) throw new NotesTracesParseError('MALFORMED_RESPONSE', 'pageData marker missing');
  const start = input.indexOf('{', marker.index + marker[0].length);
  if (start < 0) throw new NotesTracesParseError('MALFORMED_RESPONSE', 'pageData object missing');
  const extracted = balancedObject(input, start);
  if (extracted === null) {
    throw new NotesTracesParseError('MALFORMED_RESPONSE', 'unbalanced pageData object');
  }
  try {
    const parsed = JSON.parse(normalizeEnvelope(extracted)) as unknown;
    const object = objectLike(parsed);
    if (!object) throw new Error('not object');
    return object;
  } catch {
    throw new NotesTracesParseError('MALFORMED_RESPONSE', 'pageData JSON-ish envelope invalid');
  }
}

function parentFromValues(
  envelope: Record<string, unknown>,
  expected: NotesTracesParentBinding,
): void {
  const values = objectLike(member(envelope, 'values'));
  if (!values) throw new NotesTracesParseError('PARENT_MISMATCH', 'response values missing');
  const property = scalar(member(values, 'propertycode'));
  const confirmation = scalar(member(values, 'confirmationnumber'));
  const stay = scalar(member(values, 'reservationstayid'));
  if (
    property !== expected.propertyCode ||
    confirmation === null ||
    confirmation.toUpperCase() !== expected.confirmationNumber.toUpperCase() ||
    stay !== expected.reservationStayId
  ) {
    throw new NotesTracesParseError('PARENT_MISMATCH', 'response parent does not match bound stay');
  }
}

function traceGrid(envelope: Record<string, unknown>): {
  gridResult: Record<string, unknown>;
  grid: Record<string, unknown>;
  metadata: Record<string, unknown>;
  dataspy: Record<string, unknown>;
  rows: Record<string, unknown>[];
} {
  const gridResult = objectLike(member(envelope, 'grid'));
  const result = gridResult ? objectLike(member(gridResult, 'GRIDRESULT')) : null;
  const grid = result ? objectLike(member(result, 'GRID')) : null;
  const metadata = grid ? objectLike(member(grid, 'METADATA')) : null;
  const dataspy = result ? objectLike(member(result, 'DATASPY')) : null;
  const data = grid ? member(grid, 'DATA') : undefined;
  if (!result || !grid || !metadata || !dataspy || !Array.isArray(data) || data.some((row) => objectLike(row) === null)) {
    throw new NotesTracesParseError('INVALID_RESPONSE', 'TRC grid DATA is not an object array');
  }
  return {
    gridResult: result,
    grid,
    metadata,
    dataspy,
    rows: data as Record<string, unknown>[],
  };
}

function boundedMetadataCount(value: unknown): number | null {
  const text = scalar(value);
  if (text === null || !/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function metadataText(record: Record<string, unknown>, key: string): string | null {
  return scalar(member(record, key));
}

function readTraceMetadata(
  grid: ReturnType<typeof traceGrid>,
  parsedRowCount: number,
): {
  metadata: NotesTracesSourceMetadata;
  sourceIssues: NotesTracesReadIssue[];
  sourceComplete: boolean;
} {
  const type = metadataText(grid.gridResult, 'type');
  const requestType = metadataText(grid.metadata, 'REQUEST_TYPE_META');
  const dataspyId = metadataText(grid.dataspy, 'id');
  const metadataDataspyId = metadataText(grid.metadata, 'DATASPYID');
  const gridId = metadataText(grid.metadata, 'GRIDID');
  const gridName = metadataText(grid.metadata, 'GRIDNAME');
  if (
    type !== NOTES_TRACES_EXPECTED_GRID_TYPE ||
    requestType !== NOTES_TRACES_EXPECTED_GRID_TYPE ||
    dataspyId !== NOTES_TRACES_EXPECTED_DATASPY_ID ||
    metadataDataspyId !== NOTES_TRACES_EXPECTED_DATASPY_ID ||
    gridId !== NOTES_TRACES_EXPECTED_GRID_ID ||
    gridName !== NOTES_TRACES_EXPECTED_GRID_NAME
  ) {
    throw new NotesTracesParseError('INVALID_RESPONSE', 'TRC grid identity is not the reviewed source');
  }

  const records = boundedMetadataCount(member(grid.metadata, 'RECORDS'));
  const clientRows = boundedMetadataCount(member(grid.metadata, 'CLIENTROWS'));
  const currentCursorPosition = boundedMetadataCount(
    member(grid.metadata, 'CURRENTCURSORPOSITION'),
  );
  const more = metadataText(grid.metadata, 'MORERECORDPRESENT');
  const hasMore = more === '-' ? false : more === '+' ? true : null;
  if (records === null || clientRows === null || currentCursorPosition === null || hasMore === null) {
    throw new NotesTracesParseError('INVALID_RESPONSE', 'TRC paging metadata is missing or invalid');
  }
  if (
    records > NOTES_TRACES_MAX_SOURCE_ROWS ||
    clientRows > NOTES_TRACES_MAX_ROWS ||
    currentCursorPosition > NOTES_TRACES_MAX_SOURCE_ROWS
  ) {
    throw new NotesTracesParseError('INVALID_RESPONSE', 'TRC paging metadata exceeds bounds');
  }

  const metadata: NotesTracesSourceMetadata = {
    records,
    clientRows,
    currentCursorPosition,
    hasMore,
    dataspyId,
    gridId,
    gridName,
  };
  const sourceIssues: NotesTracesReadIssue[] = [];
  if (
    records !== parsedRowCount ||
    clientRows < parsedRowCount ||
    currentCursorPosition !== parsedRowCount
  ) {
    sourceIssues.push({ code: 'METADATA_INCONSISTENT', count: 1 });
  }
  // The TRC server continuation is not proven. Preserve parsed rows, but do
  // not expose '+' as a resumable public cursor or call the source complete.
  if (hasMore) sourceIssues.push({ code: 'PAGING_UNSUPPORTED', count: 1 });
  const sourceComplete = sourceIssues.length === 0;
  return { metadata, sourceIssues, sourceComplete };
}

function parseRow(row: Record<string, unknown>, expectedStay: string): NotesTracesSourceItem {
  const traceId = scalar(member(row, 'traceid'));
  const rowReservationStayId = scalar(member(row, 'reservationstayid'));
  // The observed non-empty TRC grid omits reservationstayid from each row;
  // pageData.values already proves the request-bound stay.  Preserve that
  // binding only for an absent row field, while still rejecting a conflicting
  // row value if a future response includes one.
  const rowStayPresent = member(row, 'reservationstayid') !== undefined;
  if (
    !traceId ||
    (rowStayPresent &&
      (rowReservationStayId === null || rowReservationStayId !== expectedStay))
  ) {
    throw new NotesTracesParseError('PARENT_MISMATCH', 'trace row stay binding mismatch');
  }
  const reservationStayId = rowStayPresent ? rowReservationStayId! : expectedStay;
  return {
    traceId,
    reservationStayId,
    traceDetails: scalar(member(row, 'tracedetails')),
    topic: scalar(member(row, 'topic')),
    description: scalar(member(row, 'description')),
    created: scalar(member(row, 'created')),
    dueDate: scalar(member(row, 'duedate')),
    updated: scalar(member(row, 'updated')),
    deliveryMethod: scalar(member(row, 'tracedeliverymethod')),
    statusCode: scalar(member(row, 'tracestatus')),
    statusDisplay: scalar(member(row, 'tracestatus_display')),
    status: null,
    completed: booleanValue(member(row, 'completed')),
    cancelled: booleanValue(member(row, 'cancelled')),
    createdBy: scalar(member(row, 'createdby')),
    users: scalar(member(row, 'users')),
  };
}

/** Parse one already-correlated OSRESV.TRC response. */
export function parseNotesTracesResponse(
  input: string,
  options: { parentBinding: NotesTracesParentBinding; limit?: number },
): NotesTracesReadResult {
  if (typeof input !== 'string') {
    throw new NotesTracesParseError('INVALID_RESPONSE', 'response body must be text');
  }
  if (Buffer.byteLength(input, 'utf8') > NOTES_TRACES_MAX_BYTES) {
    throw new NotesTracesParseError('OVERSIZED_BODY');
  }
  const parent = parentBindingSchema.parse(options.parentBinding);
  const limit = boundedLimit(options.limit);
  const envelope = parseEnvelope(input);
  parentFromValues(envelope, parent);
  const grid = traceGrid(envelope);
  const rows = grid.rows;
  if (rows.length > NOTES_TRACES_MAX_SOURCE_ROWS) {
    throw new NotesTracesParseError('INVALID_RESPONSE', 'TRC source row bound exceeded');
  }
  const seen = new Set<string>();
  const parsedRows = rows.map((row) => {
    const parsed = parseRow(row, parent.reservationStayId);
    if (seen.has(parsed.traceId)) {
      throw new NotesTracesParseError('DUPLICATE_TRACE_ID', 'duplicate trace id');
    }
    seen.add(parsed.traceId);
    return parsed;
  });
  const metadataResult = readTraceMetadata(grid, parsedRows.length);
  const items = parsedRows.slice(0, limit);
  const pageCut = items.length < parsedRows.length;
  const pageIssues: NotesTracesReadIssue[] = pageCut
    ? [{ code: 'TRUNCATED', count: parsedRows.length - items.length }]
    : [];
  return {
    parentBinding: parent,
    sourceHash: sourceHash(envelope),
    cursorHash: tracesCursorHash(parsedRows, metadataFieldNames(envelope)),
    sourceCount: parsedRows.length,
    declaredSourceCount: metadataResult.metadata.records,
    sourceMetadata: metadataResult.metadata,
    items,
    allItems: parsedRows,
    completeness: metadataResult.sourceComplete ? 'complete' : 'partial',
    sourceCompleteness: metadataResult.sourceComplete ? 'complete' : 'partial',
    sourceIssues: metadataResult.sourceIssues,
    page: {
      returnedCount: items.length,
      // No server cursor has been proven for TRC.  A cut page is therefore
      // explicitly non-resumable rather than pretending a cursor exists.
      hasMore: pageCut || !metadataResult.sourceComplete ? null : false,
      nextCursor: null,
    },
    issues: [...metadataResult.sourceIssues, ...pageIssues],
  };
}

export interface NotesTracesReadFacade {
  read(input: NotesTracesReadInput): Promise<NotesTracesReadResult>;
}

/** POST only the exact detail-bound form; no fallback, retry, or URL input. */
export function createNotesTracesReadFacade(
  session: Pick<HmsReadSession, 'origin' | 'page'>,
): NotesTracesReadFacade {
  const page: HmsPage = session.page;
  return {
    async read(input) {
      const parent = parentBindingSchema.parse(input.parentBinding);
      const rule = buildBoundNotesTracesReadRule({
        origin: session.origin,
        confirmationNumber: parent.confirmationNumber,
        reservationStayId: parent.reservationStayId,
        detailValues: input.detailValues,
      });
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(rule.fixedBody)) {
        if (typeof value !== 'string') {
          throw new HmsRuntimeError('SCHEMA_DRIFT', `TRC fixed field is not scalar: ${key}`);
        }
        fields[key] = value;
      }
      const body = await page.postForm(
        `${session.origin}${NOTES_TRACES_READ_PATH}`,
        fields,
        { maxBytes: NOTES_TRACES_MAX_BYTES, timeoutMs: 5_000 },
      );
      return parseNotesTracesResponse(body, {
        parentBinding: parent,
        limit: input.limit,
      });
    },
  };
}

/** Convert parser failures into the runtime's stable schema-drift boundary. */
export function isNotesTracesScopeError(error: unknown): boolean {
  return error instanceof NotesTracesParseError && error.code === 'PARENT_MISMATCH';
}

export function notesTracesRuntimeError(error: NotesTracesParseError): HmsRuntimeError {
  return new HmsRuntimeError(
    error.code === 'PARENT_MISMATCH' ? 'SCOPE_DENIED' : 'SCHEMA_DRIFT',
    error.message,
  );
}
