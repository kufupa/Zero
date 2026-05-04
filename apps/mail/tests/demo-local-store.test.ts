import { beforeEach, describe, expect, it } from 'vitest';
import {
  getDemoStore,
  listDemoTemplates,
  resetDemoStoreForTests,
  upsertDemoDraft,
  upsertDemoNote,
  upsertDemoTemplate,
} from '../lib/demo/local-store';

beforeEach(() => {
  resetDemoStoreForTests();
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
  }
});

describe('demo local store', () => {
  it('keeps draft ids deterministic for equivalent input', () => {
    const first = upsertDemoDraft({ subject: 'RFQ', body: 'Hello' });
    const second = upsertDemoDraft({ subject: 'RFQ', body: 'Hello' });

    expect(second.id).toBe(first.id);
    expect(getDemoStore().drafts[first.id]).toBeDefined();
    expect(getDemoStore().drafts[first.id]?.subject).toBe('RFQ');
    expect(getDemoStore().drafts[first.id]?.body).toBe('Hello');
  });

  it('returns seeded templates when none are persisted yet', () => {
    const templates = listDemoTemplates();

    expect(templates.length).toBeGreaterThan(0);
    expect(templates.find((template) => template.id === 'template-checkin-followup')).toBeTruthy();
    expect(listDemoTemplates()).toEqual(templates);
    expect(getDemoStore().templates[templates[0]!.id]).toEqual(templates[0]);
  });

  it('keeps note ids deterministic for equivalent input', () => {
    const first = upsertDemoNote({ threadId: 'thread-1', content: 'Follow-up needed' });
    const second = upsertDemoNote({ threadId: 'thread-1', content: 'Follow-up needed' });

    expect(second.id).toBe(first.id);
    expect(getDemoStore().notes[first.id]).toBeDefined();
    expect(getDemoStore().notes[first.id]?.content).toBe('Follow-up needed');
    expect(getDemoStore().notes[first.id]?.threadId).toBe('thread-1');
  });

  it('keeps template ids deterministic for equivalent input', () => {
    const first = upsertDemoTemplate({ name: 'Daily standup', subject: 'Daily standup update', body: 'Status report' });
    const second = upsertDemoTemplate({ name: 'Daily standup', subject: 'Daily standup update', body: 'Status report' });

    expect(second.id).toBe(first.id);
    expect(getDemoStore().templates[first.id]).toBeDefined();
    expect(getDemoStore().templates[first.id]?.name).toBe('Daily standup');
    expect(getDemoStore().templates[first.id]?.subject).toBe('Daily standup update');
  });
});
