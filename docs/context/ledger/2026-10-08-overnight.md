# Ledger: overnight v8 (2026-10-08 → 09)

Synced from the driver's live ledger at handoff. Times before ~01:59 UTC were estimates and may run ahead; later rows use the real clock.

| UTC | Unit | Lane/worktree | Event | PR | Notes |
|---|---|---|---|---|---|
| 00:10 | U1 | — | run start (late 25m vs plan) | — | stop guard deadline 07:35 |
| 00:24 | U1 | PR #58 merged (plan + CLAUDE.md→ACTIVE.md context) | #58 | docs only |
| 00:20 | U5 | Gotenberg live check pass | — | chromium 200 + PDF |
| 00:15 | U9 | blank pane title pushed to addin#8 | addin#8 | CI builds |
| 00:18 | lanes | A(U2) B(U6) C(U10) D(U8-C) builders + deep-link research launched | — | Haiku max |
| 00:16 | U9 | addin PR #8 merged (47d0d9d), CI artifact SHA 0d25d56a…4bbc = manifest | addin#8 | — |
| 00:18 | U9 | 1.0.17 installed on EC2 downloads (1.0.16 backed up), served SHA verified | — | instance-profile S3 403 → presign fallback |
| 00:20 | U9 | Zero pin PR (submodule + contract tests 25/25 + install doc) | #59 | awaiting CI |
| 00:20 | U11 | Lane G HITL builder launched | — | — |
| 00:32 | U9 | PR #59 merged (pin 1.0.17), CI+Greptile pass | #59 | — |
| 00:32 | U12 | deep-link research: ship landing+copy; probe script /tmp/v8-deeplink/scripts/hms-deeplink-probe.mjs for HMS slot | — | — |
| 00:40 | U8-C | PR #60 opened (allowances); fix 'other' label + reviewer launched | #60 | deploy server before mail (strict schema) |
| 00:50 | U8-C | #60 review FIX-FIRST (amount caps, 400 not 500, gen row failed, parse '1,000', tests) → sent to Lane D | #60 | — |
| 00:58 | U6 | PR #61 opened (party) | #61 | awaiting report |
| 01:05 | U6 | Lane B report: #61 ready (81 tests); reviewer launched; Lane B → U12 links | #61 | search ≈1 min (2 sequential runs) |
| 01:05 | U10 | Lane C report: #62 (off/lab/on + agency/org/note); Opus read guard diff OK; LIVE-UNVERIFIED ta1/company/reservationnote/caller/udfchar06 | #62 | Lane C → U15 |
| 01:12 | ops | HMS owner live on EC2:19223 (since 09-24). Decision: live read checks run against deployed D1 code (read-only, fail-closed), not ad-hoc copies | — | create stays off in prod until flag set |
| 01:20 | U11 | #63 HITL (schema+recorder, flag off); Opus checked migration additive-only | #63 | ships D3 --migrate |
| 01:08 | U12 | #64 Open HMS + copy conf + billing-ref fix; needs VITE_PUBLIC_HMS_LANDING_URL at build | #64 | — |
| 01:08 | U11 | #63 CI red: migration-compat test drops ai_workflow_run_pkey, blocked by new FK → Lane G removing FK | #63 | — |
| 01:12 | U2 | #65 NavaPane extraction (pure move, 478/479, flake pre-existing); merge first. Lane A → U3, U8-A, U8-B/D | #65 | — |
| 01:14 | U13 | #66 Excel download (stacked on #60) | #66 | wiring 1 prop in nava-pane |
| 01:14 | U15 | #67 deploy papercuts | #67 | — |
| 01:15 | review | Greptile P1s: #60 notes lost in multi-option + invalid input keeps old charge; #61 partyFinderFromTrpc rejects real tRPC client (#57 repeat!) + idle-wait not fail-closed → sent back | #60 #61 | #62 clean |
| 01:16 | U10 | #62 merged (Greptile clean, Opus guard review) | #62 | prod flag unset=off |
| 01:17 | U17 | Lane C → cancel modes | — | — |
| 01:20 | U6 | #61 P1 fixes pushed (94e0e5f1); awaiting Greptile rerun. Lane B → U7 stacked | #61 | — |
| 01:22 | U2 | #65 merged (Greptile P2 test-typing only → ledger) | #65 | lanes rebase |
| 01:24 | U11 | #63 FK removed (26e97b89), awaiting CI | #63 | — |
| 01:24 | U4 | Lane G → viewer + gate runner | — | — |
| 01:30 | U6 | #61 Haiku review: P0 runner can return no_match from stale grid (Run no-op / late reload) → silent BAR; P1 kill switch, ReDoS → Lane B fixing before U7 | #61 | reviewer > Greptile here |
| 01:32 | U12 | #64 merged (P2s: copied label stale on conf change; test env-dependence → ledger) | #64 | needs VITE_PUBLIC_HMS_LANDING_URL |
| 01:32 | U15 | #67 merged | #67 | — |
| 01:32 | U11 | #63 Greptile P1 cache-hit links wrong run → queue for Lane G after U4 | #63 | flag off, D3 |
| 01:45 | ops | #68 merged (HMS landing URL in build); #70 cancel modes opened (Opus guard check OK) | #68 #70 | — |
| 01:45 | D1 | deploy start main 4ab79674 | — | — |
| 01:50 | review | #70 Greptile P2 only (penalty test is source-grep, needs behavioral test → Lane C later); #61 waiting P0 fixes; #60/#66 Greptile rerun | — | — |
| 01:55 | U8-C/U13 | #60 5dcdd271 + #66 d63e94ad fixes pushed; awaiting Greptile rerun. Lane D → #63 P1 fix | #60 #66 #63 | — |
| 01:58 | D1 | deployed 4ab79674: exit 0 (husky auto, backlog warn-only), health 8788/8789 200, pane 200, VPN OK, HMS landing URL in bundle | — | D1 gate: viewer not ready yet (U4 in progress) |
| 02:02 | U8-C | #60 merged (P1 verified fixed in code; P2 edited-note double → ledger) | #60 | deploy server+mail together |
| 02:02 | U17 | #70 merged (P2: penalty test source-grep → behavioral test owed) | #70 | prod flag off |
| 02:05 | U11 | #63 P1 fixed 966cae5c; Lane D → HITL PR3 tool runs | #63 | — |
| 02:15 | U12/U14 | #71 booking-card links; #73 voucher find (read-only, live check owed) | #71 #73 | Lane C → penalty behavioral test |
| 02:20 | U8-A/U12 | #72 (Nava copy, 1 status line) + #71 (booking links) merged | #71 #72 | — |
| 02:20 | review | P1s: #69 storage throw + reload during draft prep → Lane A; #66 restored transfer days, #63 lock timeout + thread FK cascade → Lane D (before PR3) | — | — |
| 02:28 | U17 | #74 penalty behavioral tests (runCancelDialog extracted; same call order) | #74 | merge after Greptile |
| 02:28 | ops | Lane C → read-only live-check pack for HMS slot | — | — |
| 02:35 | U4 | #75 viewer + gate runner (click-free, write-block, PII mask); Lane G → EC2 gate script w/ existing auth | #75 | — |
| 01:59 | note | ledger times before this row were estimates (some ahead); now real clock | — | — |
| 01:59 | U17 | #74 merged | #74 | — |
| 01:59 | review | P1s → #61 (hidden mask, non-ASCII) Lane B; #69 (reload loop if storage blocked) Lane A; #73 (3) Lane C | — | D2 target ~04:00 |
| 02:05 | U11 | #66 P1 fixed f2af4efc; #63 lock/statement timeouts + SET NULL refs; #78 HITL tool runs opened → asked keep party fields + no reindent | #66 #63 #78 | — |
| 02:06 | U4 | #77 EC2 gate script (operator auth via secret, S3 gallery); #75 P1 runner blocks POST-queries → Lane G | #75 #77 | — |
| 02:09 | U6/U7 | #61 P1s fixed c2bccf14; U7 = #79 (stacked; ids re-verified, HMS-flagged rows only, BAR copy); Lane B → party index (instant typeahead) | #61 #79 | wiring notes §2 for Lane A |
| 02:10 | U3/U8 | #72 merged into #69 branch (stacked) not main — ships with #69; #69 retargeted to main; #76 look PR stacked on #69 (507/507, no browser check yet) | #69 #76 | — |
| 02:10 | U13 | #66 Excel merged | #66 | — |
| 02:10 | U11 | #63 HITL merged (P1 comment stale; fix verified in code). Next deploy needs --migrate | #63 | flag off |
| 02:12 | U4 | #75 P1 fixed 5a380f29 (procedure-based guard); #77 rebased; Lane G → teaching script + handoff draft | #75 #77 | — |
| 02:16 | merges | #75 viewer merged. #69/#76 conflict → Lane A rebase + wiring. #77 retargeted main. #80 live-check pack; #73 P1s fixed 2b61be7e | #75 #80 #73 | — |
| 02:16 | P1s | #61 normalization mismatch, #79 agency field + BAR retry → Lane B; #78 unbounded insert → Lane D | — | — |
| 02:19 | D2a | deploy start c469cbf3 --migrate (HITL 0046) | — | — |
| 02:25 | D2a | deployed c469cbf3 --migrate: 0046 applied, READY, health/pane/preview 200, VPN OK | — | HITL flag off |
| 02:25 | lessons | (1) *FromTrpc typeof-function bug recurred in #61 → brief template must say "real tRPC client is a function Proxy; test with createTRPCClient". (2) Merging a STACKED PR merges into its base branch, not main (#72) → retarget before merge. (3) Haiku checklist reviewer caught 2 P0s in #61 Greptile missed; Greptile caught P1s Haiku missed → keep both on HMS runners. (4) Greptile P1 comments persist after fixes; verify head-SHA run time vs fix commit. | — | for MISTAKES.md at handoff |
| 02:31 | docs | #81 draft teaching script + handoff; #77 P1 masking fixed c6eeed46 | #81 #77 | — |
| 02:35 | CI | main red: #75 classification test vs #66 quoteWorkbook → #83 fix merged (admin, 1-line, test green) | #83 | autofix fails on all PRs before this |
| 02:35 | U3/U8 | #76 Greptile P1s (release identity, ping stale, menu a11y, Tell Nava note lost on reload/menu) → Lane A | #69 #76 #82 | — |
| 02:41 | U7 | #79 P1s fixed 61a43902; #84 party index (sweep script + typeahead) | #79 #84 | sweep on EC2 later |
| 02:41 | U14 | #73 rebased + P1s fixed b411a2ff | #73 | — |
| 02:42 | sweep | #82 P1 Excel timeout + P2s → Lane A; #77 branch updated; CI rerunning #61 #69 #73 #78 #80 | — | — |
| 02:53 | merges | #78 HITL tool runs, #80 live-check pack, #77 preview gate merged | #77 #78 #80 | — |
| 02:53 | P1s | #61 fast-response false failure → Lane B; #73 3 parser P1s (last round) → Lane C | — | — |
| 02:54 | D2b | deploy start 4435c5c3 | — | — |
| 03:07 | V2 live | rateshop org#49 → flagged BCO1B×5 + NCOR2B×5; agency#113 (360) → 0 flagged (BAR). stay find on cancelled lab 61143613-1 → not_found (expected). D2b 4435c5c3 live | — | evidence .private/playwright-quote/runs on EC2 |
| 03:08 | V4 | Labtest create proof start (self-cleaning save→cancel, arrival 2027-03-10, agency 360/org Woolworths/note) | — | lab |
| 03:14 | V4 live | create runner nav bug (every EC2 create failed) found+fixed; Labtest 48315098-1 saved w/ agency 360 + org Woolworths + commission 10%, no guest email; cancelled via cancel-stay (penalty text recorded, not clicked) | fix PR | self-clean cancel stale |
| 03:15 | U3 | #69 merged (auto-reload); #76 → safe-boundary reload policy (email switch / 15-min idle) instead of per-field guards | #69 #76 | — |
| 03:15 | CI | drift test needs new procedures classified: #61 findParty, #73 voucherFind → lanes B/C | — | — |
| 03:16 | U12 live | deeplink probe: all OSRESV/OSRESS GETs (with/without conf, prefill) → LOGIN_BOUNCE even logged-in; record links NOT possible → keep landing + copy (K10 confirmed). Messenger APPURL format untested | — | — |
| 03:16 | U14 | #73 voucherFind classified READ (adbfd045) | #73 | — |
| 03:23 | merges | #85 create nav fix, #73 voucher find merged | #85 #73 | — |
| 03:23 | V1 | preview gate run start on EC2 (D2b) | — | — |
| 03:36 | U3 | #76 safe-boundary reload (ab0b7fe0), #82 rebased; Lane A → wire VoucherFindCard | #76 #82 | — |
| 03:36 | V1 | gate blocked by husky EACCES on its pnpm install → rerun with HUSKY=0 (fix gate script after) | — | — |
| 03:47 | merges | #86 gate husky fix merged. P1s: #76 null-identity reload → A; #79 unpicked party in rateContext, #84 sweep resume → B | #86 | gate 13/20 running |
| 03:57 | V1 FAIL | gate 20/20 timeout: viewer pane stuck on first-run onboarding (fresh profile), + app-shell reads blocked (settings.get, labels.list, categories.list) → Lane G fix | — | gallery /tmp/v8gate |
| 04:09 | merges | #76 UI look+safe reload, #61 party picker merged (P1s verified in code; Greptile not re-reviewing latest heads); #82/#79 retargeted main | #76 #61 | live party check after D3 |
| 04:10 | D2c | deploy start 06cda57ce (party runner + UI) | — | — |
| 04:14 | D2c | deployed (party runner, UI look, safe reload) | — | — |
| 04:19 | V2 live | party lookup live FAIL: (1) Guest Stay nav (same as create) → shared opener PR; (2) query typed into dialog's saved-search combo not the name input → Lane B fixing | — | screenshots /tmp/v8dbg |
| 04:29 | merges | #87 shared Guest Stay opener merged; #88 gate onboarding fix conflicts → Lane G; party dialog fix iteration 2 (wait for dialog) → Lane B | #87 | — |
| 04:31 | U7 | #79 P1 'public party quotes fail' (verified party w/o contract → full read keeps rateContext) → Lane D | #79 | common case (360) |
| 04:35 | V2 LIVE PASS | party lookups on fix branch: 360→agency #113, Woolworths→org #49, Tourvest→org #206 (resolved). Fixes: dialog Run is ExtJS a.x-btn w/o ARIA role (Opus patch 4fea6749), wait for dialog, Run-row input | — | Opus used --no-verify once (mistake) |
| 04:36 | U8/U13 | #82 merged (Excel button + party picker wiring + no-Luna sweep) | #82 | #79 must rebase on it |
| 04:42 | U4 | #88 viewer preview mode + app-shell reads merged; #89 party dialog fix CI pending | #88 #89 | — |
| 04:45 | D3 | #89 merged; deploy start 31ae92cb4 (party fix + viewer preview + wiring) | #89 | #79/#84 later |
| 04:47 | U7 | #79 public-rates P1 fixed 5b3e97e4 + rebased on #82; #84 restacked 651b5026 | #79 #84 | D4 after |
| 04:50 | D3 | deployed 31ae92cb4 (party runner fixes, viewer preview, pane wiring, Excel) | — | — |
| 04:52 | V1 PASS | gate rerun on D3: 20/20 analysed, 0 timeout, 0 blocked writes; 18 'Other' (latest mail non-quote); UX: 15/20 attachment-noise banners (ics/images) → Lane A fix; now gating 8 known quote/booking threads | — | — |
| 04:53 | U7 | #79 2 new P1s (public retry, >5 rows) → Lane D, deadline 06:10 else park (ship picker + BAR) | #79 | — |
| 04:54 | V1 targeted | 8 real quote/booking/voucher threads: 7 analysed, 1 unsynced, 0 err; booking 1c55265d prefilled 13 fields (dates, adults, meal plan, company…); P0 FOUND: signature image001.jpg review item BLOCKS THE QUOTE → Lane A P0 | — | gallery /tmp/v8gate3 |
| 05:04 | U7 | #79 f559e63b (public fallback typed); #84 42fecaca; #90 P0 attachment fix (non-blocking, skip images/ics/inline); Lane D → live 'quote' subcommand for e2e party quote proof | #79 #84 #90 | QUOTE_RATE_CONTEXT default on; only applies to picked parties |
| 05:08 | P1s | #90 cid docx dropped → A; #79 incomplete search ≠ no contract (honest copy) → D | — | — |
| 05:09 | ops | #91 live quote subcommand (needs #79 deployed) | #91 | — |
| 05:19 | merges | #90 attachment P0 fix, #79 contract rates merged; #84/#91 retargeted main | #90 #79 | — |
| 05:19 | D4 | deploy start 4979df0fb (#79 contract rates, #90 attachment P0) | — | — |
| 05:24 | D4 | deployed 4979df0f (#79 contract rates, #90 attachment fix) | — | — |
| 05:35 | V3 live | #91 harness quote (baseline + org49) → execution_failure after HMS runs SUCCEEDED (org 49 resolved 'Woolworths Holdings', options returned) → harness server step issue; Lane D adding error detail (15m box) | #91 | V3 end-to-end pane quote still unproven |
| 05:35 | merges | #84 party typeahead index merged (no index file on box → live search only) | #84 | prod flags all unset: PANE_SAVE off, HITL off, TRACE_ASYNC off, RATE_CONTEXT default on |
| 05:36 | V1 D4 | targeted gate: attachment noise gone (no image/ics banners, booking 1c55265d 13 fields, no blocker); 2 voucher threads 'error' = analysis still 'reading…' at 90s + voucher card shows (surname unreadable, PDF unreadable) → slow analysis on voucher PDFs, not crash | — | — |
| 05:37 | handoff | #81 finalized (V1 PASS, V2 PASS, V3 not proven e2e, V4 runner PASS, V6 PASS, flags) | #81 | merge after CI |
| 05:52 | V3 live | harness transportId bug (policy scope) → patched: baseline STQN quote PASS (BARRO R1750, 122s). Woolworths org49 STQN → publicFallback, but rateshop (no room filter) shows BCO1B/NCOR2B contextual for STQN → room filter in staff summary read hides contract rows → Lane D fix (deadline 06:40) | — | 360 quote pending |
| 06:03 | V3 live | quotes via server path: baseline STQN PASS (BARRO R1750); agency 360 PASS (public fallback + copy, R1750); Woolworths org49 → public fallback even with #92 overlay: party summary read returns 50 rows (runner cap) w/o BCO1B/NCOR2B, while rateshop shows them → contract selection gap (row cap/order). #92 NOT merged (doesn't fix). Ship: party → BAR + honest copy | #92 open | top follow-up |
| 06:06 | D5 | deploy start 6a27b5330 (#84 typeahead, #91 harness) | — | contract gap lead: currency conversion (see #92) |
