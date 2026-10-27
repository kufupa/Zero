'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { paneFieldClass } from '@/components/nava-pane/pane-ui';

export type ConfirmationMode = 'self' | 'client' | 'custom';

export type ConfirmationSetting = {
  mode: ConfirmationMode;
  address?: string;
};

export type ConfirmationRecipientPayload = {
  mode: ConfirmationMode;
  address: string;
};

export type ConfirmationSources = {
  userEmail: string;
  setting: ConfirmationSetting | null;
  /** Saved confirmation could not be read. Fail closed until staff pick. */
  invalidSetting?: boolean;
  /**
   * pending: read in flight. failed: read threw. ready: row parsed.
   * absent: this pane has no settings route, so the default applies.
   */
  load?: 'pending' | 'ready' | 'failed' | 'absent';
};

const ConfirmationSourcesContext = createContext<ConfirmationSources | null>(null);

export function ConfirmationSourcesProvider({
  value,
  children,
}: {
  value: ConfirmationSources;
  children: ReactNode;
}) {
  return <ConfirmationSourcesContext.Provider value={value}>{children}</ConfirmationSourcesContext.Provider>;
}

export function useConfirmationSources(): ConfirmationSources | null {
  return useContext(ConfirmationSourcesContext);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isConfirmationEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value) && value.length <= 254;
}

export type ResolvedConfirmation =
  | { ok: true; recipient: ConfirmationRecipientPayload }
  | { ok: false; message: string };

/**
 * Resolves the address HMS should use for this booking.
 * Nava never sends the letter. A missing address fails closed.
 */
export function resolveConfirmationRecipient(input: {
  mode: ConfirmationMode;
  customAddress: string;
  userEmail: string;
  clientEmail: string;
  invalidSetting?: boolean;
  /** Staff changed the control for this booking. That pick replaces a bad saved choice. */
  staffChose?: boolean;
}): ResolvedConfirmation {
  if (input.invalidSetting && !input.staffChose) {
    return {
      ok: false,
      message: 'The saved confirmation choice is not set up. Pick who should get the HMS confirmation.',
    };
  }
  if (input.mode === 'self') {
    const address = cleanEmail(input.userEmail);
    if (!isConfirmationEmail(address)) {
      return {
        ok: false,
        message: 'Your email is not set up, so the HMS confirmation cannot go to you.',
      };
    }
    return { ok: true, recipient: { mode: 'self', address } };
  }
  if (input.mode === 'client') {
    const address = cleanEmail(input.clientEmail);
    if (!isConfirmationEmail(address)) {
      return {
        ok: false,
        message: 'The client email was not found, so the HMS confirmation cannot go to the client.',
      };
    }
    return { ok: true, recipient: { mode: 'client', address } };
  }
  const address = cleanEmail(input.customAddress);
  if (!isConfirmationEmail(address)) {
    return {
      ok: false,
      message: 'The other address is not set up. Enter an email for the HMS confirmation.',
    };
  }
  return { ok: true, recipient: { mode: 'custom', address } };
}

export function confirmationSettingFromRow(row: unknown): {
  setting: ConfirmationSetting | null;
  invalid: boolean;
} {
  const settings =
    row && typeof row === 'object' && 'settings' in row
      ? (row as { settings?: unknown }).settings
      : null;
  if (!settings || typeof settings !== 'object' || !('confirmation' in settings)) {
    return { setting: null, invalid: false };
  }
  const confirmation = (settings as { confirmation?: unknown }).confirmation;
  if (!confirmation || typeof confirmation !== 'object') return { setting: null, invalid: true };
  const mode = (confirmation as { mode?: unknown }).mode;
  const address = (confirmation as { address?: unknown }).address;
  if (mode !== 'self' && mode !== 'client' && mode !== 'custom') {
    return { setting: null, invalid: true };
  }
  if (address !== undefined && (typeof address !== 'string' || !isConfirmationEmail(address))) {
    return { setting: null, invalid: true };
  }
  return { setting: { mode, ...(typeof address === 'string' ? { address } : {}) }, invalid: false };
}

function optionLabel(kind: 'self' | 'client', email: string): string {
  if (kind === 'self') return email ? `Me (${email})` : 'Me (not set up)';
  return email ? `Client (${email})` : 'Client (not found)';
}

export function ConfirmationRecipient({
  mode,
  customAddress,
  userEmail,
  clientEmail,
  disabled,
  error,
  unconfirmed,
  onMode,
  onCustomAddress,
  onMakeDefault,
  defaultSaved,
  defaultError,
}: {
  mode: ConfirmationMode;
  customAddress: string;
  userEmail: string;
  clientEmail: string;
  disabled?: boolean;
  error?: string | null;
  /** Blank the control until staff pick. A bad save or a failed read uses this. */
  unconfirmed?: boolean;
  onMode: (mode: ConfirmationMode) => void;
  onCustomAddress: (address: string) => void;
  onMakeDefault?: () => void;
  defaultSaved?: boolean;
  defaultError?: string | null;
}) {
  const user = cleanEmail(userEmail);
  const client = cleanEmail(clientEmail);
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
        Send HMS confirmation to
        <select
          aria-label="Send HMS confirmation to"
          className={paneFieldClass}
          disabled={disabled}
          value={unconfirmed ? '' : mode}
          onChange={(event) => {
            const next = event.target.value;
            if (next === 'self' || next === 'client' || next === 'custom') onMode(next);
          }}
        >
          {unconfirmed ? <option value="">Choose</option> : null}
          <option value="self">{optionLabel('self', user)}</option>
          <option value="client">{optionLabel('client', client)}</option>
          <option value="custom">Other…</option>
        </select>
      </label>
      {mode === 'custom' ? (
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
          Other email
          <input
            type="email"
            aria-label="Other confirmation email"
            className={paneFieldClass}
            disabled={disabled}
            value={customAddress}
            autoComplete="off"
            onChange={(event) => onCustomAddress(event.target.value)}
          />
        </label>
      ) : null}
      <p className="text-[11px] text-[#64748b]">HMS sends this confirmation. Nava does not send mail.</p>
      {onMakeDefault ? (
        <button
          type="button"
          className="self-start text-[11px] font-semibold text-[#0066cc] underline disabled:text-[#94a3b8]"
          disabled={disabled || defaultSaved}
          onClick={onMakeDefault}
        >
          {defaultSaved ? 'Saved as your default' : 'Make this my default'}
        </button>
      ) : null}
      {defaultError ? (
        <p role="alert" className="text-[11.5px] text-amber-900">
          {defaultError}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[11.5px] text-amber-900">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type SettingsClient = {
  settings?: {
    get?: { query?: () => Promise<unknown> };
    save?: { mutate?: (input: { confirmation: ConfirmationSetting }) => Promise<unknown> };
  };
};

type SettingsQuery = {
  queryKey: readonly unknown[];
  state: { data?: unknown };
};

type SettingsQueryClient = {
  getQueryCache: () => { getAll: () => SettingsQuery[] };
  setQueryData: (queryKey: readonly unknown[], data: unknown) => void;
};

type SavedDefaultListener = () => void;

let savedDefault: ConfirmationSetting | null = null;
const savedDefaultListeners = new Set<SavedDefaultListener>();

function subscribeSavedDefault(listener: SavedDefaultListener) {
  savedDefaultListeners.add(listener);
  return () => {
    savedDefaultListeners.delete(listener);
  };
}

function readSavedDefault() {
  return savedDefault;
}

function publishSavedDefault() {
  savedDefaultListeners.forEach((listener) => listener());
}

/** Drops a default saved in this pane. The bridge calls this when the signed-in user changes. */
export function clearSavedConfirmation() {
  if (!savedDefault) return;
  savedDefault = null;
  publishSavedDefault();
}

function dropSavedConfirmation() {
  savedDefault = null;
}

function noteSavedConfirmation(setting: ConfirmationSetting) {
  savedDefault = setting;
  publishSavedDefault();
}

function confirmationForSave(setting: ConfirmationSetting): ConfirmationSetting {
  return setting.mode === 'custom' && setting.address
    ? { mode: 'custom', address: setting.address }
    : { mode: setting.mode };
}

function patchSettingsGetCache(queryClient: SettingsQueryClient, confirmation: ConfirmationSetting) {
  for (const query of queryClient.getQueryCache().getAll()) {
    const keyText = JSON.stringify(query.queryKey);
    if (!keyText.includes('settings') || !keyText.includes('get')) continue;
    const data = query.state.data;
    if (!data || typeof data !== 'object' || !('settings' in data)) continue;
    const row = data as { settings?: unknown };
    if (!row.settings || typeof row.settings !== 'object') continue;
    queryClient.setQueryData(query.queryKey, {
      ...row,
      settings: { ...(row.settings as Record<string, unknown>), confirmation },
    });
  }
}

/** Saves only the confirmation key. The settings route merges that key and leaves the rest of the row. */
export async function saveConfirmationDefault(setting: ConfirmationSetting): Promise<void> {
  const provider = await import('@/providers/query-provider');
  const save = (provider.trpcClient as SettingsClient).settings?.save?.mutate;
  if (!save) {
    throw new Error('Could not save your default (not set up).');
  }
  const confirmation = confirmationForSave(setting);
  await save({ confirmation });
  noteSavedConfirmation(confirmation);
  const getQueryClient = (provider as { getQueryClient?: () => SettingsQueryClient }).getQueryClient;
  if (!getQueryClient) return;
  patchSettingsGetCache(getQueryClient(), confirmation);
}

/**
 * Reads the signed-in user's confirmation default. Both pane surfaces render NavaPane,
 * so this one bridge covers Outlook and webmail. A missing settings route leaves the default.
 */
export function ConfirmationSourcesBridge({
  userEmail,
  children,
}: {
  userEmail: string;
  children: ReactNode;
}) {
  const [setting, setSetting] = useState<ConfirmationSetting | null>(null);
  const [invalidSetting, setInvalidSetting] = useState(false);
  const [load, setLoad] = useState<NonNullable<ConfirmationSources['load']>>('pending');
  const [loadedFor, setLoadedFor] = useState(userEmail);
  const noted = useSyncExternalStore(subscribeSavedDefault, readSavedDefault, () => null);

  if (loadedFor !== userEmail) {
    setLoadedFor(userEmail);
    setSetting(null);
    setInvalidSetting(false);
    setLoad('pending');
    dropSavedConfirmation();
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { trpcClient } = await import('@/providers/query-provider');
        const query = (trpcClient as SettingsClient).settings?.get?.query;
        if (!query) {
          if (!cancelled) setLoad('absent');
          return;
        }
        const row = await query();
        if (cancelled) return;
        const parsed = confirmationSettingFromRow(row);
        setSetting(parsed.setting);
        setInvalidSetting(parsed.invalid);
        setLoad('ready');
      } catch {
        if (!cancelled) setLoad('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userEmail]);

  const value = useMemo(() => {
    if (noted) {
      return { userEmail, setting: noted, invalidSetting: false, load: 'ready' as const };
    }
    return { userEmail, setting, invalidSetting, load };
  }, [userEmail, setting, invalidSetting, load, noted]);
  return <ConfirmationSourcesProvider value={value}>{children}</ConfirmationSourcesProvider>;
}
