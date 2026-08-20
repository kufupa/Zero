import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const disposableUrl = process.env.TEST_DATABASE_URL?.trim();
const canRunDisposableDb =
  process.env.CONFIRM_DISPOSABLE_TEST_DB === '1' &&
  !!disposableUrl &&
  !new URL(disposableUrl).hostname.includes('nava-zero-mail-pilot');

describe('thread audit snapshot incomplete-child concurrency', () => {
  it.skipIf(!canRunDisposableDb)(
    'serializes a child insert against valid-to-incomplete transition',
    async () => {
      const suffix = `task7a_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const schema = `_${suffix.replaceAll('-', '_')}`;
      const first = postgres(disposableUrl!, { max: 1 });
      const second = postgres(disposableUrl!, { max: 1 });

      try {
        await first.unsafe(`CREATE SCHEMA "${schema}"`);
        await first.unsafe(`
          CREATE TABLE "${schema}".header (
            id text PRIMARY KEY,
            trust_status text NOT NULL
          );
          CREATE TABLE "${schema}".component (
            snapshot_id text NOT NULL
          );
          CREATE FUNCTION "${schema}".guard() RETURNS trigger LANGUAGE plpgsql AS $$
          DECLARE parent_status text;
          BEGIN
            IF TG_TABLE_NAME = 'component' THEN
              SELECT trust_status INTO parent_status
              FROM "${schema}".header WHERE id = NEW.snapshot_id FOR UPDATE;
              IF NOT FOUND OR parent_status = 'incomplete' THEN
                RAISE EXCEPTION 'incomplete snapshot cannot have components';
              END IF;
            ELSIF NEW.trust_status = 'incomplete' AND EXISTS (
              SELECT 1 FROM "${schema}".component WHERE snapshot_id = NEW.id
            ) THEN
              RAISE EXCEPTION 'incomplete snapshot cannot have components';
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER component_guard BEFORE INSERT ON "${schema}".component
            FOR EACH ROW EXECUTE FUNCTION "${schema}".guard();
          CREATE TRIGGER header_guard BEFORE UPDATE OF trust_status ON "${schema}".header
            FOR EACH ROW EXECUTE FUNCTION "${schema}".guard();
          INSERT INTO "${schema}".header VALUES ('snapshot', 'valid');
        `);

        await first.unsafe('BEGIN');
        await first.unsafe(`INSERT INTO "${schema}".component VALUES ('snapshot')`);
        const becomeIncomplete = second
          .unsafe(
            `UPDATE "${schema}".header SET trust_status = 'incomplete' WHERE id = 'snapshot'`,
          )
          .then(
            () => null,
            (error) => error,
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
        await first.unsafe('COMMIT');
        expect(await becomeIncomplete).toBeInstanceOf(Error);
      } finally {
        await first.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await first.end();
        await second.end();
      }
    },
  );
});
