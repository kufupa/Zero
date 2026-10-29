# Pomerado and Centurion HMS session continuity

2026-10-28. Research and planning only: no new HMS session, mint, test,
configuration change or product implementation. The owner wants multiple
browser-based Pomerado tools and explicitly ruled out an interface outside the
HMS browser. This report extends
`docs/research/2026-10-28-codex-pomerado-centurion-read.md`: that report did
not analyze the existing recovery path, how a fresh artifact starts, or a
reusable multi-tool policy.

## Evidence and competing explanations

| Claim | Status | Evidence and limits |
| --- | --- | --- |
| Native sign-in and the requested record were reached | Observed in one mint | Private captured page and tool trace described in the earlier report; correct confirmation heading and Stay 360 appeared. This is not a fresh tool replay. |
| A reusable Pomerado integration was made | **No** | Mint terminal result `build: incomplete`; no integration directory was published. |
| Navigating or reloading a signed-in Centurion page can reveal login again | Observed | Two prior owned-browser checks: Pomerado-style root reset and same-page reload each showed the login form. This does not establish server-side cookie invalidation, the exact cause, or universal behavior across Infor tenants. |
| The host resets pages independently of the generated prompt | Source-confirmed | Installed Pomerado `0.4.0-canary.446` compiled host and corresponding local checkout (`f45faa8b`): `typescript/src/standalone/mint-state.ts:133-151`; `typescript/src/runtime/start-state.ts:428-487`. The installed source, not a different upstream revision, is the runtime evidence. |
| Fresh served calls need the same consideration | Source-confirmed | `typescript/src/standalone/run-operation.ts:91-118` performs recorded sign-in before `startPage`. A mint-only change is insufficient. |
| Existing auto-recovery might resolve the failure without a new policy | Possible, not demonstrated | `typescript/src/runtime/session-sign-in.ts:27-34,302-332` contains sign-in limits and `lostOnLoad` detection. Mint scope is one automatic sign-in per check and four per attempt. The exact path and counts in this failed job were not captured. Do not assert that exhausting them caused this particular failure. |
| Pomerado has reusable synthetic recovery cases | Source-confirmed, not run here | `typescript/tests/unit/session-sign-in.test.ts:357-420` includes loss-on-load detection and starting where sign-in left the page; browser suites also cover bounded sign-ins and multiple checks. These tests do not by themselves establish Infor's actual mint/fresh-run behavior. Reuse them before adding a new fixture. |
| Changing the root hook or library alone avoids the reset | Unsupported | `start-state.ts:511-562` invokes the host's `beforeEntry` / `navigateRoot` only after `resetPageCode`; library sessions can keep their context but fresh operation startup still calls `startPage`. |
| Existing Zero login provides a useful starting point | Source-confirmed, integration unproven | `apps/server-pilot/tooling/playwright-quote/session-reuse.mjs:89-103,163-184` verifies tenant/property and can log in. `hms-slot-lease.mjs:108-131` reuses or creates a page under its existing lifecycle. A new Pomerado host must deliberately integrate compatible checks; the existing helper does not automatically become a Pomerado-recorded sign-in. Its `login` begins with `goto`, so call it only for initial authentication, never for a supposedly preserved signed-in page. |
| An earlier host-login bridge proves the proposed continuity fix | No | The bridge reached its own authenticated-shell check, but its host-only login was not registered in native Pomerado tracking; source had a `ScopeDenied` branch for a later live reset. Whether that branch ran is unknown. The bridge trial did not publish a tool or prove continuing authentication. See `docs/research/2026-10-28-pomerado-live-mint-debug.md` and `docs/context/ledger/2026-10-28-pomerado-run-close-retro.md`. |
| Session state alone is a proven fix | No | `session-reuse-probe.mjs:29-68` defines a probe; its existence does not establish successful portability in this tenant. Playwright storage state and a live page's runtime state are different. Same-tab `sessionStorage` survives reload by specification, so reload behavior does not itself establish its loss. |
| Attach Pomerado to the existing product browser | Unsupported by stock standalone | `typescript/src/standalone/session.ts:10-18` rejects CDP attachment. A Playwright endpoint that creates a context does not hand over the running page. This research does not authorize a change to anyone else's browser. |

Infor's [navigation guide](https://docs.infor.com/hms/2026.09/en-us/hmsolh/s_t1424428566057.html)
describes using menus, tabs and controls. Its
[session guidance](https://docs.infor.com/hms/2026.09/en-us/hmsolh/s_t1424428540721.html)
describes timeout handling; it does not establish why this Centurion page
returned to login. The older Infor
[Messenger APPURL documentation](https://docs.infor.com/hms/3.8.x/en-us/hmsitolh/s_t1424428540222.html)
describes record-return links for that feature; it is not proof arbitrary screen
URLs work in Centurion. [Playwright authentication](https://playwright.dev/docs/auth)
explains stored browser authentication; [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)
and the [HTML standard](https://html.spec.whatwg.org/multipage/webstorage.html)
confirm same-tab session storage survives reload. An old Infor AUTOSAVE
parameter describes saving when moving between tabs; the tenant's actual
configuration is unknown, so click navigation alone is not a read-only guard.

## Research method and accounting

Read the mandatory Zero context and prior HMS/Pomerado artifacts, used
CodeGraph on the indexed Zero code and read the unindexed `.mjs` helper and
Pomerado sources directly. CodeGraph did not index the Pomerado checkout.
An independent Exa Agent ran at high effort (run
`agent_run_d13b1df684a64519a30e947f103388ff`); checked primary vendor and
browser documentation and a contradictory source. Reported Exa Agent cost was
$0.5001; two additional searches reported $0.014 combined. Some search/fetch
prices and this Codex session's model cost were not reported, so total research
cost is unknown. No guest or login data was sent to external research.

## Decision and unresolved proof

The best supported direction is one reusable Infor session setup, with UI
navigation and property checks at both mint and execution boundaries. Infor is
the target; no general multi-site framework is requested. First characterize the
existing auto-recovery against its existing synthetic cases, extending them
only for a missing Infor-specific lifecycle boundary. Keep it only if
it meets the whole contract, including no post-authentication reset or direct
navigation; otherwise make the smallest earlier host-start change in a
version-pinned Pomerado extension/fork. The host, not only the prompt, must
preserve the page. This is an architecture recommendation, not a proven fix.

Exact cause, actual counters, UI route to a neutral start, portability of the
proposed seam, native sign-in tracking, and performance remain unverified.
See `docs/plans/2026-10-28-004-feat-pomerado-hms-session-continuity.md` for
acceptance checks. No live work is authorized by this research-only request.
