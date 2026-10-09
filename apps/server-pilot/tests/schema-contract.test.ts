import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schema from '../src/db/schema';
import {
  AGENT_RUN_CACHE_STATUSES,
  AGENT_RUN_SOURCES,
  AGENT_RUN_TRIGGERS,
  HITL_EPISODE_OUTCOMES,
  HITL_EVENT_KINDS,
  HITL_LABEL_STRENGTHS,
  HITL_TOOL_RUN_KINDS,
  HITL_TOOL_RUN_STATUSES,
} from '../src/db/schema/hitl';

describe('v4 production mail schema', () => {
  it('uses mailbox access for owner/member/admin', () => {
    expect(schema.mailboxAccess).toBeDefined();
    expect(schema.mailboxTransport).toBeDefined();
  });

  it('has aggregate ingest and quarantine', () => {
    expect(schema.mailIngestMailbox).toBeDefined();
    expect(schema.mailIngestQuarantine).toBeDefined();
  });

  it('exports durable candidate attachment cleanup tasks', () => {
    expect(schema.mailIngestCandidateAttachmentCleanup).toBeDefined();
    expect(schema.mailIngestCandidateAttachmentCleanup.s3Key).toBeDefined();
    expect(schema.mailIngestCandidateAttachmentCleanup.candidateMessageId).toBeDefined();
    expect(schema.mailIngestCandidateAttachmentCleanup.ingestMailboxId).toBeDefined();
    expect(schema.mailIngestCandidateAttachmentCleanup.pop3Uidl).toBeDefined();
  });

  it('cuts stale table shapes', () => {
    expect((schema as Record<string, unknown>).staffMember).toBeUndefined();
    expect((schema as Record<string, unknown>).mailSnooze).toBeUndefined();
    expect((schema as Record<string, unknown>).mailPrompt).toBeUndefined();
    expect((schema as Record<string, unknown>).messageRecipient).toBeUndefined();
  });

  it('exposes required context columns on mail tables', () => {
    expect(schema.mailboxAccess.userId).toBeDefined();
    expect(schema.mailboxAccess.transportId).toBeDefined();
    expect(schema.mailboxAccess.role).toBeDefined();
    expect(schema.mailboxTransport.email).toBeDefined();
    expect(schema.mailboxTransport.ownerHeaderValue).toBeDefined();
    expect(schema.mailboxTransport.mailboxType).toBeDefined();
    expect(schema.mailThread.transportId).toBeDefined();
    expect(schema.mailThread.snoozedUntil).toBeDefined();
    expect(schema.mailThread.searchVector).toBeDefined();
    expect(schema.message.transportId).toBeDefined();
    expect(schema.message.ingestMailboxId).toBeDefined();
    expect(schema.message.pop3Uidl).toBeDefined();
    expect(schema.message.ownerHeaderValue).toBeDefined();
    expect(schema.mailDraft.createdByUserId).toBeDefined();
  });

  it('keeps auth and frontend-compat tables', () => {
    expect(schema.user).toBeDefined();
    expect(schema.session).toBeDefined();
    expect(schema.account).toBeDefined();
    expect(schema.verification).toBeDefined();
    expect(schema.note).toBeDefined();
    expect(schema.userSettings).toBeDefined();
    expect(schema.emailTemplate).toBeDefined();
    expect(schema.jwks).toBeDefined();
  });

  it('drops connection-era and de-scoped tables', () => {
    expect((schema as Record<string, unknown>).connection).toBeUndefined();
    expect((schema as Record<string, unknown>).summary).toBeUndefined();
    expect((schema as Record<string, unknown>).writingStyleMatrix).toBeUndefined();
    expect((schema as Record<string, unknown>).oauthApplication).toBeUndefined();
    expect((schema as Record<string, unknown>).oauthAccessToken).toBeUndefined();
    expect((schema as Record<string, unknown>).oauthConsent).toBeUndefined();
    expect((schema as Record<string, unknown>).earlyAccess).toBeUndefined();
    expect((schema as Record<string, unknown>).userHotkeys).toBeUndefined();
  });

  it('exports draft lifecycle and eval schema tables', () => {
    expect(schema.aiDraftGeneration.contextMessageIds).toBeDefined();
    expect(schema.aiDraftGeneration.promptVersion).toBeDefined();
    expect(schema.mailDraft.status).toBeDefined();
    expect(schema.mailDraft.origin).toBeDefined();
    expect(schema.mailDraft.replyToMessageId).toBeDefined();
    expect(schema.mailDraft.generationId).toBeDefined();
    expect(schema.mailDraftRevision.kind).toBeDefined();
    expect(schema.aiWorkflowRun).toBeDefined();
    expect(schema.aiWorkflowRun.idempotencyKey).toBeDefined();
    expect(schema.aiWorkflowRun.state).toBeDefined();
    expect(schema.aiWorkflowRun.runKind).toBeDefined();
  });
});

import { mailCategory, mailThreadCategory } from '../src/db/schema/mail.js';

describe('mail category schema', () => {
  it('exports mailbox-scoped categories and thread membership tables', () => {
    expect(mailCategory).toBeDefined();
    expect(mailThreadCategory).toBeDefined();
    expect(mailCategory.id.name).toBe('id');
    expect(mailCategory.slug.name).toBe('slug');
    expect(mailThreadCategory.categoryId.name).toBe('category_id');
    expect(mailThreadCategory.threadId.name).toBe('thread_id');
  });
});

const hitlMigrationDdl = readFileSync(
  fileURLToPath(new URL('../drizzle/0046_hitl_ledger.sql', import.meta.url)),
  'utf8',
);

/** The CREATE TABLE body for one table in the hand-written migration. */
function createTableBody(ddl: string, table: string): string {
  const start = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${table}" (`);
  if (start < 0) return '';
  const end = ddl.indexOf('\n);', start);
  return ddl.slice(start, end);
}

describe('HITL decision ledger schema', () => {
  const ledgerTables = {
    aiAgentRun: schema.aiAgentRun,
    hitlEpisode: schema.hitlEpisode,
    hitlEvent: schema.hitlEvent,
    hitlToolRun: schema.hitlToolRun,
  };

  it('exports the four ledger tables with their key columns', () => {
    expect(schema.aiAgentRun.cachedFromRunId).toBeDefined();
    expect(schema.aiAgentRun.retentionExpiresAt).toBeDefined();
    expect(schema.aiAgentRun.inputKey).toBeDefined();
    expect(schema.hitlEpisode.firstRunId).toBeDefined();
    expect(schema.hitlEpisode.latestRunId).toBeDefined();
    expect(schema.hitlEpisode.outcome).toBeDefined();
    expect(schema.hitlEpisode.labelStrength).toBeDefined();
    expect(schema.hitlEvent.kind).toBeDefined();
    expect(schema.hitlEvent.fieldPath).toBeDefined();
    expect(schema.hitlToolRun.status).toBeDefined();
    expect(schema.hitlToolRun.confirmationNo).toBeDefined();
  });

  it('keeps the hand-written migration in step with every Drizzle table', () => {
    for (const table of Object.values(ledgerTables)) {
      const config = getTableConfig(table);
      const body = createTableBody(hitlMigrationDdl, config.name);
      expect(body, config.name).not.toBe('');
      for (const column of config.columns) {
        expect(body, `${config.name}.${column.name}`).toMatch(
          new RegExp(`^  "${column.name}" `, 'm'),
        );
      }
      for (const check of config.checks) {
        expect(body, check.name).toContain(`CONSTRAINT "${check.name}"`);
      }
      for (const index of config.indexes) {
        expect(hitlMigrationDdl, index.config.name).toContain(`"${index.config.name}"`);
      }
    }
  });

  it('keeps CHECK vocabularies in step with the TypeScript lists', () => {
    const lines = hitlMigrationDdl.split('\n');
    const expected: Array<[string, readonly string[]]> = [
      ['ai_agent_run_trigger_check', AGENT_RUN_TRIGGERS],
      ['ai_agent_run_cache_status_check', AGENT_RUN_CACHE_STATUSES],
      ['ai_agent_run_source_check', AGENT_RUN_SOURCES],
      ['hitl_episode_outcome_check', HITL_EPISODE_OUTCOMES],
      ['hitl_episode_label_strength_check', HITL_LABEL_STRENGTHS],
      ['hitl_event_kind_check', HITL_EVENT_KINDS],
      ['hitl_tool_run_kind_check', HITL_TOOL_RUN_KINDS],
      ['hitl_tool_run_status_check', HITL_TOOL_RUN_STATUSES],
    ];
    for (const [name, values] of expected) {
      const line = lines.find((item) => item.includes(`CONSTRAINT "${name}"`));
      expect(line, name).toBeDefined();
      const listed = [...(line ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
      expect(listed, name).toEqual([...values]);
    }
  });

  it('keeps the migration additive: only new tables are altered', () => {
    expect(hitlMigrationDdl).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
    const altered = [...hitlMigrationDdl.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
    expect(altered).toEqual(['ai_agent_run']);
  });

  it('registers 0046 in the journal directly after 0045 on a +1000ms clock', () => {
    const journal = JSON.parse(
      readFileSync(fileURLToPath(new URL('../drizzle/meta/_journal.json', import.meta.url)), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const previous = journal.entries.find((entry) => entry.idx === 45);
    const next = journal.entries.find((entry) => entry.idx === 46);
    expect(previous?.tag).toBe('0045_message_thread_transport_fk');
    expect(next?.tag).toBe('0046_hitl_ledger');
    expect(next?.when).toBe((previous?.when ?? 0) + 1000);
  });
});
