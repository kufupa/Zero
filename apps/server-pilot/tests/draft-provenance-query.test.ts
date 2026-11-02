import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/db/schema/index.js';
import { draftWithEditedRevisionsQuery } from '../src/trpc/routes/draft-provenance-query.js';

describe('draft header provenance query', () => {
  it('correlates edited revisions to the selected draft and mailbox', () => {
    const db = drizzle.mock({ schema });
    const query = draftWithEditedRevisionsQuery(db, 'draft-id', 'transport-id').toSQL();
    expect(query.sql).toContain('"mail_draft_revision"."draft_id" = "mail_draft"."id"');
    expect(query.sql).toContain('"mail_draft_revision"."kind" =');
    expect(query.sql).toContain('"mail_draft"."transport_id" =');
    expect(query.params).toEqual(['edited', 'draft-id', 'transport-id', 1]);
  });
});
