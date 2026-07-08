# Search Grammar Simplification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dual-spelling alias maintenance; ship one canonical search grammar with full feature parity and honest 400 errors on unknown operators.

**Architecture:** `parseSearchQuery(q)` accepts only canonical Gmail operators. Outlook spellings throw `SearchParseError` → TRPC 400 + toast. FE `resolveMailListSearch` maps only canonical status-only queries to structured `filters.*`.

**Tech Stack:** TypeScript, Vitest, tRPC, React Query, existing `apps/server-pilot/src/mail/search/*`

**Worktree:** `feat/mail-search` at `~/.config/superpowers/worktrees/zero/feat-mail-search`

## Global Constraints

- **Reject, don't translate:** No Outlook paste tolerance. Unknown `prefix:value` → `SearchParseError`.
- **Canonical v1 operators:** `from:`, `to:`, `cc:`, `bcc:`, `subject:`, `after:`, `before:`, `label:`, `category:`, `is:read|unread|starred|important`, `has:attachment`.
- **Feature parity unchanged:** unread/starred/important/attachment/date/address/label/category/free-text FTS all keep working.

---

**Status:** IMPLEMENTED — 2026-07-08
