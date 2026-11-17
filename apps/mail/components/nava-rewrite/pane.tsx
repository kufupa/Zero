'use client';

import { Mail, Redo2, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './pane.module.css';

export type SelectedEmail = {
  sender: string;
  subject: string;
  receivedLabel?: string;
  receivedDateTime?: string;
  body?: string;
};

export type ActionItem = { id: string; label: string };
export type AvailableAction = { value: string; label: string };

type HistoryControl = { enabled: boolean; onClick: () => void };
type PrimaryAction = { label: string; disabled?: boolean; onClick: () => void };

export type NavaPaneProps = {
  email: SelectedEmail | null;
  history?: { undo: HistoryControl; redo: HistoryControl };
  actions?: {
    items: ActionItem[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    available: AvailableAction[];
    onAdd: (value: string) => void;
    disabled?: boolean;
  };
  children?: ReactNode;
  footer?: ReactNode;
  primaryAction?: PrimaryAction;
};

export function EmailHeader({ email }: { email: SelectedEmail | null }) {
  if (!email) {
    return <div className={styles.emailEmpty}><Mail aria-hidden="true" size={16} />Select an email to start</div>;
  }

  return (
    <section className={styles.email} aria-label="Selected email">
      <Mail aria-hidden="true" className={styles.emailIcon} size={15} />
      <div className={styles.emailContent}>
        <div className={styles.emailMeta}>
          <span data-pii className={styles.sender}>{email.sender || 'Unknown sender'}</span>
          {email.receivedLabel && <time dateTime={email.receivedDateTime}>{email.receivedLabel}</time>}
        </div>
        <div data-pii className={styles.subject}>{email.subject || '(no subject)'}</div>
        {email.body && <details className={styles.message}>
          <summary>Show email</summary>
          <div data-pii className={styles.messageBody}>{email.body}</div>
        </details>}
      </div>
    </section>
  );
}

export function NavaPane({ email, history, actions, children, footer, primaryAction }: NavaPaneProps) {
  return (
    <div className={styles.pane}>
      <header className={styles.header}>
        <strong>Nava</strong>
        {history && <div className={styles.history} aria-label="Draft history">
          <button type="button" aria-label="Undo draft change" title="Undo draft change" disabled={!history.undo.enabled} onClick={history.undo.onClick}><Undo2 aria-hidden="true" size={17} /></button>
          <button type="button" aria-label="Redo draft change" title="Redo draft change" disabled={!history.redo.enabled} onClick={history.redo.onClick}><Redo2 aria-hidden="true" size={17} /></button>
        </div>}
      </header>
      <div className={styles.paneBody} role="region" aria-label="Selected email and work" tabIndex={0}>
        <EmailHeader email={email} />
        {email && actions && <nav className={styles.actionBar} aria-label="Email actions">
          <div className={styles.actions}>
            {actions.items.map(action => <button
              key={action.id}
              type="button"
              aria-current={action.id === actions.selectedId ? 'true' : undefined}
              className={action.id === actions.selectedId ? styles.selectedAction : undefined}
              onClick={() => actions.onSelect(action.id)}
            >{action.label}</button>)}
          </div>
          {actions.available.length > 0 && <select
            className={styles.addAction}
            aria-label="Add action"
            value=""
            disabled={actions.disabled}
            onChange={event => { if (event.target.value) actions.onAdd(event.target.value); }}
          >
            <option value="">Add action</option>
            {actions.available.map(action => <option key={action.value} value={action.value}>{action.label}</option>)}
          </select>}
        </nav>}
        {email && <main className={styles.content}>{children}</main>}
      </div>
      {email && (footer || primaryAction) && <footer className={styles.footer}>
        {footer && <div className={styles.footerContent} tabIndex={0} role="region" aria-label="Action details">{footer}</div>}
        {primaryAction && <button className={styles.primary} type="button" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>{primaryAction.label}</button>}
      </footer>}
    </div>
  );
}

export function PaneSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.section}><h2>{title}</h2>{children}</section>;
}

export function PaneMessage({ tone = 'neutral', children }: { tone?: 'neutral' | 'error'; children: ReactNode }) {
  return <div className={tone === 'error' ? styles.error : styles.notice} role={tone === 'error' ? 'alert' : undefined}>{children}</div>;
}
