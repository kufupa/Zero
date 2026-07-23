# Gate report — quoted history ellipsis (design polish wave)

**Date:** 2026-07-23  
**Branch:** `EC2-pilot` @ `eebd6b58`  
**Plans:** `docs/superpowers/plans/2026-07-23-quoted-message-history-ellipsis-plan.md`  
**Design audit:** `~/.gstack/projects/kufupa-Zero/designs/design-audit-20260723/design-audit-quote-ellipsis.md`

## Auto-decisions (no user wait)

| ID | Pick | Why |
|----|------|-----|
| D1 button | **A** thread `#313131` ThreeDots | Max completeness vs app chrome |
| D2 dirty tree | Leave unrelated; commit quote files only | Clean atomic ship |
| D3 nesting | Outermost-only collapse | Gmail/Outlook single-stream |
| D4 outbound | `class="gmail_quote"` on constructors | Trim signal + one root |
| D5 legacy server | Defer | Pilot-only constraint |

## Done criteria

| Criterion | Status |
|-----------|--------|
| Outbound quote body included | PASS (prior wave) |
| Sender attribution in wrote-header | PASS |
| One ellipsis → full nested stream | PASS — outermost-only |
| Thread-chrome button (not gray pill) | PASS — `#313131` + SVG |
| Local vitest (collapse+wire+sanitize+construct) | PASS — 37 |
| EC2 deploy + health | PASS (`ops-deploy ok`) |
| EC2 SSM collapse suite | PASS — 7/7 (+ re-gate full suites) |

## RCA (nested buttons)

`collapseQuotedHtml` ran `blockquote` then `.gmail_quote`. Gmail MIME nests both → wrap-inner then wrap-outer → two `<details>`. Fix: single pass; skip if `parents(blockquote, .gmail_quote)`.

## Commits

- Prior: quote include + first collapse wave
- `eebd6b58` — `fix(mail): one outermost quote ellipsis matching thread chrome`

## Manual morning check

Hard-refresh thread with quotes → **one** `⋯` under new text; click → full history including nested attributions; no second ellipsis inside.
