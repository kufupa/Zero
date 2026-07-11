# EC2-pilot full-stress War Room objectives

**Authorized own pilot only.** No third-party hosts. No destructive DB wipe. Document evidence with request/response snippets.

## Targets (tunneled)

- API: `http://127.0.0.1:18788` → EC2 `:8788`
- FE: `http://127.0.0.1:13000` → EC2 `:3000`

## Priority probes

1. **X-Zero-Mailbox** header trust on inbound ingest (OPEN from prior audit) — `apps/server-pilot/src/mail/ingest/parse-message.ts`, `store.ts`
2. **tRPC auth boundaries** — `/api/trpc/*`, session cookies, `mailboxProcedure`
3. **Better Auth** — `/api/auth/*`, `PILOT_OPEN_SIGNUP` behavior
4. **Signed URL + Content-Disposition** attachment handling
5. **HTML ingest/storage XSS** regression (verify still sanitized)
6. **FE mail rendering** — shadow DOM / `processEmailContent` path
7. **AI mail pipeline hooks** — `apps/server-pilot/src/ai/**`

## Operator roster (all 8)

| Archetype | Stress role |
|-----------|-------------|
| recon | Surface map: `/health`, `/api/public/providers`, `/api/auth/*`, `/api/trpc/*`, FE routes |
| scanner | Headers, paths, misconfig, CORS, cookie flags |
| analyst | Correlate → Evidence Vault; cross-ref prior audit OPEN items |
| exploiter | Auth bypass, IDOR, XSS payloads, header injection (`X-Zero-Mailbox`) |
| infiltrator | Session/post-auth lateral, mailbox transport switching |
| exfiltrator | Prove data exposure via signed URLs, attachment paths |
| ghost | Low-noise re-checks on interesting endpoints |
| coordinator | Multi-op task sync when Admiral spawns sub-missions |

## Constraints

- Scope: own EC2 `i-008f737974a9ba9b3` via SSM tunnels only
- No force-push, no `--no-verify`, no `apps/**` modifications by operators
- Prefer read-only / non-destructive probes; document unverified claims clearly
