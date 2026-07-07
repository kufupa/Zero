import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';

describe('v4 production mail schema', () => {
  it('uses mailbox access for owner/member/admin', () => {
    expect(schema.mailboxAccess).toBeDefined();
    expect(schema.mailboxTransport).toBeDefined();
  });

  it('has aggregate ingest and quarantine', () => {
    expect(schema.mailIngestMailbox).toBeDefined();
    expect(schema.mailIngestQuarantine).toBeDefined();
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
