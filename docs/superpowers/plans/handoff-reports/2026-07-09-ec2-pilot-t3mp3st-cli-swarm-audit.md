# EC2-pilot overnight cli-swarm audit (T3MP3ST + xAI grok-4.5)

**Branch:** EC2-pilot  
**Mode:** read-only code audit — T3MP3ST cli-swarm, no AWS prod, no live network probes  
**Backbone:** xAI `grok-4.5` + `reasoning_effort=high`  
**Pipeline:** cli-swarm specialists → skeptic → triage (NOT Cursor agent manual audit)

Progressive output below.



## Setup

_2026-07-09T22:51:56.035Z_

- Report initialized
- Loading XAI from repo `.env`


## LLM smoke test

_2026-07-09T22:51:58.127Z_

```json
{"ok":true,"model":"grok-4.5","reasoning_effort":"high","content":"grok-ok"}
```


## Scope inventory

_2026-07-09T22:51:58.295Z_

**1624** scoped TS/JS files under server-pilot (excl ai) + mail.

Top paths:
- `apps/server-pilot/src/db/client.ts`
- `apps/server-pilot/src/db/schema/app.ts`
- `apps/server-pilot/src/db/schema/auth.ts`
- `apps/server-pilot/src/db/schema/index.ts`
- `apps/server-pilot/src/db/schema/mail.ts`
- `apps/server-pilot/src/db/seed.ts`
- `apps/server-pilot/src/db/ssl-config.ts`
- `apps/server-pilot/src/env.ts`
- `apps/server-pilot/src/lib/auth-providers.ts`
- `apps/server-pilot/src/lib/auth.ts`
- `apps/server-pilot/src/lib/driver/types.ts`
- `apps/server-pilot/src/lib/pilot-secrets.ts`
- `apps/server-pilot/src/lib/schemas.ts`
- `apps/server-pilot/src/mail/attachment-filename.ts`
- `apps/server-pilot/src/mail/fixture-loopback.ts`
- `apps/server-pilot/src/mail/ingest/limits.ts`
- `apps/server-pilot/src/mail/ingest/parse-message.ts`
- `apps/server-pilot/src/mail/ingest/pop3-client.ts`
- `apps/server-pilot/src/mail/ingest/store.ts`
- `apps/server-pilot/src/mail/ingest/worker.ts`
- `apps/server-pilot/src/mail/sanitize-email-html.ts`
- `apps/server-pilot/src/mail/search/parse.ts`
- `apps/server-pilot/src/mail/search/query.ts`
- `apps/server-pilot/src/mail/search/search-vector.ts`
- `apps/server-pilot/src/mail/search/trpc.ts`
- `apps/server-pilot/src/mail/search/types.ts`
- `apps/server-pilot/src/mail/send/smtp.ts`
- `apps/server-pilot/src/mail/send/validate-outbound.ts`
- `apps/server-pilot/src/main.ts`
- `apps/server-pilot/src/storage/s3.ts`


EC2-pilot monorepo scope (production code only):
- apps/server-pilot/src/** EXCLUDING apps/server-pilot/src/ai/** (parallel Mastra work)
- apps/mail/** frontend
- OUT: legacy apps/server, production AWS, tests/fixtures as primary findings
- Re-check prior audit: HTML XSS seam, X-Zero-Mailbox header trust, RDS TLS, signed URL disposition, auth shortcuts



## Starting cli-swarm

_2026-07-09T22:51:58.295Z_

Command: `node scripts/cli-swarm.mjs --backend xai ...`
Squad: `full`


## cli-swarm round 1 (partial)

_2026-07-09T22:51:58.379Z_

```

════════════════════════════════════════════════════════════════════════
  ⚡ CLI-SWARM — BYO-subscription collaborative zero-day swarm
  target:      C:\Users\gamin\Desktop\projs\emails hotels uis\zero
  squad:       10 agent(s) / 10 class(es) [--squad full] · effort=high
  plan:        up to 3 collaborative rounds · 2 parallel · budget 240min
  mode:        SWARM — specialists + shared board + adversarial refutation · model=grok-4.5 · READ-ONLY · xAI API
════════════════════════════════════════════════════════════════════════


──────── ROUND 1/3  (22:51:58) ────────

```


## cli-swarm round 2 (partial)

_2026-07-09T22:58:53.827Z_

```

════════════════════════════════════════════════════════════════════════
  ⚡ CLI-SWARM — BYO-subscription collaborative zero-day swarm
  target:      C:\Users\gamin\Desktop\projs\emails hotels uis\zero
  squad:       10 agent(s) / 10 class(es) [--squad full] · effort=high
  plan:        up to 3 collaborative rounds · 2 parallel · budget 240min
  mode:        SWARM — specialists + shared board + adversarial refutation · model=grok-4.5 · READ-ONLY · xAI API
════════════════════════════════════════════════════════════════════════


──────── ROUND 1/3  (22:51:58) ────────
  • Path traversal         0 item(s) (0 confirmed/high) (37s)
  • Prototype pollution    0 item(s) (0 confirmed/high) (31s)
  • Injection              0 item(s) (0 confirmed/high) (91s)
  • SSRF / open-redirect   0 item(s) (0 confirmed/high) (64s)
  • ReDoS / resource DoS   0 item(s) (0 confirmed/high) (137s)
  • Authz / access-control 0 item(s) (0 confirmed/high) (49s)
  • Deserialization / parse 6 item(s) (2 confirmed/high) (58s)
  • Crypto / secrets       0 item(s) (0 confirmed/high) (80s)
  • Memory safety          0 item(s) (0 confirmed/high) (34s)
  • Supply-chain / privileged-action 0 item(s) (0 confirmed/high) (43s)
  ⚔ skeptic refuting 2 candidate finding(s)…
    ✗ REFUTED  CWE-400 apps/server-pilot/src/trpc/wire-compat.ts:29 — apps/server-pilot/src/trpc/routes/drafts.ts:278
    ✓ SURVIVES CWE-400 apps/server-pilot/src/mail/ingest/pop3-client.ts:283 — POP3 RETR body assembly has no per-message byte cap before full Buffer.concat
  round 1 summary: +1 confirmed, +4 leads, 1 refuted · totals: 1 confirmed / 4 open leads / 1 refuted

──────── ROUND 2/3  (22:58:53) ────────

```


## cli-swarm round 3 (partial)

_2026-07-09T23:03:34.478Z_

```

════════════════════════════════════════════════════════════════════════
  ⚡ CLI-SWARM — BYO-subscription collaborative zero-day swarm
  target:      C:\Users\gamin\Desktop\projs\emails hotels uis\zero
  squad:       10 agent(s) / 10 class(es) [--squad full] · effort=high
  plan:        up to 3 collaborative rounds · 2 parallel · budget 240min
  mode:        SWARM — specialists + shared board + adversarial refutation · model=grok-4.5 · READ-ONLY · xAI API
════════════════════════════════════════════════════════════════════════


──────── ROUND 1/3  (22:51:58) ────────
  • Path traversal         0 item(s) (0 confirmed/high) (37s)
  • Prototype pollution    0 item(s) (0 confirmed/high) (31s)
  • Injection              0 item(s) (0 confirmed/high) (91s)
  • SSRF / open-redirect   0 item(s) (0 confirmed/high) (64s)
  • ReDoS / resource DoS   0 item(s) (0 confirmed/high) (137s)
  • Authz / access-control 0 item(s) (0 confirmed/high) (49s)
  • Deserialization / parse 6 item(s) (2 confirmed/high) (58s)
  • Crypto / secrets       0 item(s) (0 confirmed/high) (80s)
  • Memory safety          0 item(s) (0 confirmed/high) (34s)
  • Supply-chain / privileged-action 0 item(s) (0 confirmed/high) (43s)
  ⚔ skeptic refuting 2 candidate finding(s)…
    ✗ REFUTED  CWE-400 apps/server-pilot/src/trpc/wire-compat.ts:29 — apps/server-pilot/src/trpc/routes/drafts.ts:278
    ✓ SURVIVES CWE-400 apps/server-pilot/src/mail/ingest/pop3-client.ts:283 — POP3 RETR body assembly has no per-message byte cap before full Buffer.concat
  round 1 summary: +1 confirmed, +4 leads, 1 refuted · totals: 1 confirmed / 4 open leads / 1 refuted

──────── ROUND 2/3  (22:58:53) ────────
  • Path traversal         0 item(s) (0 confirmed/high) (15s)
  • Injection              0 item(s) (0 confirmed/high) (48s)
  • Prototype pollution    0 item(s) (0 confirmed/high) (39s)
  • SSRF / open-redirect   0 item(s) (0 confirmed/high) (36s)
  • ReDoS / resource DoS   4 item(s) (1 confirmed/high) (45s)
  • Authz / access-control 0 item(s) (0 confirmed/high) (47s)
  • Deserialization / parse 4 item(s) (1 confirmed/high) (68s)
  • Crypto / secrets       0 item(s) (0 confirmed/high) (31s)
  • Memory safety          1 item(s) (1 confirmed/high) (58s)
  • Supply-chain / privileged-action 0 item(s) (0 confirmed/high) (56s)
  ⚔ skeptic refuting 1 candidate finding(s)…
    ✓ SURVIVES CWE-400 apps/server-pilot/src/lib/schemas.ts:102 — Settings save accepts unbounded strings into JSONB
  round 2 summary: +1 confirmed, +3 leads, 0 refuted · totals: 2 confirmed / 7 open leads / 1 refuted

──────── ROUND 3/3  (23:03:34) ────────

```


## cli-swarm stdout (tail)

_2026-07-09T23:07:37.038Z_

```

════════════════════════════════════════════════════════════════════════
  ⚡ CLI-SWARM — BYO-subscription collaborative zero-day swarm
  target:      C:\Users\gamin\Desktop\projs\emails hotels uis\zero
  squad:       10 agent(s) / 10 class(es) [--squad full] · effort=high
  plan:        up to 3 collaborative rounds · 2 parallel · budget 240min
  mode:        SWARM — specialists + shared board + adversarial refutation · model=grok-4.5 · READ-ONLY · xAI API
════════════════════════════════════════════════════════════════════════


──────── ROUND 1/3  (22:51:58) ────────
  • Path traversal         0 item(s) (0 confirmed/high) (37s)
  • Prototype pollution    0 item(s) (0 confirmed/high) (31s)
  • Injection              0 item(s) (0 confirmed/high) (91s)
  • SSRF / open-redirect   0 item(s) (0 confirmed/high) (64s)
  • ReDoS / resource DoS   0 item(s) (0 confirmed/high) (137s)
  • Authz / access-control 0 item(s) (0 confirmed/high) (49s)
  • Deserialization / parse 6 item(s) (2 confirmed/high) (58s)
  • Crypto / secrets       0 item(s) (0 confirmed/high) (80s)
  • Memory safety          0 item(s) (0 confirmed/high) (34s)
  • Supply-chain / privileged-action 0 item(s) (0 confirmed/high) (43s)
  ⚔ skeptic refuting 2 candidate finding(s)…
    ✗ REFUTED  CWE-400 apps/server-pilot/src/trpc/wire-compat.ts:29 — apps/server-pilot/src/trpc/routes/drafts.ts:278
    ✓ SURVIVES CWE-400 apps/server-pilot/src/mail/ingest/pop3-client.ts:283 — POP3 RETR body assembly has no per-message byte cap before full Buffer.concat
  round 1 summary: +1 confirmed, +4 leads, 1 refuted · totals: 1 confirmed / 4 open leads / 1 refuted

──────── ROUND 2/3  (22:58:53) ────────
  • Path traversal         0 item(s) (0 confirmed/high) (15s)
  • Injection              0 item(s) (0 confirmed/high) (48s)
  • Prototype pollution    0 item(s) (0 confirmed/high) (39s)
  • SSRF / open-redirect   0 item(s) (0 confirmed/high) (36s)
  • ReDoS / resource DoS   4 item(s) (1 confirmed/high) (45s)
  • Authz / access-control 0 item(s) (0 confirmed/high) (47s)
  • Deserialization / parse 4 item(s) (1 confirmed/high) (68s)
  • Crypto / secrets       0 item(s) (0 confirmed/high) (31s)
  • Memory safety          1 item(s) (1 confirmed/high) (58s)
  • Supply-chain / privileged-action 0 item(s) (0 confirmed/high) (56s)
  ⚔ skeptic refuting 1 candidate finding(s)…
    ✓ SURVIVES CWE-400 apps/server-pilot/src/lib/schemas.ts:102 — Settings save accepts unbounded strings into JSONB
  round 2 summary: +1 confirmed, +3 leads, 0 refuted · totals: 2 confirmed / 7 open leads / 1 refuted

──────── ROUND 3/3  (23:03:34) ────────
  • Path traversal         0 item(s) (0 confirmed/high) (28s)
  • Injection              0 item(s) (0 confirmed/high) (45s)
  • Prototype pollution    0 item(s) (0 confirmed/high) (27s)
  • SSRF / open-redirect   0 item(s) (0 confirmed/high) (30s)
  • Authz / access-control 0 item(s) (0 confirmed/high) (36s)
  ⚠ ReDoS / resource DoS   BACKEND rate-limited (usage limit) (83s)
  • Crypto / secrets       0 item(s) (0 confirmed/high) (22s)
  • Deserialization / parse 4 item(s) (1 confirmed/high) (61s)
  • Supply-chain / privileged-action 0 item(s) (0 confirmed/high) (22s)
  • Memory safety          0 item(s) (0 confirmed/high) (63s)
  ⚔ skeptic refuting 1 candidate finding(s)…
    ✓ SURVIVES CWE-400 apps/server-pilot/src/trpc/routes/settings.ts:52 — Settings JSONB merge embeds untrusted unbounded strings without size strip
  round 3 summary: +1 confirmed, +0 leads, 0 refuted · totals: 3 confirmed / 6 open leads / 1 refuted

──────── TRIAGE (23:07:26) — clustering 3 survivors by root cause + classifying ────────
  [LOW_VALUE/low] POP3 RETR body assembly accumulates full message into memory without a streaming/per-line byte cap; size is only checked after Buffer.concat returns (1 site(s)) — Real gap vs INGEST_MAX_MESSAGE_BYTES intent, but attacker must deliver huge mail to the operator-controlled POP3 mailbox; impact is self-DoS of the ingest worker, not multi-tenant unauthenticated RCE/data exposure.
  [LOW_VALUE/low] userSettingsSchema leaves string/array fields unbounded so authenticated settings.save can write large JSONB blobs (2 site(s)) — Same missing Zod max-length hardening at schema + privateProcedure save site; requires a valid session and only bloats that user's row / request body—operator auth-bound resource abuse, not a novel security boundary break.
  → 0 NOVEL_REAL of 2 root-cause cluster(s) from 3 raw survivors

════════════════════════════════════════════════════════════════════════
  🐝 SWARM COMPLETE — 15.6min · 3 round(s)
════════════════════════════════════════════════════════════════════════
  ✅ ZERO NOVEL findings — 3 raw survivors triaged down to 2 root cause(s), ALL by-design / known / low-value / duplicate.
     The swarm has high recall; the triage gate refused the overclaim. That honesty IS the result.
  ↓ 2 cluster(s) downgraded: LOW_VALUE×1, LOW_VALUE×2
  ⚠ PARTIAL COVERAGE — 1/30 specialist call(s) lost to rate-limiting; findings stand but coverage is incomplete (re-run for full sweep).
  ◷ 6 open lead(s) held for follow-up (unproven — NOT findings).
  ✗ 1 candidate(s) adversarially refuted and dropped (anti-fabrication working).
  📄 full audit transcript: bench\wild-hunt\swarm\swarm-zero-1783637518377.json


```


## Transcript JSON

_2026-07-09T23:07:37.051Z_

Path: `tools/t3mp3st/.vendor/T3MP3ST/bench/wild-hunt/swarm/swarm-zero-1783637518377.json`

```json
{
  "project": "zero",
  "commit": null,
  "mode": "swarm",
  "arm": "swarm",
  "skeptic": true,
  "backend": {
    "calls": 30,
    "fails": 1,
    "rateLimited": true
  },
  "model": "grok-4.5",
  "squad": [
    {
      "class": "injection",
      "count": 1,
      "effort": "high"
    },
    {
      "class": "path-traversal",
      "count": 1,
      "effort": "high"
    },
    {
      "class": "prototype-pollution",
      "count": 1,
      "effort": "high"
    },
    {
      "class": "redos-dos",
      "count": 1,
      "effort": "high"
    },
    {
      "class": "ssrf-redirect",
      "count": 1,
      "effort": "high"
    },
    {
      "class": "authz-bypass",
      "count": 1,
      "effort": "high"
    },
    {
      "class": "deserialization",
      "count": 1,
      "effort": "high"
    },
    {
      "class": "crypto-secrets",
      "count": 1,
      "effort": "high"
    },
    {
      "class": "memory-safety",
      "count": 1,
      "effort": "high"
    },
    {
      "class": "supply-chain",
      "count": 1,
      "effort": "high"
    }
  ],
  "squadReason": "--squad full",
  "runList": [
    {
      "class": "injection",
      "effort": "high"
    },
    {
      "class": "path-traversal",
      "effort": "high"
    },
    {
      "class": "prototype-pollution",
      "effort": "high"
    },
    {
      "class": "redos-dos",
      "effort": "high"
    },
    {
      "class": "ssrf-redirect",
      "effort": "high"
    },
    {
      "class": "authz-bypass",
      "effort": "high"
    },
    {
      "class": "deserialization",
      "effort": "high"
    },
    {
      "class": "crypto-secrets",
      "effort": "high"
    },
    {
      "class": "memory-safety",
      "effort": "high"
    },
    {
      "class": "supply-chain",
      "effort": "high"
    }
  ],
  "started": "2026-07-09T22:51:58.378Z",
  "rounds": [
    {
      "round": 1,
      "started": "2026-07-09T22:51:58.379Z",
      "specialists": [
        {
          "lens": "path-traversal",
          "n": 0,
          "secs": 37
        },
        {
          "lens": "prototype-pollution",
          "n": 0,
          "secs": 31
        },
        {
          "lens": "injection",
          "n": 0,
          "secs": 91
        },
        {
          "lens": "ssrf-redirect",
          "n": 0,
          "secs": 64
        },
        {
          "lens": "redos-dos",
          "n": 0,
          "secs": 137
        },
        {
          "lens": "authz-bypass",
          "n": 0,
          "secs": 49
        },
        {
          "lens": "deserialization",
          "n": 6,
          "secs": 58
        },
        {
          "lens": "crypto-secrets",
          "n": 0,
          "secs": 80
        },
        {
          "lens": "memory-safety",
          "n": 0,
          "secs": 34
        },
        {
          "lens": "supply-chain",
          "n": 0,
          "secs": 43
        }
      ],
      "newConfirmed": [
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "POP3 RETR body assembly has no per-message byte cap before full Buffer.concat",
          "file": "apps/server-pilot/src/mail/ingest/pop3-client.ts",
          "line": 283,
          "cwe": "CWE-400",
          "vuln_class": "length/bounds handling on parsed data",
          "severity": "medium",
          "confidence": "medium",
          "summary": "readRetrBody accumulates all RETR lines into memory without checking INGEST_MAX_MESSAGE_BYTES; size is only asserted later in parseRawMessage after the full message is already buffered (and after S3 PUT of raw in worker).",
          "reachability": "Hostile POP3 server or oversized mailbox message → RealPop3Client.readRetrBody → unbounded Buffer.concat → worker putObject + assertWithinIngestLimits. Limits exist but apply too late for client-side memory.",
          "sink": {
            "file": "apps/server-pilot/src/mail/ingest/pop3-client.ts",
            "line": 283
          },
          "exact_code": "private async readRetrBody(): Promise<Buffer> {\n    const parts: Buffer[] = [];\n    while (true) {\n      const line = await this.readLineBytes();\n      if (line.length === 1 && line[0] === 0x2e) {\n        break;\n      }\n      // ...\n      parts.push(bodyLine, Buffer.from('\\r\\n'));\n    }\n    return Buffer.concat(parts);\n  }",
          "refutation_attempted": "assertWithinIngestLimits is called in parseRawMessage and worker after RETR; SOCKET_TIMEOUT_MS bounds time but not size. No intermediate size check in readRetrBody.",
          "status": "confirmed",
          "lens": "deserialization"
        }
      ],
      "newLeads": [
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "Settings JSONB merge embeds untrusted input via JSON.stringify without strip/size bounds",
          "file": "apps/server-pilot/src/trpc/routes/settings.ts",
          "line": 52,
          "cwe": "CWE-502",
          "vuln_class": "unsafe JSON / config parse + type confusion on merge",
          "severity": "medium",
          "confidence": "medium",
          "summary": "settings.save validates only known keys via zod.partial, but the conflict path re-serializes the same input object into a JSONB `||` merge; zod does not .strict() so unknown keys (and nested category/prompt bulk) can still reach the merge depending on superjson/tRPC parse path, and no max length is enforced on free-form strings stored as JSONB.",
          "reachability": "Authenticated tRPC POST /api/trpc/settings.save → superjson deserialize body → settingsSaveInput (userSettingsSchema.partial) → JSON.stringify(input)::jsonb || existing settings in Postgres. Needs proving whether superjson+zod strip unknown keys before stringify; if stripped, residual issue is unbounded customPrompt/trustedSenders/categories payload size (DoS).",
          "sink": {
            "file": "apps/server-pilot/src/trpc/routes/settings.ts",
            "line": 52
          },
          "exact_code": "settings: sql`coalesce(${userSettings.settings}, ${JSON.stringify(defaultUserSettings)}::jsonb) || ${JSON.stringify(input)}::jsonb`,",
          "refutation_attempted": "Looked for .strict()/strip on userSettingsSchema and size caps on customPrompt/categories — none. Zod default object behavior strips unknown keys on parse, so prototype-pollution-style extra keys are likely dropped before stringify; remaining risk is large validated strings/arrays and partial schema allowing partial-key overwrite of security-adjacent prefs (externalImages, trustedSenders). Not confirmed RCE; more integrity/DoS.",
          "status": "lead",
          "lens": "deserialization"
        },
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "deserializeFiles base64 decode has no size guard (server-side helper)",
          "file": "apps/server-pilot/src/lib/schemas.ts",
          "line": 11,
          "cwe": "CWE-400",
          "vuln_class": "length/bounds handling on parsed data",
          "severity": "low",
          "confidence": "medium",
          "summary": "deserializeFiles Buffer.from(base64) with no max size; currently only a library helper — confirm whether any live route still calls it on user input.",
          "reachability": "If any procedure still maps client serializedFileSchema attachments through deserializeFiles, attacker-controlled base64 → Buffer allocation. Grep shows definition only; send/draft routes accept attachments but do not call this helper yet — lead for when wiring is completed.",
          "sink": {
            "file": "apps/server-pilot/src/lib/schemas.ts",
            "line": 11
          },
          "exact_code": "export const deserializeFiles = async (\n  serializedFiles: z.infer<typeof serializedFileSchema>[],\n): Promise<File[]> => {\n  return await Promise.all(\n    serializedFiles.map((data) => {\n      const buf = Buffer.from(data.base64, 'base64');\n",
          "refutation_attempted": "Grep for call sites of deserializeFiles under server-pilot/src — only definition. Not currently reachable as a sink; keep as wiring lead.",
          "status": "lead",
          "lens": "deserialization"
        },
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "X-Zero-Mailbox last-wins header parse is deliberate but depends on trusted last stamp",
          "file": "apps/server-pilot/src/mail/ingest/parse-message.ts",
          "line": 202,
          "cwe": "CWE-290",
          "vuln_class": "duplicate-parameter / interpretation-conflict smuggling",
          "severity": "medium",
          "confidence": "low",
          "summary": "owner routing uses lastHeader('x-zero-mailbox') so forged earlier values lose to the last occurrence; if a message can be delivered with a trailing attacker-controlled X-Zero-Mailbox after the relay stamp, routing could be redirected to another mailbox transport.",
          "reachability": "External mail → POP3 RETR → parseRawMessage → lastHeader x-zero-mailbox → store.persistInboundMessage mailboxTransport lookup by ownerHeaderValue. Needs proving whether the real MTA/relay always appends the trusted stamp last and strips client-supplied copies; fixture loopback injects the header from server-controlled transportEmail only.",
          "sink": {
            "file": "apps/server-pilot/src/mail/ingest/parse-message.ts",
            "line": 202
          },
          "exact_code": "const ownerHeaderValue = lastHeader(headers, 'x-zero-mailbox');\n// ...\n/** Last non-empty occurrence — trusted relay stamp wins over forged earlier values. */\nfunction lastHeader(headers: Headers, name: string): string | null {",
          "refutation_attempted": "Code comments document last-wins as intentional for trusted relay. Direct-To fallback + quarantine paths exist when header missing/unknown. Without MTA config in-repo cannot confirm stamp ordering — leave as lead.",
          "status": "lead",
          "lens": "deserialization"
        },
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "tRPC allowMethodOverride enables GET-based mutations with query-string payloads",
          "file": "apps/server-pilot/src/main.ts",
          "line": 73,
          "cwe": "CWE-352",
          "vuln_class": "content-type / method interpretation conflict",
          "severity": "low",
          "confidence": "low",
          "summary": "fetchRequestHandler is configured with allowMethodOverride: true, so mutation procedures may be invoked via GET with input in the query string if clients send the override header — expands CSRF/cache-smuggling surface relative to POST-only.",
          "reachability": "Browser or intermediary → GET /api/trpc/<mutation>?input=... with tRPC method override → procedure runs if session cookie present. Needs browser SameSite cookie policy and Better Auth cookie flags to assess real CSRF.",
          "sink": {
            "file": "apps/server-pilot/src/main.ts",
            "line": 73
          },
          "exact_code": "app.on(['GET', 'POST'], '/api/trpc/*', (c) =>\n  fetchRequestHandler({\n    endpoint: '/api/trpc',\n    router: appRouter,\n    req: c.req.raw,\n    allowMethodOverride: true,",
          "refutation_attempted": "Better Auth session cookies typically SameSite=Lax which blocks cross-site GET with cookies from third-party sites for top-level navigations in some cases but not all CSRF patterns; not fully refuted. Specialty-adjacent.",
          "status": "lead",
          "lens": "deserialization"
        }
      ],
      "refuted": [
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "Outbound send accepts unbounded base64 attachments in schema but never bounds size",
          "file": "apps/server-pilot/src/trpc/wire-compat.ts",
          "line": 29,
          "cwe": "CWE-400",
          "vuln_class": "length/bounds handling on parsed data",
          "severity": "medium",
          "confidence": "high",
          "summary": "serializedAttachmentInput allows arbitrary-length base64 strings with only z.string()/z.number() and no max; sendInput/createDraftInput accept unlimited attachment arrays, enabling memory exhaustion on superjson parse of the tRPC body before any business logic.",
          "reachability": "Authenticated mailbox user → tRPC mail.send / drafts.create with huge attachments[].base64 → superjson + zod parse allocates full payload in process memory → (send path currently ignores attachments when calling SMTP, but parse still holds them).",
          "sink": {
            "file": "apps/server-pilot/src/trpc/wire-compat.ts",
            "line": 29
          },
          "exact_code": "const serializedAttachmentInput = z.object({\n  name: z.string(),\n  type: z.string(),\n  size: z.number(),\n  lastModified: z.number(),\n  base64: z.string(),\n});",
          "refutation_attempted": "Searched for max() on base64/size/array length and body size limits on Hono/tRPC — none in apps/server-pilot/src. Ingest path has INGEST_MAX_* limits; outbound API does not.",
          "status": "confirmed",
          "lens": "deserialization",
          "reason": "The claimed DoS is not caused by missing zod bounds on base64. tRPC order is HTTP body buffer → superjson JSON.parse → then zod; z.string().max() would run only after the full payload is already in memory, so schema bounds cannot prevent the stated superjson/parse exhaustion. Attachments are also dead fields: mail.send never passes them to SMTP/DB, and drafts.create hardcodes attachments: [] and ignores input.attachments—no decode, store, or re-encode amplification. Same memory cost applies to any unbounded string field (html/message/text) on any mutation; this is not an attachment-schema exploit.",
          "guard_found": "apps/server-pilot/src/trpc/routes/drafts.ts:278"
        }
      ],
      "outOfScope": 0
    },
    {
      "round": 2,
      "started": "2026-07-09T22:58:53.828Z",
      "specialists": [
        {
          "lens": "path-traversal",
          "n": 0,
          "secs": 15
        },
        {
          "lens": "injection",
          "n": 0,
          "secs": 48
        },
        {
          "lens": "prototype-pollution",
          "n": 0,
          "secs": 39
        },
        {
          "lens": "ssrf-redirect",
          "n": 0,
          "secs": 36
        },
        {
          "lens": "redos-dos",
          "n": 4,
          "secs": 45
        },
        {
          "lens": "authz-bypass",
          "n": 0,
          "secs": 47
        },
        {
          "lens": "deserialization",
          "n": 4,
          "secs": 68
        },
        {
          "lens": "crypto-secrets",
          "n": 0,
          "secs": 31
        },
        {
          "lens": "memory-safety",
          "n": 1,
          "secs": 58
        },
        {
          "lens": "supply-chain",
          "n": 0,
          "secs": 56
        }
      ],
      "newConfirmed": [
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "Settings save accepts unbounded strings into JSONB",
          "file": "apps/server-pilot/src/lib/schemas.ts",
          "line": 102,
          "cwe": "CWE-400",
          "vuln_class": "bounds handling on parsed JSON",
          "severity": "medium",
          "confidence": "high",
          "summary": "userSettingsSchema uses unbounded z.string()/arrays, so authenticated settings.save can persist multi‑MB customPrompt/trustedSenders/categories into user_settings.settings JSONB and re-serve them on get.",
          "reachability": "Authenticated tRPC POST /api/trpc/settings.save → superjson body → settingsSaveInput (userSettingsSchema.partial) with no .max() → insert/onConflictDoUpdate stores input in JSONB (settings.ts:47–52) → settings.get returns full blob",
          "sink": {
            "file": "apps/server-pilot/src/lib/schemas.ts",
            "line": 102
          },
          "exact_code": "export const userSettingsSchema = z.object({\n  language: z.string(),\n  timezone: z.string(),\n  ...\n  customPrompt: z.string().default(''),\n  trustedSenders: z.string().array().optional(),\n  ...\n  categories: categoriesSchema.optional(),\n  defaultEmailAlias: z.string().optional(),\n});",
          "refutation_attempted": "Looked for .max()/.length limits on customPrompt/trustedSenders/categories and for request body size limits in main.ts/Hono; none found. Zod strips unknown keys (not passthrough), and drizzle sql`${JSON.stringify(input)}::jsonb` is parameterized so this is not SQLi/CWE-502 RCE—only missing size bounds.",
          "status": "confirmed",
          "lens": "deserialization"
        }
      ],
      "newLeads": [
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "Settings save accepts unbounded string fields and JSONB-merges without size strip",
          "file": "apps/server-pilot/src/trpc/routes/settings.ts",
          "line": 52,
          "cwe": "CWE-400",
          "vuln_class": "unbounded allocation / resource DoS",
          "severity": "medium",
          "confidence": "medium",
          "summary": "settingsSaveInput is userSettingsSchema.partial() with unbounded z.string()/z.array fields; JSON.stringify(input) is embedded into a JSONB merge with no size or length guard.",
          "reachability": "Authenticated tRPC POST /api/trpc/settings.save → superjson body → settingsSaveInput (no .max on customPrompt/language/timezone/trustedSenders/categories) → SQL coalesce(...) || JSON.stringify(input)::jsonb",
          "sink": {
            "file": "apps/server-pilot/src/trpc/routes/settings.ts",
            "line": 52
          },
          "exact_code": "settings: sql`coalesce(${userSettings.settings}, ${JSON.stringify(defaultUserSettings)}::jsonb) || ${JSON.stringify(input)}::jsonb`,",
          "refutation_attempted": "Checked userSettingsSchema for .max()/.length bounds — none on customPrompt, language, timezone, trustedSenders, or categories array size. No Hono/tRPC body size limit in main.ts. Needs proof that superjson/HTTP stack does not cap body independently; still a real lead for auth'd DoS.",
          "status": "lead",
          "lens": "redos-dos"
        },
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "processEmailContent sanitizes unbounded attacker-controlled HTML",
          "file": "apps/server-pilot/src/trpc/routes/mail.ts",
          "line": 1095,
          "cwe": "CWE-400",
          "vuln_class": "unbounded allocation / resource DoS",
          "severity": "medium",
          "confidence": "medium",
          "summary": "mail.processEmailContent accepts z.string() HTML with no max length and runs sanitize-html on it, enabling large-input CPU/memory pressure per request.",
          "reachability": "Authenticated mailbox tRPC mutation processEmailContent → input.html (unbounded z.string()) → sanitizeEmailHtml → sanitize-html parse/transform",
          "sink": {
            "file": "apps/server-pilot/src/trpc/routes/mail.ts",
            "line": 1095
          },
          "exact_code": "processEmailContent: mailboxProcedure\n    .input(\n      z.object({\n        html: z.string(),\n        shouldLoadImages: z.boolean().default(false),\n        theme: z.enum(['light', 'dark']).default('light'),\n      }),\n    )\n    .mutation(async ({ input }) => {\n      const result = sanitizeEmailHtml(input.html, {\n        shouldLoadImages: input.shouldLoadImages,\n      });",
          "refutation_attempted": "No z.string().max on html; main.ts has no explicit body size limit. Auth required (mailboxProcedure) so not anonymous, but a single large HTML body still burns CPU/RAM. Needs measurement of sanitize-html cost vs practical request body limits.",
          "status": "lead",
          "lens": "redos-dos"
        },
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "X-Zero-Mailbox last-wins routing trusts unauthenticated header order",
          "file": "apps/server-pilot/src/mail/ingest/parse-message.ts",
          "line": 251,
          "cwe": "CWE-290",
          "vuln_class": "header interpretation conflict / spoofing",
          "severity": "low",
          "confidence": "low",
          "summary": "Inbound routing uses lastHeader('x-zero-mailbox'); if the POP3 feed does not re-stamp a trusted value last, an external sender can choose which mailboxTransport receives the message.",
          "reachability": "External SMTP → shared POP3 RETR → parseRawMessage → lastHeader x-zero-mailbox → store.persistInboundMessage eq(mailboxTransport.ownerHeaderValue) → insert into chosen tenant mailbox",
          "sink": {
            "file": "apps/server-pilot/src/mail/ingest/parse-message.ts",
            "line": 251
          },
          "exact_code": "/** Last non-empty occurrence — trusted relay stamp wins over forged earlier values. */\nfunction lastHeader(headers: Headers, name: string): string | null {\n  const v = headers.get(name);\n  if (!v) return null;\n  const values = Array.isArray(v) ? v : [v];\n  for (let i = values.length - 1; i >= 0; i--) {\n    const s = values[i];\n    if (typeof s === 'string' && s.trim()) return s.trim();\n  }\n  return null;\n}",
          "refutation_attempted": "Design comment claims trusted relay stamp wins; missing_owner_header path falls back to To-address match + spam. Still needs proof production MTA/POP3 always appends a trusted X-Zero-Mailbox after any client-supplied copies; no re-stamp found in pilot ingest code.",
          "status": "lead",
          "lens": "deserialization"
        }
      ],
      "refuted": [],
      "outOfScope": 0
    },
    {
      "round": 3,
      "started": "2026-07-09T23:03:34.477Z",
      "specialists": [
        {
          "lens": "path-traversal",
          "n": 0,
          "secs": 28
        },
        {
          "lens": "injection",
          "n": 0,
          "secs": 45
        },
        {
          "lens": "prototype-pollution",
          "n": 0,
          "secs": 27
        },
        {
          "lens": "ssrf-redirect",
          "n": 0,
          "secs": 30
        },
        {
          "lens": "authz-bypass",
          "n": 0,
          "secs": 36
        },
        {
          "lens": "crypto-secrets",
          "n": 0,
          "secs": 22
        },
        {
          "lens": "deserialization",
          "n": 4,
          "secs": 61
        },
        {
          "lens": "supply-chain",
          "n": 0,
          "secs": 22
        },
        {
          "lens": "memory-safety",
          "n": 0,
          "secs": 63
        }
      ],
      "newConfirmed": [
        {
          "project": "zero",
          "commit": null,
          "found_by": "cli-hunt/swarm",
          "title": "Settings JSONB merge embeds untrusted unbounded strings without size strip",
          "file": "apps/server-pilot/src/trpc/routes/settings.ts",
          "line": 52,
          "cwe": "CWE-400",
          "vuln_class": "unbounded parse / JSONB merge",
          "severity": "medium",
          "confidence": "high",
          "summary": "settings.save accepts userSettingsSchema.partial() with unbounded z.string() fields (customPrompt, language, timezone, trustedSenders[], categories[].name/searchValue) then JSON.stringify(input) into a Postgres JSONB merge with no max length, array cap, or body-size guard.",
          "reachability": "Authenticated tRPC POST /api/trpc/settings.save → superjson body → settingsSaveInput (no .max on customPrompt/language/timezone/trustedSenders/categories) → JSON.stringify(input)::jsonb || merge into user_settings.settings",
          "sink": {
            "file": "apps/server-pilot/src/trpc/routes/settings.ts",
            "line": 52
          },
          "exact_code": "settings: sql`coalesce(${userSettings.settings}, ${JSON.stringify(defaultUserSettings)}::jsonb) || ${JSON.stringify(input)}::jsonb`,\n// schemas: language: z.string(), timezone: z.string(), customPrompt: z.string().default(''), trustedSenders: z.string().array().optional()",
          "refutation_attempted": "Looked for .max()/.min() on userSettingsSchema string/array fields, Hono bodyLimit, tRPC middleware size cap, and post-parse strip — none exist. Auth (privateProcedure) only limits who can write their own row; a single authenticated caller can still store multi-MB JSONB and grow the row without bound. JSON.stringify of zod-validated plain objects does not reintroduce prototypes, so this is DoS/storage, not CWE-502 RCE.",
          "status": "confirmed",
          "lens": "deserialization"
        }
      ],
      "newLeads": [],
      "refuted": [],
      "outOfScope": 0
    }
  ],
  "triage": {
    "clusters": [
      {
        "root_cause": "POP3 RETR body assembly accumulates full message into memory without a streaming/per-line byte cap; size is only checked after Buffer.concat returns",
        "members": [
          "apps/server-pilot/src/mail/ingest/pop3-client.ts:283"
        ],
        "classification": "LOW_VALUE",
        "severity": "low",
        "why": "Real gap vs INGEST_MAX_MESSAGE_BYTES intent, but attacker must deliver huge mail to the operator-controlled POP3 mailbox; impact is self-DoS of the ingest worker, not multi-tenant unauthenticated RCE/data exposure."
      },
      {
        "root_cause": "userSettingsSchema leaves string/array fields unbounded so authenticated settings.save can write large JSONB blobs",
        "members": [
          "apps/server-pilot/src/lib/schemas.ts:102",
          "apps/server-pilot/src/trpc/routes/settings.ts:52"
        ],
        "classification": "LOW_VALUE",
        "severity": "low",
        "why": "Same missing Zod max-length hardening at schema + privateProcedure save site; requires a valid session and only bloats that user's row / request body—operator auth-bound resource abuse, not a novel security boundary break."
      }
    ],
    "novel_real": 0,
    "summary": "Both surviving CWE-400 items are real missing caps but only LOW_VALUE hardening (auth-bound settings bloat; POP3 self-DoS after the message is already accepted by the mail server)—zero novel disclosable vulns."
  },
  "finished": "2026-07-09T23:07:36.996Z",
  "elapsed_min": 15.6,
  "confirmed": [
    {
      "project": "zero",
      "commit": null,
      "found_by": "cli-hunt/swarm",
      "title": "POP3 RETR body assembly has no per-message byte cap before full Buffer.concat",
      "file": "apps/server-pilot/src/mail/ingest/pop3-client.ts",
      "line": 283,
      "cwe": "CWE-400",
      "vuln_class": "length/bounds handling on parsed data",
      "severity": "medium",
      "confidence": "medium",
      "summary": "readRetrBody accumulates all RETR lines into memory without checking INGEST_MAX_MESSAGE_BYTES; size is only asserted later in parseRawMessage after the full message is already buffered (and after S3 PUT of raw in worker).",
      "reachability": "Hostile POP3 server or oversized mailbox message → RealPop3Client.readRetrBody → unbounded Buffer.concat → worker putObject + assertWithinIngestLimits. Limits exist but apply too late for client-side memory.",
      "sink": {
        "file": "apps/server-pilot/src/mail/ingest/pop3-client.ts",
        "line": 283
      },
      "exact_code": "private async readRetrBody(): Promise<Buffer> {\n    const parts: Buffer[] = [];\n    while (true) {\n      const line = await this.readLineBytes();\n      if (line.length === 1 && line[0] === 0x2e) {\n        break;\n      }\n      // ...\n      parts.push(bodyLine, Buffer.from('\\r\\n'));\n    }\n    return Buffer.concat(parts);\n  }",
      "refutation_attempted": "assertWithinIngestLimits is called in parseRawMessage and worker after RETR; SOCKET_TIMEOUT_MS bounds time but not size. No intermediate size check in readRetrBody.",
      "status": "confirmed",
      "lens": "deserialization"
    },
    {
      "project": "zero",
      "commit": null,
      "found_by": "cli-hunt/swarm",
      "title": "Settings save accepts unbounded strings into JSONB",
      "file": "apps/server-pilot/src/lib/schemas.ts",
      "line": 102,
      "cwe": "CWE-400",
      "vuln_class": "bounds handling on parsed JSON",
      "severity": "medium",
      "confidence": "high",
      "summary": "userSettingsSchema uses unbounded z.string()/arrays, so authenticated settings.save can persist multi‑MB customPrompt/trustedSenders/categories into user_settings.settings JSONB and re-serve them on get.",
      "reachability": "Authenticated tRPC POST /api/trpc/settings.save → superjson body → settingsSaveInput (userSettingsSchema.partial) with no .max() → insert/onConflictDoUpdate stores input in JSONB (settings.ts:47–52) → settings.get returns full blob",
      "sink": {
        "file": "apps/server-pilot/src/lib/schemas.ts",
        "line": 102
      },
      "exact_code": "export const userSettingsSchema = z.object({\n  language: z.string(),\n  timezone: z.string(),\n  ...\n  customPrompt: z.string().default(''),\n  trustedSenders: z.string().array().optional(),\n  ...\n  categories: categoriesSchema.optional(),\n  defaultEmailAlias: z.string().optional(),\n});",
      "refutation_attempted": "Looked for .max()/.length limits on customPrompt/trustedSenders/categories and for request body size limits in main.ts/Hono; none found. Zod strips unknown keys (not passthrough), and drizzle sql`${JSON.stringify(input)}::jsonb` is parameterized so this is not SQLi/CWE-502 RCE—only missing size bounds.",
      "status": "confirmed",
      "lens": "deserialization"
    },
    {
      "project": "zero",
      "commit": null,
      "found_by": "cli-hunt/swarm",
      "title": "Settings JSONB merge embeds untrusted unbounded strings without size strip",
      "file": "apps/server-pilot/src/trpc/routes/settings.ts",
      "line": 52,
      "cwe": "CWE-400",
      "vuln_class": "unbounded parse / JSONB merge",
      "severity": "medium",
      "confidence": "high",
      "summary": "settings.save accepts userSettingsSchema.partial() with unbounded z.string() fields (customPrompt, language, timezone, trustedSenders[], categories[].name/searchValue) then JSON.stringify(input) into a Postgres JSONB merge with no max length, array cap, or body-size guard.",
      "reachability": "Authenticated tRPC POST /api/trpc/settings.save → superjson body → settingsSaveInput (no .max on customPrompt/language/timezone/trustedSenders/categories) → JSON.stringify(input)::jsonb || merge into user_settings.settings",
      "sink": {
        "file": "apps/server-pilot/src/trpc/routes/settings.ts",
        "line": 52
      },
      "exact_code": "settings: sql`coalesce(${userSettings.settings}, ${JSON.stringify(defaultUserSettings)}::jsonb) || ${JSON.stringify(input)}::jsonb`,\n// schemas: language: z.string(), timezone: z.string(), customPrompt: z.string().default(''), trustedSenders: z.string().array().optional()",
      "refutation_attempted": "Looked for .max()/.min() on userSettingsSchema string/array fields, Hono bodyLimit, tRPC middleware size cap, and post-parse strip — none exist. Auth (privateProcedure) only limits who can write their own row; a single authenticated caller can still store multi-MB JSONB and grow the row without bound. JSON.stringify of zod-validated plain objects does not reintroduce prototypes, so this is DoS/storage, not CWE-502 RCE.",
      "status": "confirmed",
      "lens": "deserialization"
    }
  ],
  "open_leads": [
    {
      "project": "zero",
      "commit": null,
      "found_by": "cli-hunt/swarm",
      "title": "Settings JSONB merge embeds untrusted input via JSON.stringify without strip/size bounds",
      "file": "apps/server-pilot/src/trpc/routes/settings.ts",
      "line": 52,
      "cwe": "CWE-502",
      "vuln_class": "unsafe JSON / config parse + type confusion on merge",
      "severity": "medium",
      "confidence": "medium",
      "summary": "settings.save validates only known keys via zod.partial, but the conflict path re-serializes the same input object into a JSONB `||` merge; zod does not .strict() so unknown keys (and nested category/prompt bulk) can still reach the merge depending on superjson/tRPC parse path, and no max length is enforced on free-form strings stored as JSONB.",
      "reachability": "Authenticated tRPC POST /api/trpc/settings.save → superjson deserialize body → settingsSaveInput (userSettingsSchema.partial) → JSON.stringify(input)::jsonb || existing settings in Postgres. Needs proving whether superjson+zod strip unknown keys before stringify; if stripped, residual issue is unbounded customPrompt/trustedSenders/categories payload size (DoS).",
      "sink": {
        "file": "apps/server-pilot/src/trpc/routes/settings.ts",
        "line": 52
      },
      "exact_code": "settings: sql`coalesce(${userSettings.settings}, ${JSON.stringify(defaultUserSettings)}::jsonb) || ${JSON.stringify(input)}::jsonb`,",
      "refutation_attempted": "Looked for .strict()/strip on userSettingsSchema and size caps on customPrompt/categories — none. Zod default object behavior strips unknown keys on parse, so prototype-pollution-style extra keys are likely dropped before stringify; remaining risk is large validated strings/arrays and partial schema allowing partial-key overwrite of security-adjacent prefs (externalImages, trustedSenders). Not confirmed RCE; more integrity/DoS.",
      "status": "lead",
      "lens": "deserialization"
    },
    {
      "project": "zero",
      "commit": null,
      "found_by": "cli-hunt/swarm",
      "title": "deserializeFiles base64 decode has no size guard (server-side helper)",
      "file": "apps/server-pilot/src/lib/schemas.ts",
      "line": 11,
      "cwe": "CWE-400",
      "vuln_class": "length/bounds handling on parsed data",
      "severity": "low",
      "confidence": "medium",
      "summary": "deserializeFiles Buffer.from(base64) with no max size; currently only a library helper — confirm whether any live route still calls it on user input.",
      "reachability": "If any procedure still maps client serializedFileSchema attachments through deserializeFiles, attacker-controlled base64 → Buffer allocation. Grep shows definition only; send/draft routes accept attachments but do not call this helper yet — lead for when wiring is completed.",
      "sink": {
        "file": "apps/server-pilot/src/lib/schemas.ts",
        "line": 11
      },
      "exact_code": "export const deserializeFiles = async (\n  serializedFiles: z.infer<typeof serializedFileSchema>[],\n): Promise<File[]> => {\n  return await Promise.all(\n    serializedFiles.map((data) => {\n      const buf = Buffer.from(data.base64, 'base64');\n",
      "refutation_attempted": "Grep for call sites of deserializeFiles under server-pilot/src — only definition. Not currently reachable as a sink; keep as wiring lead.",
      "status": "lead",
      "lens": "deserialization"
    },
    {
      "project": "zero",
      "commit": null,
      "found_by": "cli-hunt/swarm",
      "title": "X-Zero-Mailbox last-wins header parse is deliberate but depends on trusted last stamp",
      "file": "apps/server-pilot/src/mail/ingest/parse-message.ts",
      "line": 202,
      "cwe": "CWE-290",
      "vuln_class": "duplicate-parameter / interpretation-conflict smuggling",
      "severity": "medium",
      "confidence": "low",
      "summary": "owner routing uses lastHeader('x-zero-mailbox') so forged earlier values lose to the last occurrence; if a message can be delivered with a trailing attacker-controlled X-Zero-Mailbox after the relay stamp, routing could be redirected to another mailbox transport.",
      "reachability": "External mail → POP3 RETR → parseRawMessage → lastHeader x-zero-mailbox → store.persistInboundMessage mailboxTransport lookup by ownerHeaderValue. Needs proving whether the real MTA/relay always appends the trusted stamp last and strips client-supplied copies; fixture loopback injects the header from server-controlled transportEmail only.",
      "sink": {
        "file": "apps/server-pilot/src/mail/ingest/parse-message.ts",
        "line": 202
      },
      "exact_code": "const ownerHeaderValue = lastHeader(headers, 'x-zero-mailbox');\n// ...\n/** Last non-empty occurrence — trusted relay stamp wins over forged earlier values. */\nfunction lastHeader(headers: Headers, name: string): string | null {",
      "refutation_attempted": "Code comments document last-wins as intentional for trusted relay. Direct-To fallback + quarantine paths exist when header missing/unknown. Without MTA config in-repo cannot confirm stamp ordering — leave as lead.",
      "status": "lead",
      "lens": "deserialization"
    },
    {
      "project": "zero",
      "commit": null,
      "found_by": "cli-hunt/swarm",
      "title": "tRPC allowMethodOverride enables GET-based mutations with query-string payloads",
      "file": "apps/server-pilot/src/main.ts",
      "line": 73,
      "cwe": "CWE-352",
      "vuln_class": "content-type / method interpretation conflict",
      "severity": "low",
      "confidence": "low",
      "summary": "fetchRequestHandler is configured with allowMethodOverride: true, so mutation procedures may be invoked via GET with input in the query string if clients send the override header — expands CSRF/cache-smuggling surface relative to POST-only.",
      "reachability": "Browser or intermediary → GET /api/trpc/<mutation>?input=... with tRPC method override → procedure runs if session cookie present. Needs browser SameSite cookie policy and Better Auth cookie flags to assess real CSRF.",
      "sink": {
        "file": "apps/server-pilot/src/main.ts",
        "line": 73
      },
      "exact_code": "app.on(['GET', 'POST'], '/api/trpc/*', (c) =>\n  fetchRequestHandler({\n    endpoint: '/api/trpc',\n    router: appRouter,\n    req: c.req.raw,\n    allowMethodOverride: true,",
      "refutation_attempted": "Better Auth session cookies typically SameSite=Lax which blocks cross-site GET with cookies from third-party sites for top-level navigations in some cases but not all CSRF patterns; not fully refuted. Specialty-adjacent.",
      "status": "lead",
      "lens": "deserialization"
    },
    {
      "project": "zero",
      "commit": null,
      "found_by": "cli-hunt/swarm",
      "title": "processEmailContent sanitizes unbounded attacker-controlled HTML",
      "file": "apps/server-pilot/src/trpc/routes/mail.ts",
      "line": 1095,
      "cwe": "CWE-400",
      "vuln_class": "unbounded allocation / resource DoS",
      "severity": "medium",
      "confidence": "medium",
      "summary": "mail.processEmailContent accepts z.string() HTML with no max length and runs sanitize-html on it, enabling large-input CPU/memory pressure per request.",
      "reachability": "Authenticated mailbox tRPC mutation processEmailContent → input.html (unbounded z.string()) → sanitizeEmailHtml → sanitize-html parse/transform",
      "sink": {
        "file": "apps/server-pilot/src/trpc/routes/mail.ts",
        "line": 1095
      },
      "exact_code": "processEmailContent: mailboxProcedure\n    .input(\n      z.object({\n        html: z.string(),\n        shouldLoadImages: z.boolean().default(false),\n        theme: z.enum(['light', 'dark']).default('light'),\n      }),\n    )\n    .mutation(async ({ input }) => {\n      const result = sanitizeEmailHtml(input.html, {\n        shouldLoadImages: input.shouldLoadImages,\n      });",
      "refutation_attempted": "No z.string().max on html; main.ts has no explicit body size limit. Auth required (mailboxProcedure) so not anonymous, but a single large HTML body still burns CPU/RAM. Needs measurement of sanitize-html cost vs practical request body limits.",
      "status": "lead",
      "lens": "redos-dos"
    },
    {
      "project": "zero",
      "commit": null,
      "found_by": "cli-hunt/swarm",
      "title": "X-Zero-Mailbox last-wins routing trusts unauthenticated header order",
      "file": "apps/server-pilot/src/mail/ingest/parse-message.ts",
      "line": 251,
      "cwe": "CWE-290",
      "vuln_class": "header interpretation conflict / spoofing",
      "severity": "low",
      "confidence": "low",
      "summary": "Inbound routing uses lastHeader('x-zero-mailbox'); if the POP3 feed does not re-stamp a trusted value last, an external sender can choose which mailboxTransport receives the message.",
      "reachability": "External SMTP → shared POP3 RETR → parseRawMessage → lastHeader x-zero-mailbox → store.persistInboundMessage eq(mailboxTransport.ownerHeaderValue) → insert into chosen tenant mailbox",
      "sink": {
        "file": "apps/server-pilot/src/mail/ingest/parse-message.ts",
        "line": 251
      },
      "exact_code": "/** Last non-empty occurrence — trusted relay stamp wins over forged earlier values. */\nfunction lastHeader(headers: Headers, name: string): string | null {\n  const v = headers.get(name);\n  if (!v) return null;\n  const values = Array.isArray(v) ? v : [v];\n  for (let i = values.length - 1; i >= 0; i--) {\n    const s = values[i];\n    if (typeof s === 'string' && s.trim()) return s.trim();\n  }\n  return null;\n}",
      "refutation_attempted": "Design comment claims trusted relay stamp wins; missing_owner_header path falls back to To-address match + spam. Still needs proof production MTA/POP3 always appends a trusted X-Zero-Mailbox after any client-supplied copies; no re-stamp found in pilot ingest code.",
      "status": "lead",
      "lens": "deserialization"
    }
  ],
  "refuted": [
    {
      "project": "zero",
      "commit": null,
      "found_by": "cli-hunt/swarm",
      "title": "Outbound send accepts unbounded base64 attachments in schema but never bounds size",
      "file": "apps/server-pilot/src/trpc/wire-compat.ts",
      "line": 29,
      "cwe": "CWE-400",
      "vuln_class": "length/bounds handling on parsed data",
      "severity": "medium",
      "confidence": "high",
      "summary": "serializedAttachmentInput allows arbitrary-length base64 strings with only z.string()/z.number() and no max; sendInput/createDraftInput accept unlimited attachment arrays, enabling memory exhaustion on superjson parse of the tRPC body before any business logic.",
      "reachability": "Authenticated mailbox user → tRPC mail.send / drafts.create with huge attachments[].base64 → superjson + zod parse allocates full payload in process memory → (send path currently ignores attachments when calling SMTP, but parse still holds them).",
      "sink": {
        "file": "apps/server-pilot/src/trpc/wire-compat.ts",
        "line": 29
      },
      "exact_code": "const serializedAttachmentInput = z.object({\n  name: z.string(),\n  type: z.string(),\n  size: z.number(),\n  lastModified: z.number(),\n  base64: z.string(),\n});",
      "refutation_attempted": "Searched for max() on base64/size/array length and body size limits on Hono/tRPC — none in apps/server-pilot/src. Ingest path has INGEST_MAX_* limits; outbound API does not.",
      "status": "confirmed",
      "lens": "deserialization",
      "reason": "The claimed DoS is not caused by missing zod bounds on base64. tRPC order is HTTP body buffer → superjson JSON.parse → then zod; z.string().max() would run only after the full payload is already in memory, so schema bounds cannot prevent the stated superjson/parse exhaustion. Attachments are also dead fields: mail.send never passes them to SMTP/DB, and drafts.create hardcodes attachments: [] and ignores input.attachments—no decode, store, or re-encode amplification. Same memory cost applies to any unbounded string field (html/message/text) on any mutation; this is not an attachment-schema exploit.",
      "guard_found": "apps/server-pilot/src/trpc/routes/drafts.ts:278"
    }
  ],
  "verdict": "FINDINGS"
}
```


## Run complete

_2026-07-09T23:07:37.056Z_

- cli-swarm exit code: 0
- T3MP3ST ran audit; no production code modified
- Review transcript + sections above


## Deep pass note

_2026-07-09T23:07:37.060Z_

Pass 1 done. Launch pass 2: `XAI_SWARM_PASS=2 pnpm t3mp3st:swarm:overnight` (full squad, 35 tool rounds).
