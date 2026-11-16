'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { trpcClient } from '@/providers/query-provider';
import { getMailCacheScope, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';
import { effectiveAt, text, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import styles from '../editors/create-quote-editor.module.css';
import hintStyles from '../editors/other-editors.module.css';

const PROPERTY = /^[A-Z0-9]{2,16}$/;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Server-backed (user_settings) remembered recipient per property, shared by every field in this page. */
const remembered = new Map<string, string>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function load(code: string, key: string) {
  if (!key || remembered.has(key) || loading.has(key)) return;
  loading.add(key);
  void Promise.resolve()
    .then(() => trpcClient.settings.cmsRecipientDefault.query({ propertyCode: code }))
    .then(result => { if (!remembered.has(key)) remembered.set(key, result?.address ?? ''); }, () => { /* no default: field stays empty */ })
    .finally(() => { loading.delete(key); emit(); });
}

/** The signed-in user's remembered CMS recipient for this property. Empty when none is set or it cannot be read. */
export function useCmsRecipientDefault(propertyCode: string | null | undefined) {
  const code = propertyCode && PROPERTY.test(propertyCode) ? propertyCode : '';
  const userId = useSyncExternalStore(subscribeMailCacheScope, () => getMailCacheScope().userId, () => null);
  const key = userId && code ? JSON.stringify([userId, code]) : '';
  useEffect(() => load(code, key), [code, key]);
  const address = useSyncExternalStore(subscribe, () => remembered.get(key) ?? '', () => '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = async (next: string | null) => {
    if (!key || userId !== getMailCacheScope().userId) return;
    setBusy(true); setFailed(false);
    try {
      const result = await trpcClient.settings.setCmsRecipientDefault.mutate({ propertyCode: code, address: next });
      remembered.set(key, result.address ?? ''); emit();
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return { address: code ? address : '', busy, failed, remember: (next: string) => save(next), forget: () => save(null) };
}

/** One quiet line under the CMS recipient field: remember the typed address as this user's default, or forget it. */
export function CmsRecipientDefault({ editor, path }: { editor: WorkbenchEditorProps; path: string }) {
  const memory = useCmsRecipientDefault(editor.snapshot.session.draft.propertyCode);
  const current = text(effectiveAt(editor.snapshot, path)).trim();
  const canRemember = current.length <= 255 && EMAIL.test(current) && current.toLowerCase() !== memory.address.toLowerCase();
  if (!canRemember && !memory.address) return null;
  const disabled = memory.busy || editor.view.busy;
  return <div className={hintStyles.hint} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
    {memory.address && <span data-pii>Your default: {memory.address}</span>}
    {canRemember && <button type="button" className={styles.linkButton} disabled={disabled}
      onClick={() => void memory.remember(current)}>Make this my default</button>}
    {memory.address && <button type="button" className={styles.linkButton} disabled={disabled}
      onClick={() => void memory.forget()}>Forget my default</button>}
    {memory.failed && <span role="alert">Could not save your default. Try again.</span>}
  </div>;
}
