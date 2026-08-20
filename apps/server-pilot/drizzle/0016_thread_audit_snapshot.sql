CREATE UNIQUE INDEX IF NOT EXISTS "mail_thread_id_transport_uidx"
  ON "mail_thread" ("id", "transport_id");

DO $$ BEGIN
  CREATE TYPE "thread_audit_snapshot_trust_status" AS ENUM ('valid', 'incomplete');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "thread_audit_snapshot_trust_reason" AS ENUM ('verified', 'source_coverage_limited', 'pending_manual_adjudication', 'source_not_ready');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "thread_audit_snapshot_state" AS ENUM ('resolved', 'action_required', 'customer_acknowledgement_or_confirmation', 'automated_or_non_actionable', 'needs_manual_adjudication');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "thread_audit_snapshot_evidence_tier" AS ENUM ('persisted_reply', 'quoted_reply', 'participant_subject_only_correlation', 'no_evidence');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "thread_audit_snapshot_impact_class" AS ENUM ('commercial_follow_up_hypothesis', 'guest_trust', 'staff_time', 'data_quality');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "thread_audit_snapshot_age_bucket" AS ENUM ('under_4h', 'four_to_24h', 'one_to_three_days', 'over_three_days', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "thread_audit_snapshot_handoff_state" AS ENUM ('no_handoff_observed', 'internal_handoff_observed', 'handoff_evidence_limited');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "thread_audit_snapshot_next_human_check" AS ENUM ('review_latest_action', 'verify_source_coverage', 'verify_quote_context', 'verify_identity_or_linkage', 'verify_event_time', 'verify_duplicate_or_ingest', 'collect_authoritative_pms_data', 'collect_attachment_or_document_data', 'create_draft_evaluation_cohort', 'review_pending_task3', 'rerun_task3_after_review', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "thread_audit_snapshot_example_selection_reason" AS ENUM ('outlier', 'aged_action', 'ambiguity', 'impact');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "thread_audit_snapshot" (
  "publication_incarnation_id" text PRIMARY KEY NOT NULL,
  "id" text NOT NULL,
  "transport_id" text NOT NULL,
  "trust_status" "thread_audit_snapshot_trust_status" NOT NULL,
  "trust_reason_code" "thread_audit_snapshot_trust_reason" NOT NULL,
  "source_manifest_digest" text NOT NULL,
  "source_identity_digest" text NOT NULL,
  "payload_digest" text NOT NULL,
  "sealed_envelope_digest" text NOT NULL,
  "publication_revision_token" text NOT NULL,
  "source_schema_version" text NOT NULL,
  "identity_rules_version" text NOT NULL,
  "classifier_version" text NOT NULL,
  "metric_definition_version" text NOT NULL,
  "source_event_cutoff_at" timestamp with time zone NOT NULL,
  "source_ingest_cutoff_at" timestamp with time zone NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "attempted_at" timestamp with time zone NOT NULL,
  "published_at" timestamp with time zone NOT NULL,
  "message_count" integer,
  "component_count" integer,
  "persisted_thread_count" integer,
  "parser_exception_count" integer,
  "coverage_exception_count" integer,
  "metrics_and_insights" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_audit_snapshot_counter_check" CHECK (
    ("message_count" IS NULL OR "message_count" >= 0)
    AND ("component_count" IS NULL OR "component_count" >= 0)
    AND ("persisted_thread_count" IS NULL OR "persisted_thread_count" >= 0)
    AND ("parser_exception_count" IS NULL OR "parser_exception_count" >= 0)
    AND ("coverage_exception_count" IS NULL OR "coverage_exception_count" >= 0)
  ),
  CONSTRAINT "thread_audit_snapshot_trust_shape_check" CHECK (
    (
      "trust_status" = 'valid'
      AND "trust_reason_code" = 'verified'
      AND "message_count" IS NOT NULL
      AND "component_count" IS NOT NULL
      AND "persisted_thread_count" IS NOT NULL
      AND "parser_exception_count" IS NOT NULL
      AND "coverage_exception_count" IS NOT NULL
      AND "metrics_and_insights" IS NOT NULL
      AND jsonb_typeof("metrics_and_insights") = 'object'
    )
    OR (
      "trust_status" = 'incomplete'
      AND "trust_reason_code" <> 'verified'
      AND "message_count" IS NULL
      AND "component_count" IS NULL
      AND "persisted_thread_count" IS NULL
      AND "parser_exception_count" IS NULL
      AND "coverage_exception_count" IS NULL
      AND "metrics_and_insights" IS NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "thread_audit_snapshot_id_transport_uidx"
  ON "thread_audit_snapshot" ("id", "transport_id");

CREATE TABLE IF NOT EXISTS "thread_audit_snapshot_component" (
  "snapshot_id" text NOT NULL,
  "component_id" text NOT NULL,
  "transport_id" text NOT NULL,
  "final_state" "thread_audit_snapshot_state" NOT NULL,
  "reason_codes" text[] NOT NULL,
  "limitation_codes" text[] NOT NULL,
  "evidence_tier" "thread_audit_snapshot_evidence_tier" NOT NULL,
  "impact_class" "thread_audit_snapshot_impact_class" NOT NULL,
  "age_bucket" "thread_audit_snapshot_age_bucket" NOT NULL,
  "handoff_state" "thread_audit_snapshot_handoff_state" NOT NULL,
  "next_human_check" "thread_audit_snapshot_next_human_check" NOT NULL,
  "example_selection_reason" "thread_audit_snapshot_example_selection_reason",
  "latest_action_at" timestamp with time zone,
  "initial_mapping_count" integer NOT NULL,
  "sort_group" integer NOT NULL,
  "sort_rank" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_audit_snapshot_component_pk" PRIMARY KEY ("snapshot_id", "component_id", "transport_id"),
  CONSTRAINT "thread_audit_snapshot_component_count_check" CHECK (
    "initial_mapping_count" >= 0
    AND "sort_group" >= 0
    AND "sort_group" <= 2
    AND "sort_rank" >= 0
  )
);

CREATE TABLE IF NOT EXISTS "thread_audit_snapshot_component_thread" (
  "snapshot_id" text NOT NULL,
  "component_id" text NOT NULL,
  "transport_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "source_membership_rank" integer NOT NULL,
  "is_primary" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_audit_snapshot_component_thread_pk" PRIMARY KEY ("snapshot_id", "component_id", "transport_id", "thread_id"),
  CONSTRAINT "thread_audit_snapshot_component_thread_rank_check" CHECK ("source_membership_rank" >= 0)
);

DO $$ BEGIN
  ALTER TABLE "thread_audit_snapshot"
    ADD CONSTRAINT "thread_audit_snapshot_transport_fk"
    FOREIGN KEY ("transport_id") REFERENCES "mailbox_transport"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION "thread_audit_snapshot_reject_incomplete_children"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status "thread_audit_snapshot_trust_status";
BEGIN
  IF TG_TABLE_NAME = 'thread_audit_snapshot_component' THEN
    SELECT "trust_status" INTO parent_status
    FROM "thread_audit_snapshot"
    WHERE "id" = NEW."snapshot_id"
      AND "transport_id" = NEW."transport_id"
    FOR UPDATE;
    IF NOT FOUND OR parent_status = 'incomplete' THEN
      RAISE EXCEPTION 'thread audit incomplete snapshot cannot have components';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'thread_audit_snapshot'
    AND NEW."trust_status" = 'incomplete'
    AND EXISTS (
      SELECT 1 FROM "thread_audit_snapshot_component"
      WHERE "snapshot_id" = NEW."id" AND "transport_id" = NEW."transport_id"
    )
  THEN
    RAISE EXCEPTION 'thread audit incomplete snapshot cannot have components';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "thread_audit_snapshot_reject_incomplete_children"
BEFORE INSERT OR UPDATE ON "thread_audit_snapshot_component"
FOR EACH ROW EXECUTE FUNCTION "thread_audit_snapshot_reject_incomplete_children"();

CREATE TRIGGER "thread_audit_snapshot_reject_incomplete_header"
BEFORE UPDATE OF "trust_status" ON "thread_audit_snapshot"
FOR EACH ROW EXECUTE FUNCTION "thread_audit_snapshot_reject_incomplete_children"();

DO $$ BEGIN
  ALTER TABLE "thread_audit_snapshot_component"
    ADD CONSTRAINT "thread_audit_snapshot_component_snapshot_transport_fk"
    FOREIGN KEY ("snapshot_id", "transport_id")
    REFERENCES "thread_audit_snapshot"("id", "transport_id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "thread_audit_snapshot_component_thread"
    ADD CONSTRAINT "thread_audit_snapshot_component_thread_component_fk"
    FOREIGN KEY ("snapshot_id", "component_id", "transport_id")
    REFERENCES "thread_audit_snapshot_component"("snapshot_id", "component_id", "transport_id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
 
DO $$ BEGIN
  ALTER TABLE "thread_audit_snapshot_component_thread"
    ADD CONSTRAINT "thread_audit_snapshot_component_thread_thread_transport_fk"
    FOREIGN KEY ("thread_id", "transport_id")
    REFERENCES "mail_thread"("id", "transport_id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "thread_audit_snapshot_transport_uidx"
  ON "thread_audit_snapshot" ("transport_id");

CREATE INDEX IF NOT EXISTS "thread_audit_snapshot_component_snapshot_sort_idx"
  ON "thread_audit_snapshot_component" (
    "snapshot_id",
    "transport_id",
    "sort_group",
    "sort_rank",
    "component_id"
  );

CREATE UNIQUE INDEX IF NOT EXISTS "thread_audit_snapshot_component_thread_rank_uidx"
  ON "thread_audit_snapshot_component_thread" (
    "snapshot_id",
    "component_id",
    "transport_id",
    "source_membership_rank"
  );

CREATE UNIQUE INDEX IF NOT EXISTS "thread_audit_snapshot_component_thread_primary_uidx"
  ON "thread_audit_snapshot_component_thread" (
    "snapshot_id",
    "component_id",
    "transport_id"
  )
  WHERE "is_primary";
