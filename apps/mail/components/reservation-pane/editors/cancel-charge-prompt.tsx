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
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!client.cancelCharge || deciding.current) return;
      try {
        const result = await client.cancelCharge({ ...context.current, operationId });
        if (!active || deciding.current) return;
        setCharge(result);
        setMessage('');
      } catch {
        if (!active || deciding.current) return;
        setCharge(null);
        setMessage('Checking the Infor fee. Please wait.');
      }
      if (active && !deciding.current) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [client, operationId]);

  const decide = async (decision: 'accept' | 'decline') => {
    if (deciding.current || !client.cancelChargeDecision || !charge || charge.status !== 'pending') return;
    deciding.current = true;
    setSending(true);
    try {
      const result = await client.cancelChargeDecision({ ...context.current, operationId,
        challengeId: charge.challengeId, dialogDigest: charge.dialogDigest, decision });
      setCharge(null);
      setMessage(result === 'accepted' ? 'Fee approved. Waiting for Infor to confirm it was sent.'
        : result === 'declined' ? 'Fee declined. Check the cancellation outcome in Infor.'
        : 'The fee decision could not be confirmed. Check the cancellation outcome in Infor.');
    } catch {
      setCharge(null);
      setMessage('The fee decision could not be confirmed. Check the cancellation outcome in Infor.');
    } finally { setSending(false); }
  };

  if (!client.cancelCharge || !client.cancelChargeDecision) return null;
  if (charge?.status === 'pending') return <div className={styles.notice} role="alert">
    <strong>Infor shows a cancellation fee</strong>
    <p>{charge.penaltyText}</p>
    {!charge.matchesReviewed && <p>Infor showed this fee after your earlier check.</p>}
    {charge.timing === 'after_save' && <p>The cancellation may already have been submitted. Decide whether to accept the fee.</p>}
    <button type="button" className={styles.primary} disabled={sending} onClick={() => { void decide('accept'); }}>
      {charge.timing === 'after_save' ? 'Accept this fee' : 'Cancel with this fee'}
    </button>{' '}
    <button type="button" disabled={sending} onClick={() => { void decide('decline'); }}>Don't accept the fee</button>
  </div>;
  if (message) return <p className={styles.notice} role="status">{message}</p>;
  if (charge?.status === 'expired') return <p className={styles.notice} role="status">The fee request expired. Check the cancellation outcome in Infor.</p>;
  if (charge?.status === 'declined') return <p className={styles.notice} role="status">Fee declined. Check the cancellation outcome in Infor.</p>;
  if (charge?.status === 'approved') return <p className={styles.notice} role="status">Fee approved. Waiting for Infor to confirm it was sent.</p>;
  if (charge?.status === 'uncertain') return <p className={styles.notice} role="status">Infor has not confirmed the cancellation. Check the outcome in Infor before trying again.</p>;
  if (charge?.status === 'submitted') return <p className={styles.notice} role="status">Fee decision submitted. Waiting for Infor to confirm the outcome.</p>;
  return null;
}
