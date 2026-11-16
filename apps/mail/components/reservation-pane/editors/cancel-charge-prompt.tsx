'use client';

import { useEffect, useRef, useState } from 'react';
import type { CancelCharge } from '@/lib/reservation-workflow/cancel-charge';
import type { ReservationPaneSnapshot, ReservationSourceContext, ReservationWorkflowClient } from '@/lib/reservation-workflow/types';
import styles from '../reservation-pane.module.css';

type Props = {
  client: ReservationWorkflowClient;
  source: ReservationSourceContext;
  snapshot: ReservationPaneSnapshot;
  operationId: string;
};

export function CancelChargePrompt({ client, source, snapshot, operationId }: Props) {
  const context = useRef({ source, snapshot });
  context.current = { source, snapshot };
  const deciding = useRef(false);
  const [charge, setCharge] = useState<CancelCharge | null>(null);
  const [message, setMessage] = useState('');
  const [decisionResult, setDecisionResult] = useState<'waiting' | 'accepted' | 'declined' | 'unavailable' | null>(null);
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    const key = `nava.cancel-charge-decision.${operationId}`;
    try {
      if (window.localStorage.getItem(key)) setDecisionResult('unavailable');
    } catch { setDecisionResult('unavailable'); }
    setStorageReady(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key && event.newValue) setDecisionResult(current => current ?? 'unavailable');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [operationId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        if (!client.cancelCharge || deciding.current) return;
        const result = await client.cancelCharge({ ...context.current, operationId });
        if (!active || deciding.current) return;
        setCharge(result);
        setMessage('');
      } catch {
        if (!active || deciding.current) return;
        setMessage('Checking the Infor fee. Please wait.');
      } finally {
        if (active) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [client, operationId]);

  const decide = async (decision: 'accept' | 'decline') => {
    if (deciding.current || decisionResult || !storageReady || !client.cancelChargeDecision || !charge || charge.status !== 'pending') return;
    try {
      const key = `nava.cancel-charge-decision.${operationId}`;
      if (window.localStorage.getItem(key)) { setDecisionResult('unavailable'); return; }
      window.localStorage.setItem(key, 'attempted');
    } catch { setDecisionResult('unavailable'); return; }
    deciding.current = true;
    setDecisionResult('waiting');
    try {
      const result = await client.cancelChargeDecision({ ...context.current, operationId,
        challengeId: charge.challengeId, dialogDigest: charge.dialogDigest, decision });
      setDecisionResult(result);
    } catch {
      setDecisionResult('unavailable');
    } finally { deciding.current = false; }
  };

  if (!client.cancelCharge || !client.cancelChargeDecision) return null;
  if (charge?.status === 'pending' && storageReady && !decisionResult && !message) return <div className={styles.notice} role="alert">
    <strong>Infor shows a cancellation fee</strong>
    <p>{charge.penaltyText}</p>
    <p>Infor button: {charge.button}</p>
    {!charge.matchesReviewed && <p>Infor showed this fee after your earlier check.</p>}
    <p>{charge.timing === 'after_save' ? 'Infor showed this after the cancellation step. The cancellation may already be submitted; check the outcome before trying again.'
      : 'Infor showed this before cancellation was submitted.'}</p>
    <button type="button" className={styles.primary} onClick={() => { void decide('accept'); }}>
      {charge.timing === 'after_save' ? 'Accept this fee' : 'Cancel with this fee'}
    </button>{' '}
    <button type="button" onClick={() => { void decide('decline'); }}>Don't accept the fee</button>
  </div>;
  if (charge?.status === 'expired') return <p className={styles.notice} role="status">The fee request expired. Check the cancellation outcome in Infor.</p>;
  if (charge?.status === 'declined') return <p className={styles.notice} role="status">Fee declined. Check the cancellation outcome in Infor.</p>;
  if (charge?.status === 'approved') return <p className={styles.notice} role="status">Fee approved. Waiting for Infor to confirm it was sent.</p>;
  if (charge?.status === 'uncertain') return <p className={styles.notice} role="status">Infor has not confirmed the cancellation. Check the outcome in Infor before trying again.</p>;
  if (charge?.status === 'submitted') return <p className={styles.notice} role="status">Fee decision submitted. Waiting for Infor to confirm the outcome.</p>;
  if (decisionResult) return <p className={styles.notice} role="status">{decisionResult === 'accepted' ? 'Fee approved. Waiting for Infor to confirm it was sent.'
    : decisionResult === 'declined' ? 'Fee declined. Check the cancellation outcome in Infor.'
    : decisionResult === 'waiting' ? 'Sending your fee decision. Please wait.'
    : 'The fee decision could not be confirmed. Check the cancellation outcome in Infor.'}</p>;
  if (message) return <p className={styles.notice} role="status">{message}</p>;
  return null;
}
