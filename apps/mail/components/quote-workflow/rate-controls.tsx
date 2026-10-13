import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Field, SecondaryButton, paneFieldClass, paneTextareaClass } from '@/components/nava-pane/pane-ui';
import { draftMoney } from '@/lib/quote-workflow/multi-option-draft';
import { trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import { EXTRA_AMOUNT_FORMAT_MESSAGE, parseZarInput } from '@/lib/quote-workflow/zar-input';
import type { RowPriceChoice, StaffRowRate, StayGroupRequirement } from '@/lib/quote-workflow/types';

import { copyText } from './hms-link-actions';
import { CRICKET_RATE_HINT } from './rate-cards';

/** A saved rate for this transport. Amounts are ZAR minor units (cents). */
export type SavedRate = { id: string; name: string; amountMinor: number; currency?: string };

/** The saved-rate routes the pane calls: rates.list, create, update and archive. */
export type SavedRatesClient = {
  list: () => Promise<SavedRate[]>;
  create: (input: { name: string; amountMinor: number }) => Promise<SavedRate>;
  update: (input: { id: string; name: string; amountMinor: number }) => Promise<SavedRate>;
  archive: (id: string) => Promise<void>;
};

type RatesTrpc = {
  rates?: {
    list?: { query: () => Promise<SavedRate[]> };
    create?: { mutate: (input: { name: string; amountMinor: number }) => Promise<SavedRate> };
    update?: { mutate: (input: { id: string; name: string; amountMinor: number }) => Promise<SavedRate> };
    archive?: { mutate: (input: { id: string }) => Promise<{ id: string }> };
  };
};

/**
 * The saved-rate routes bound off the tRPC client. Null when the client has none, so the picker is left out. The real
 * client always has them; a client without them shows the one-off and override controls only.
 */
export function savedRatesFromTrpc(trpc: unknown): SavedRatesClient | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const rates = (trpc as RatesTrpc).rates;
  const list = rates?.list;
  const create = rates?.create;
  const update = rates?.update;
  const archive = rates?.archive;
  if (!list || !create || !update || !archive) return null;
  return {
    list: () => list.query(),
    create: (input) => create.mutate(input),
    update: (input) => update.mutate(input),
    archive: async (id) => {
      await archive.mutate({ id });
    },
  };
}

export type SavedRatesState = {
  /** unavailable: there is no client, so no picker. failed: the list did not load. */
  status: 'unavailable' | 'loading' | 'ready' | 'failed';
  rates: SavedRate[];
  reload: () => Promise<void>;
  create: (input: { name: string; amountMinor: number }) => Promise<SavedRate>;
  update: (input: { id: string; name: string; amountMinor: number }) => Promise<SavedRate>;
  archive: (id: string) => Promise<void>;
};

/**
 * The saved rates for the pane. Reloaded after each change, so every row's picker shows the same list. Saved rates
 * belong to a mailbox: when `scope` (the mailbox) changes the list is cleared and read again, and a list that was asked
 * for under the old mailbox is dropped.
 */
export function useSavedRates(client: SavedRatesClient | null, scope: string | null = null): SavedRatesState {
  const [rates, setRates] = useState<SavedRate[]>([]);
  const [status, setStatus] = useState<SavedRatesState['status']>(client ? 'loading' : 'unavailable');
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const reload = useCallback(async () => {
    if (!client) return;
    const askedIn = scopeRef.current;
    try {
      const list = await client.list();
      if (scopeRef.current !== askedIn) return;
      setRates(list);
      setStatus('ready');
    } catch {
      if (scopeRef.current === askedIn) setStatus('failed');
    }
  }, [client]);
  useEffect(() => {
    setRates([]);
    if (client) setStatus('loading');
    void reload();
  }, [reload, client, scope]);
  const writer = (): SavedRatesClient => {
    if (!client) throw new Error('Saved rates are not available here.');
    return client;
  };
  return {
    status,
    rates,
    reload,
    create: async (input) => {
      const row = await writer().create(input);
      await reload();
      return row;
    },
    update: async (input) => {
      const row = await writer().update(input);
      await reload();
      return row;
    },
    archive: async (id) => {
      await writer().archive(id);
      await reload();
    },
  };
}

/** The price a row takes from a saved rate. The name and amount are copied, as the server copies them on a run. */
export function savedPrice(rate: SavedRate): RowPriceChoice {
  return { source: 'saved', customRateId: rate.id, name: rate.name, amountMinor: rate.amountMinor };
}

/** The HMS rate codes staff override with. "Other" takes a typed code. */
export const OVERRIDE_RATE_CODES = ['NCOR1B', 'NCOR2B', 'BAR', 'GNC3B', 'GNC4B'] as const;
const OTHER_CODE = 'OTHER';
const RATE_CODE_SHAPE = /^[A-Z0-9_-]{1,16}$/;
const NOTE_MAX = 500;
const RATE_NAME_MAX = 120;
const EVENT_RATE_CODES: ReadonlySet<string> = new Set(['GNC3B', 'GNC4B']);
const CONFLICT_COPY = 'That name is already a saved rate. Use another name.';

export type OverrideDraft = { code: string; otherCode: string; rate: string; note: string };
export type Reading<T> = ({ status: 'ok' } & T) | { status: 'incomplete'; message: string };

/** An amount typed as rand, read into cents. Says what is missing or wrong, and nothing is saved until it reads. */
function amountReading<T extends object>(raw: string, empty: string, pick: (amountMinor: number) => T): Reading<T> {
  const result = parseZarInput(raw);
  if (result.status === 'ok') return { status: 'ok', ...pick(result.minor) };
  if (result.status === 'empty') return { status: 'incomplete', message: empty };
  if (result.status === 'partial') return { status: 'incomplete', message: EXTRA_AMOUNT_FORMAT_MESSAGE };
  return { status: 'incomplete', message: result.message };
}

/**
 * The override a draft makes, or the first reason it cannot be saved. An override needs a rate code, a rate per night and
 * a note saying who approved it and why (AE4). The note is staff-only: it never reaches the client documents.
 */
export function readOverride(draft: OverrideDraft): Reading<{ rateCode: string; amountMinor: number; note: string }> {
  const rateCode = (draft.code === OTHER_CODE ? draft.otherCode : draft.code).trim().toUpperCase();
  if (!rateCode) {
    return {
      status: 'incomplete',
      message: draft.code === OTHER_CODE ? 'Type the HMS rate code.' : 'Choose the HMS rate code.',
    };
  }
  if (!RATE_CODE_SHAPE.test(rateCode)) {
    return { status: 'incomplete', message: 'A rate code is up to 16 letters, numbers, dashes or underscores.' };
  }
  const rate = amountReading(draft.rate, 'Enter the override rate per night.', (amountMinor) => ({ amountMinor }));
  if (rate.status !== 'ok') return rate;
  const note = draft.note.trim();
  if (!note) return { status: 'incomplete', message: 'Say who approved it and why.' };
  if (note.length > NOTE_MAX) return { status: 'incomplete', message: `Keep the note to ${NOTE_MAX} characters.` };
  return { status: 'ok', rateCode, amountMinor: rate.amountMinor, note };
}

/** A typed one-off rate per night. */
export function readOneOff(raw: string): Reading<{ amountMinor: number }> {
  return amountReading(raw, 'Enter the rate per night.', (amountMinor) => ({ amountMinor }));
}

/** A saved rate's name and per-night amount, as typed in the manager. */
export function readSavedRateDraft(name: string, amount: string): Reading<{ name: string; amountMinor: number }> {
  const trimmed = name.trim();
  if (!trimmed) return { status: 'incomplete', message: 'Enter a name for the saved rate.' };
  if (trimmed.length > RATE_NAME_MAX) {
    return { status: 'incomplete', message: `Keep the name to ${RATE_NAME_MAX} characters.` };
  }
  return amountReading(amount, 'Enter the rate per night.', (amountMinor) => ({ name: trimmed, amountMinor }));
}

/** One line on what the row is charged. The HMS rate is shown too when the row is not on it. */
export function priceSummary(price: RowPriceChoice | undefined, rowRate: StaffRowRate | undefined): string {
  const hmsFirst = rowRate?.hmsNightlyMinor[0];
  if (!price) {
    return hmsFirst !== undefined ? `HMS rate, ${draftMoney(hmsFirst)} a night` : 'HMS rate';
  }
  const hmsNote = rowRate && rowRate.source !== 'hms' && hmsFirst !== undefined ? ` (HMS ${draftMoney(hmsFirst)})` : '';
  if (price.source === 'saved') {
    // The run copies the saved rate's name and amount, so its row rate is what was charged.
    const ran = rowRate?.source === 'saved';
    const name = (ran ? rowRate.customRateName : undefined) ?? price.name;
    const amount = (ran ? rowRate.nightlyMinor[0] : undefined) ?? price.amountMinor;
    return `${name}, saved rate, ${draftMoney(amount)} a night${hmsNote}`;
  }
  if (price.source === 'one_off') return `Typed rate, ${draftMoney(price.amountMinor)} a night${hmsNote}`;
  return `${price.rateCode} override, ${draftMoney(price.amountMinor)} a night${hmsNote}`;
}

/** The stay a room's nights belong to. Its arrival date is the first night. */
export type HmsNotesStay = { arrival: string; departure: string };

/** One room for the HMS notes. Each field is optional: a field with no value adds no line. */
export type HmsNotesRoom = {
  /** The room's type and count in the pane, e.g. "Standard Twin ×2". It heads the room's lines when there are several rooms. */
  label: string;
  specialRequests?: string[];
  /** Who approved the discount and why, as staff typed it on the row's override. */
  authorisedBy?: string | null;
  rate?: {
    code?: string | null;
    label?: string | null;
    /** The amount for each night, in minor units. One amount is the rate for every night. */
    nightlyMinor?: number[];
    stay?: HmsNotesStay | null;
    board?: string | null;
  };
};

export type HmsNotesInput = {
  booker?: string | null;
  company?: string | null;
  confirmations?: string[];
  rooms: HmsNotesRoom[];
};

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function noteText(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

/** An amount in minor units as the HMS comment writes it, e.g. "R1850.00". */
function randText(minor: number): string {
  return `R${(minor / 100).toFixed(2)}`;
}

/**
 * The price for the HMS notes. Nights at one amount read "R x per night". Nights that differ are listed one by one with
 * their dates when the stay has one date per night; otherwise they read as a range with the total.
 */
function hmsPriceText(nightly: number[], stay: HmsNotesStay | null | undefined): string {
  const [first] = nightly;
  if (first === undefined) return '';
  if (nightly.every((amount) => amount === first)) return `${randText(first)} per night`;
  const start = Date.parse(`${stay?.arrival ?? ''}T00:00:00Z`);
  const end = Date.parse(`${stay?.departure ?? ''}T00:00:00Z`);
  if (Number.isFinite(start) && Math.round((end - start) / DAY_MS) === nightly.length) {
    const nights = nightly.map((amount, index) => {
      const night = new Date(start + index * DAY_MS);
      return `${night.getUTCDate()} ${MONTHS[night.getUTCMonth()]} ${randText(amount)}`;
    });
    return `per night: ${nights.join('; ')}`;
  }
  const total = nightly.reduce((sum, amount) => sum + amount, 0);
  return `from ${randText(Math.min(...nightly))} to ${randText(Math.max(...nightly))} per night, total ${randText(total)}`;
}

/** The rate for the HMS notes, e.g. "NCOR1B R1850.00 per night, Bed & breakfast". */
function hmsRateLine(rate: HmsNotesRoom['rate']): string {
  const names = [noteText(rate?.code), noteText(rate?.label)].filter(
    (name, index, all) => name !== '' && all.indexOf(name) === index,
  );
  const price = hmsPriceText(rate?.nightlyMinor ?? [], rate?.stay);
  return [[...names, price].filter(Boolean).join(' '), noteText(rate?.board)].filter(Boolean).join(', ');
}

/**
 * The one block staff paste into the HMS reservation comments. The booker, company and confirmation numbers come once.
 * Each room gives its special requests, its discount approval and its rate. With several rooms, each room's lines sit
 * under its label. A line with no value is left out, so an empty input gives ''.
 */
export function hmsNotesBlock(input: HmsNotesInput): string {
  const lines: string[] = [];
  const booker = noteText(input.booker);
  const company = noteText(input.company);
  if (booker) lines.push(`Booker: ${booker}`);
  if (company) lines.push(`Company: ${company}`);
  const several = input.rooms.length > 1;
  for (const room of input.rooms) {
    const own: string[] = [];
    const requests = (room.specialRequests ?? []).map(noteText).filter(Boolean);
    if (requests.length) own.push(`Special requests: ${requests.join('; ')}`);
    const authorised = noteText(room.authorisedBy);
    if (authorised) own.push(`Discount authorised by: ${authorised}`);
    const rate = hmsRateLine(room.rate);
    if (rate) own.push(`Rate: ${rate}`);
    if (!own.length) continue;
    if (several) lines.push(room.label, ...own.map((line) => `  ${line}`));
    else lines.push(...own);
  }
  const confirmations = (input.confirmations ?? []).map(noteText).filter(Boolean);
  if (confirmations.length) lines.push(`Confirmation: ${confirmations.join(', ')}`);
  return lines.join('\n');
}

const CHIP_TONES = {
  hms: 'bg-[#f1f5f9] text-[#475569]',
  saved: 'bg-[#eaf4ee] text-[#1a4332]',
  one_off: 'bg-[#eff6ff] text-[#0066cc]',
  override: 'bg-[#fffbeb] text-[#92400e]',
} as const;

function chipFor(price: RowPriceChoice | undefined): { tone: keyof typeof CHIP_TONES; text: string } {
  if (!price) return { tone: 'hms', text: 'HMS rate' };
  if (price.source === 'saved') return { tone: 'saved', text: 'Saved' };
  if (price.source === 'one_off') return { tone: 'one_off', text: 'One-off' };
  return { tone: 'override', text: 'Override' };
}

const linkClass =
  'rounded-[3px] text-left text-[13px] font-semibold text-[#0066cc] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc] disabled:cursor-not-allowed disabled:text-[#94a3b8] disabled:no-underline';
const outlineButtonClass =
  'flex h-7 items-center rounded-[3px] border border-[#0066cc] bg-white px-2.5 text-[13px] font-semibold text-[#0066cc] transition-colors hover:bg-[#eff6ff] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc] disabled:cursor-not-allowed disabled:border-[#cbd5e1] disabled:text-[#94a3b8]';

/** A name clash comes back from the server as CONFLICT. Anything else keeps the fallback copy. */
function saveError(err: unknown, fallback: string): string {
  const code = typeof err === 'object' && err !== null ? (err as { data?: { code?: unknown } }).data?.code : undefined;
  return code === 'CONFLICT' ? CONFLICT_COPY : fallback;
}

/**
 * Copies the HMS notes block (hmsNotesBlock) for staff to paste into HMS. Renders nothing for an empty block. When the copy
 * fails, the block shows in a read-only box, selected on focus, so staff can copy it by hand.
 */
export function CopyHmsNotesButton({ block }: { block: string }) {
  const [copyFailed, setCopyFailed] = useState(false);
  if (!block) return null;
  const copy = async () => {
    if (await copyText(block)) {
      setCopyFailed(false);
      trackPaneAction({ type: 'copy.hms_line', block: 'notes' });
      toast.success('HMS notes copied. Paste them into the HMS comments.');
    } else {
      setCopyFailed(true);
      toast.error("Couldn't copy. Select the notes text and copy it.");
    }
  };
  return (
    <>
      <button type="button" className={outlineButtonClass} onClick={() => void copy()}>
        Copy for HMS notes
      </button>
      {copyFailed ? (
        <textarea
          aria-label="HMS notes"
          className={paneTextareaClass}
          readOnly
          rows={block.split('\n').length}
          value={block}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
    </>
  );
}

/**
 * One room row's price: what it is charged, and the three ways to change it. A saved rate from the list, a typed one-off
 * rate, or a discount override. Each change goes to the parent, which reprices the row on a new run. The controls sit
 * behind "Change price", so a row that keeps HMS's rate stays compact.
 */
export function RowRateControls({
  group,
  label,
  toggleLabel = 'Change price',
  rowRate,
  saved,
  pending,
  busy,
  blockReason = null,
  onSetPrice,
  onSavedRateChanged,
}: {
  group: StayGroupRequirement;
  /** Names the row for staff, e.g. "Standard Twin ×2" or "Stay 2 · Standard Twin ×2". */
  label: string;
  /** Rate cards surface the price control directly on the selected card. */
  toggleLabel?: string;
  /** This row's charged rate from the last run. */
  rowRate?: StaffRowRate;
  saved: SavedRatesState;
  /** This row's price is being re-run. */
  pending: boolean;
  /** A run is in flight. Every price control waits for it. */
  busy: boolean;
  /** Why this row cannot take a new price yet, e.g. no room type. Null when it can. */
  blockReason?: string | null;
  /** Sets the row's price. Undefined returns the row to HMS's rate. */
  onSetPrice: (price: RowPriceChoice | undefined) => void;
  /** A saved rate was edited (next) or archived (null). Rows priced from it follow. */
  onSavedRateChanged: (id: string, next: SavedRate | null) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<'one_off' | 'override' | null>(null);
  const oneOffToggle = useRef<HTMLButtonElement>(null);
  const overrideToggle = useRef<HTMLButtonElement>(null);
  const price = group.rowPrice;
  const chip = chipFor(price);
  // A new price re-runs the stay, so it waits for a run in flight and for a row that can run.
  const priceOff = busy || blockReason !== null;

  const copyComment = async () => {
    const comment = rowRate?.hmsComment;
    if (!comment) return;
    if (await copyText(comment)) {
      trackPaneAction({ type: 'copy.hms_line', kind: 'comment' });
      toast.success('HMS comment copied. Paste it into HMS.');
    } else toast.error("Couldn't copy. Select the HMS comment text and copy it.");
  };

  const finishForm = (which: 'one_off' | 'override', next?: RowPriceChoice) => {
    if (next) onSetPrice(next);
    setForm(null);
    (which === 'one_off' ? oneOffToggle : overrideToggle).current?.focus();
  };

  return (
    <section
      aria-label={`${label} price`}
      className="flex flex-col gap-2 rounded-[3px] border border-[#cbd5e1] bg-white p-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-bold text-[#1e293b]">
          {label}
          <span className={`rounded-[2px] px-1 py-px text-[10px] font-semibold ${CHIP_TONES[chip.tone]}`}>
            {chip.text}
          </span>
        </span>
        <button
          type="button"
          className={linkClass}
          aria-expanded={open}
          aria-controls={`${id}-controls`}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? 'Hide price options' : toggleLabel}
        </button>
      </div>
      <p className="text-[12.5px] text-[#475569]">{priceSummary(price, rowRate)}</p>
      {price?.source === 'override' ? (
        <p className="text-[12.5px] text-[#64748b]">{`Authorised by: ${price.note}`}</p>
      ) : null}
      {pending ? (
        <p role="status" className="text-[12.5px] font-semibold text-[#0066cc]">
          Updating the total from HMS…
        </p>
      ) : null}
      {rowRate?.hmsComment ? (
        <div className="flex flex-col gap-1">
          <p className="text-[12.5px] text-[#475569]">{`HMS comment: ${rowRate.hmsComment}`}</p>
          <div>
            <button type="button" className={outlineButtonClass} onClick={() => void copyComment()}>
              Copy for HMS comments
            </button>
          </div>
        </div>
      ) : null}
      {open ? (
        <div id={`${id}-controls`} className="flex flex-col gap-3 border-t border-[#e2e8f0] pt-2">
          {blockReason ? <p className="text-[12.5px] text-[#64748b]">{blockReason}</p> : null}
          {saved.status !== 'unavailable' ? (
            <SavedRatePicker
              label={label}
              price={price}
              saved={saved}
              priceOff={priceOff}
              busy={busy}
              onSetPrice={onSetPrice}
              onSavedRateChanged={onSavedRateChanged}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              ref={oneOffToggle}
              type="button"
              aria-expanded={form === 'one_off'}
              className={outlineButtonClass}
              disabled={priceOff}
              onClick={() => setForm(form === 'one_off' ? null : 'one_off')}
            >
              Type a rate
            </button>
            <button
              ref={overrideToggle}
              type="button"
              aria-expanded={form === 'override'}
              className={outlineButtonClass}
              disabled={priceOff}
              onClick={() => setForm(form === 'override' ? null : 'override')}
            >
              Discount / override
            </button>
          </div>
          {form === 'one_off' ? (
            <OneOffForm
              label={label}
              disabled={priceOff}
              onUse={(amountMinor) => finishForm('one_off', { source: 'one_off', amountMinor })}
              onCancel={() => finishForm('one_off')}
            />
          ) : null}
          {form === 'override' ? (
            <OverrideForm
              label={label}
              disabled={priceOff}
              onSave={(override) => finishForm('override', { source: 'override', ...override })}
              onCancel={() => finishForm('override')}
            />
          ) : null}
          {price ? (
            <div>
              <button type="button" className={linkClass} disabled={priceOff} onClick={() => onSetPrice(undefined)}>
                Use HMS rate
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SavedRatePicker({
  label,
  price,
  saved,
  priceOff,
  busy,
  onSetPrice,
  onSavedRateChanged,
}: {
  label: string;
  price: RowPriceChoice | undefined;
  saved: SavedRatesState;
  priceOff: boolean;
  busy: boolean;
  onSetPrice: (price: RowPriceChoice | undefined) => void;
  onSavedRateChanged: (id: string, next: SavedRate | null) => void;
}) {
  const id = useId();
  const [managing, setManaging] = useState(false);
  const selectedId = price?.source === 'saved' ? price.customRateId : '';
  const listed = saved.rates.some((rate) => rate.id === selectedId);
  return (
    <div className="flex flex-col gap-2">
      <Field label="Saved rate" htmlFor={`${id}-saved`}>
        <select
          id={`${id}-saved`}
          aria-label={`Saved rate for ${label}`}
          className={paneFieldClass}
          value={selectedId}
          disabled={priceOff || saved.status !== 'ready'}
          onChange={(event) => {
            const rate = saved.rates.find((candidate) => candidate.id === event.target.value);
            onSetPrice(rate ? savedPrice(rate) : undefined);
          }}
        >
          <option value="">HMS rate</option>
          {saved.rates.map((rate) => (
            <option key={rate.id} value={rate.id}>
              {`${rate.name} · ${draftMoney(rate.amountMinor)} a night`}
            </option>
          ))}
          {price?.source === 'saved' && !listed ? (
            <option value={price.customRateId}>{`${price.name} (no longer saved)`}</option>
          ) : null}
        </select>
        {saved.status === 'loading' ? <span className="text-[11px] text-[#64748b]">Loading saved rates…</span> : null}
        {saved.status === 'failed' ? (
          <span role="status" className="text-[11px] text-[#b45309]">
            Saved rates could not load.{' '}
            <button type="button" className={linkClass} onClick={() => void saved.reload()}>
              Try again
            </button>
          </span>
        ) : null}
      </Field>
      <div>
        <button
          type="button"
          className={linkClass}
          aria-expanded={managing}
          aria-controls={`${id}-manager`}
          onClick={() => setManaging((current) => !current)}
        >
          Manage saved rates
        </button>
      </div>
      {managing ? (
        <SavedRateManager
          id={`${id}-manager`}
          label={label}
          saved={saved}
          busy={busy}
          onSavedRateChanged={onSavedRateChanged}
        />
      ) : null}
    </div>
  );
}

/** Add, edit and delete saved rates inline. Delete archives the rate, so an old quote keeps the rate it used. */
function SavedRateManager({
  id,
  label,
  saved,
  busy,
  onSavedRateChanged,
}: {
  id: string;
  label: string;
  saved: SavedRatesState;
  busy: boolean;
  onSavedRateChanged: (id: string, next: SavedRate | null) => void;
}) {
  const fieldId = useId();
  const [editing, setEditing] = useState<{ id: string; name: string; amount: string } | null>(null);
  const [adding, setAdding] = useState({ name: '', amount: '' });
  const [error, setError] = useState<string | null>(null);
  // One saved-rate write at a time, so a second click never races the first.
  const [saving, setSaving] = useState(false);
  const disabled = busy || saving;

  const write = async (run: () => Promise<void>, fallback: string) => {
    setError(null);
    setSaving(true);
    try {
      await run();
    } catch (err) {
      setError(saveError(err, fallback));
    } finally {
      setSaving(false);
    }
  };

  const addRate = async () => {
    const draft = readSavedRateDraft(adding.name, adding.amount);
    if (draft.status !== 'ok') {
      setError(draft.message);
      return;
    }
    await write(async () => {
      await saved.create({ name: draft.name, amountMinor: draft.amountMinor });
      setAdding({ name: '', amount: '' });
    }, "Couldn't add this rate. Try again.");
  };

  const saveEdit = async () => {
    if (!editing) return;
    const draft = readSavedRateDraft(editing.name, editing.amount);
    if (draft.status !== 'ok') {
      setError(draft.message);
      return;
    }
    await write(async () => {
      const updated = await saved.update({ id: editing.id, name: draft.name, amountMinor: draft.amountMinor });
      setEditing(null);
      onSavedRateChanged(updated.id, updated);
    }, "Couldn't save this rate. Try again.");
  };

  const archive = (rate: SavedRate) =>
    write(async () => {
      await saved.archive(rate.id);
      onSavedRateChanged(rate.id, null);
    }, "Couldn't delete this rate. Try again.");

  return (
    <div id={id} className="flex flex-col gap-2 rounded-[3px] bg-[#f8fafc] p-2">
      {saved.rates.length ? (
        <ul aria-label={`Saved rates for ${label}`} className="flex flex-col gap-1.5">
          {saved.rates.map((rate) =>
            editing?.id === rate.id ? (
              <li key={rate.id} className="flex flex-wrap items-center gap-1.5">
                <input
                  aria-label="Saved rate name"
                  maxLength={RATE_NAME_MAX}
                  className={`${paneFieldClass} max-w-[9rem]`}
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                />
                <input
                  aria-label="Saved rate per night (R)"
                  inputMode="decimal"
                  className={`${paneFieldClass} max-w-[6rem]`}
                  value={editing.amount}
                  onChange={(event) => setEditing({ ...editing, amount: event.target.value })}
                />
                <SecondaryButton onClick={() => void saveEdit()} disabled={disabled}>
                  Save
                </SecondaryButton>
                <button type="button" className={linkClass} onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </li>
            ) : (
              <li key={rate.id} className="flex items-center justify-between gap-2 text-[11.5px] text-[#1e293b]">
                <span>{`${rate.name} · ${draftMoney(rate.amountMinor)} a night`}</span>
                <span className="flex shrink-0 items-center gap-3">
                  <button
                    type="button"
                    className={linkClass}
                    disabled={disabled}
                    aria-label={`Edit ${rate.name}`}
                    onClick={() =>
                      setEditing({ id: rate.id, name: rate.name, amount: (rate.amountMinor / 100).toFixed(2) })
                    }
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={linkClass}
                    disabled={disabled}
                    aria-label={`Delete ${rate.name}`}
                    onClick={() => void archive(rate)}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="text-[11px] text-[#64748b]">No saved rates yet.</p>
      )}
      <div className="flex flex-wrap items-end gap-1.5">
        <Field label="New saved rate" htmlFor={`${fieldId}-name`}>
          <input
            id={`${fieldId}-name`}
            aria-label="New saved rate name"
            maxLength={RATE_NAME_MAX}
            className={`${paneFieldClass} max-w-[9rem]`}
            value={adding.name}
            onChange={(event) => setAdding({ ...adding, name: event.target.value })}
          />
        </Field>
        <input
          aria-label="New saved rate per night (R)"
          placeholder="R per night"
          inputMode="decimal"
          className={`${paneFieldClass} max-w-[7rem]`}
          value={adding.amount}
          onChange={(event) => setAdding({ ...adding, amount: event.target.value })}
        />
        <SecondaryButton onClick={() => void addRate()} disabled={disabled}>
          Add saved rate
        </SecondaryButton>
      </div>
      {error ? (
        <p role="alert" className="text-[11px] text-[#b45309]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function OneOffForm({
  label,
  disabled,
  onUse,
  onCancel,
}: {
  label: string;
  disabled: boolean;
  onUse: (amountMinor: number) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const reading = readOneOff(text);
  const problem = text.trim() && reading.status !== 'ok' ? reading.message : null;
  return (
    <form
      aria-label={`Typed rate for ${label}`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (reading.status === 'ok') onUse(reading.amountMinor);
      }}
    >
      <Field label="Rate per night (R)" htmlFor={`${id}-amount`} hint="Like 1,200 or 1,250.50">
        <input
          ref={input}
          id={`${id}-amount`}
          aria-describedby={problem ? `${id}-problem` : undefined}
          aria-invalid={problem ? true : undefined}
          inputMode="decimal"
          disabled={disabled}
          className={paneFieldClass}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {problem ? (
        <p id={`${id}-problem`} className="text-[11px] text-[#b45309]">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <SecondaryButton type="submit" disabled={disabled || reading.status !== 'ok'}>
          Use this rate
        </SecondaryButton>
        <button type="button" className={linkClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function OverrideForm({
  label,
  disabled,
  onSave,
  onCancel,
}: {
  label: string;
  disabled: boolean;
  onSave: (override: { rateCode: string; amountMinor: number; note: string }) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<OverrideDraft>({ code: '', otherCode: '', rate: '', note: '' });
  const code = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    code.current?.focus();
  }, []);
  const reading = readOverride(draft);
  return (
    <form
      aria-label={`Discount or override for ${label}`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (reading.status === 'ok') {
          onSave({ rateCode: reading.rateCode, amountMinor: reading.amountMinor, note: reading.note });
        }
      }}
    >
      <Field
        label="HMS rate code"
        htmlFor={`${id}-code`}
        hint={EVENT_RATE_CODES.has(draft.code) ? CRICKET_RATE_HINT : undefined}
      >
        <select
          ref={code}
          id={`${id}-code`}
          disabled={disabled}
          className={paneFieldClass}
          value={draft.code}
          onChange={(event) => setDraft({ ...draft, code: event.target.value })}
        >
          <option value="">Choose a rate code</option>
          {OVERRIDE_RATE_CODES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          <option value={OTHER_CODE}>Other</option>
        </select>
      </Field>
      {draft.code === OTHER_CODE ? (
        <Field label="Other rate code" htmlFor={`${id}-other`}>
          <input
            id={`${id}-other`}
            maxLength={16}
            disabled={disabled}
            className={paneFieldClass}
            value={draft.otherCode}
            onChange={(event) => setDraft({ ...draft, otherCode: event.target.value })}
          />
        </Field>
      ) : null}
      <Field label="Override rate per night (R)" htmlFor={`${id}-rate`} hint="Like 1,850">
        <input
          id={`${id}-rate`}
          inputMode="decimal"
          disabled={disabled}
          className={paneFieldClass}
          value={draft.rate}
          onChange={(event) => setDraft({ ...draft, rate: event.target.value })}
        />
      </Field>
      <Field label="Authorised by" htmlFor={`${id}-note`} required>
        <input
          id={`${id}-note`}
          maxLength={NOTE_MAX}
          disabled={disabled}
          className={paneFieldClass}
          value={draft.note}
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        />
      </Field>
      {reading.status !== 'ok' ? <p className="text-[11px] text-[#64748b]">{reading.message}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <SecondaryButton type="submit" disabled={disabled || reading.status !== 'ok'}>
          Save override
        </SecondaryButton>
        <button type="button" className={linkClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
