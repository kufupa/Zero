CREATE SEQUENCE "hms_credential_admission_position_seq";
--> statement-breakpoint
CREATE TABLE "hms_credential_admission" (
  "operation_key" text PRIMARY KEY,
  "position" bigint DEFAULT 0 NOT NULL,
  "credential_key" bigint,
  "run_id" text UNIQUE REFERENCES "ai_workflow_run"("id") ON DELETE CASCADE,
  "owner_pid" integer,
  "owner_started_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "hms_credential_admission_order_idx" ON "hms_credential_admission" ("position");
--> statement-breakpoint
CREATE FUNCTION "hms_credential_admission_position"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize visibility before assigning a position. Sequence allocation alone
  -- can let an uncommitted insertion overtake an already registered caller.
  PERFORM pg_advisory_xact_lock(hashtextextended('hms-credential-admission-registration', 0));
  NEW.position := nextval('hms_credential_admission_position_seq');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "hms_credential_admission_position" BEFORE INSERT ON "hms_credential_admission"
FOR EACH ROW EXECUTE FUNCTION "hms_credential_admission_position"();
--> statement-breakpoint
CREATE FUNCTION "hms_prefill_admission_ready_at"(job_id text) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE
  ready_text text;
BEGIN
  SELECT coalesce(run.metrics->>'credentialReadyAt',
    CASE WHEN item.state->'reservationWorkflowV2'->'prefill'->>'jobRunId' = run.id
      AND item.state->'reservationWorkflowV2'->'prefill'->>'phase' = 'native_checks'
      THEN item.state->'reservationWorkflowV2'->'prefill'->>'nativeStartedAt' END)
    INTO ready_text FROM ai_workflow_run run LEFT JOIN work_item item ON item.id = run.work_item_id
    WHERE run.id = job_id;
  IF ready_text IS NULL OR ready_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$' THEN
    RAISE EXCEPTION 'HMS credential admission requires native-ready time for prefill %', job_id;
  END IF;
  RETURN ready_text::timestamptz;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "hms_credential_admission_job"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state::text IN ('succeeded', 'dead_letter', 'superseded') THEN
    DELETE FROM hms_credential_admission WHERE run_id = NEW.id;
  ELSIF NEW.run_kind::text = 'read_tool' AND NEW.executor_lane::text = 'hms'
      AND NEW.prompt_version = 'hms-job/1' AND NEW.priority < 10 THEN
    INSERT INTO hms_credential_admission (operation_key, run_id)
      VALUES ('run:' || NEW.id, NEW.id) ON CONFLICT (operation_key) DO NOTHING;
  ELSIF NEW.run_kind::text = 'reservation_prefill' AND NEW.metrics->>'phase' = 'native_checks'
      AND coalesce(NEW.metrics->>'staffPrefillRequested', 'false') <> 'true' THEN
    PERFORM hms_prefill_admission_ready_at(NEW.id);
    INSERT INTO hms_credential_admission (operation_key, run_id)
      VALUES ('run:' || NEW.id, NEW.id) ON CONFLICT (operation_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "hms_credential_admission_job" AFTER INSERT OR UPDATE OF state, priority, metrics ON "ai_workflow_run"
FOR EACH ROW EXECUTE FUNCTION "hms_credential_admission_job"();
--> statement-breakpoint
CREATE FUNCTION "hms_credential_admission_draft"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_id text;
BEGIN
  IF NEW.state->'reservationWorkflowV2'->'prefill'->>'status' = 'running'
      AND NEW.state->'reservationWorkflowV2'->'prefill'->>'phase' = 'native_checks'
      AND (OLD.state->'reservationWorkflowV2'->'prefill'->>'phase' IS DISTINCT FROM 'native_checks'
        OR OLD.state->'reservationWorkflowV2'->'prefill'->>'jobRunId' IS DISTINCT FROM
          NEW.state->'reservationWorkflowV2'->'prefill'->>'jobRunId') THEN
    SELECT run.id INTO job_id FROM ai_workflow_run run
      WHERE run.id = NEW.state->'reservationWorkflowV2'->'prefill'->>'jobRunId'
        AND run.work_item_id = NEW.id AND run.transport_id = NEW.transport_id
        AND run.run_kind::text = 'reservation_prefill'
        AND run.state::text IN ('queued', 'retry_wait', 'claimed', 'running')
        AND coalesce(run.metrics->>'staffPrefillRequested', 'false') <> 'true';
    IF job_id IS NOT NULL THEN
      PERFORM hms_prefill_admission_ready_at(job_id);
      INSERT INTO hms_credential_admission (operation_key, run_id)
        VALUES ('run:' || job_id, job_id) ON CONFLICT (operation_key) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "hms_credential_admission_draft" AFTER UPDATE OF state ON "work_item"
FOR EACH ROW EXECUTE FUNCTION "hms_credential_admission_draft"();
--> statement-breakpoint
INSERT INTO "hms_credential_admission" (operation_key, run_id)
SELECT 'run:' || run.id, run.id FROM "ai_workflow_run" run
LEFT JOIN "work_item" item ON item.id = run.work_item_id
WHERE run.state::text IN ('queued', 'retry_wait', 'claimed', 'running')
  AND ((run.run_kind::text = 'read_tool' AND run.executor_lane::text = 'hms' AND run.prompt_version = 'hms-job/1' AND run.priority < 10)
    OR (run.run_kind::text = 'reservation_prefill' AND coalesce(run.metrics->>'staffPrefillRequested', 'false') <> 'true'
      AND (run.metrics->>'phase' = 'native_checks' OR
        (item.state->'reservationWorkflowV2'->'prefill'->>'jobRunId' = run.id
          AND item.state->'reservationWorkflowV2'->'prefill'->>'phase' = 'native_checks'
          AND item.state->'reservationWorkflowV2'->'prefill'->>'status' = 'running'))))
ORDER BY CASE WHEN run.run_kind::text = 'reservation_prefill'
  THEN hms_prefill_admission_ready_at(run.id) ELSE run.created_at AT TIME ZONE 'UTC' END, run.id
ON CONFLICT (operation_key) DO NOTHING;
