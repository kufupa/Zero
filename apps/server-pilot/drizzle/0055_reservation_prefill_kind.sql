-- Reservation arrival work uses the existing durable AI ledger.
ALTER TYPE "ai_workflow_run_kind" ADD VALUE IF NOT EXISTS 'reservation_prefill';
