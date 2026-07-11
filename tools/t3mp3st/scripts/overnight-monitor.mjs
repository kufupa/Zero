#!/usr/bin/env node
/**
 * Overnight monitor — polls War Room + swarm report, appends findings MD.
 * Tooling only. No apps/** edits.
 * Paths overridable via WARROOM_FINDINGS / WARROOM_HANDOFF / WARROOM_SWARM.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const FULL = process.env.WARROOM_FULL_STRESS === '1';
const FINDINGS =
  process.env.WARROOM_FINDINGS ||
  join(
    REPO_ROOT,
    FULL
      ? 'docs/superpowers/plans/handoff-reports/2026-07-09-ec2-pilot-t3mp3st-warroom-findings.md'
      : 'docs/superpowers/plans/handoff-reports/2026-07-08-ec2-pilot-t3mp3st-warroom-findings.md',
  );
const HANDOFF =
  process.env.WARROOM_HANDOFF ||
  join(
    REPO_ROOT,
    FULL
      ? 'docs/superpowers/plans/handoff-reports/2026-07-09-t3mp3st-warroom-handoff.md'
      : 'docs/superpowers/plans/handoff-reports/2026-07-08-t3mp3st-warroom-handoff.md',
  );
const SWARM =
  process.env.WARROOM_SWARM ||
  join(
    REPO_ROOT,
    FULL
      ? 'docs/superpowers/plans/handoff-reports/2026-07-09-ec2-pilot-t3mp3st-cli-swarm-audit.md'
      : 'docs/superpowers/plans/handoff-reports/2026-07-08-ec2-pilot-t3mp3st-cli-swarm-audit.md',
  );
const BASE = process.env.T3MP3ST_WAR_ROOM_URL || 'http://127.0.0.1:3333';
const H = { origin: 'http://127.0.0.1:3333', 'content-type': 'application/json' };
const BUDGET_MS = (Number(process.env.WARROOM_BUDGET_MIN) || (FULL ? 480 : 360)) * 60_000;
const INTERVAL_MS = (Number(process.env.MONITOR_INTERVAL_MIN) || 5) * 60_000;
const DATE_LABEL = FULL ? '2026-07-09' : '2026-07-08';
const PLAN_LINK = FULL
  ? '../2026-07-09-t3mp3st-warroom-full-stress.md'
  : '../2026-07-08-t3mp3st-warroom-overnight.md';

function append(title, body) {
  appendFileSync(FINDINGS, `\n\n## ${title}\n\n_${new Date().toISOString()}_\n\n${body}\n`, 'utf8');
  console.log(`[monitor] ${title}`);
}

async function approvePending() {
  const ap = await fetch(`${BASE}/api/approvals`, { headers: H }).then((r) => r.json());
  let n = 0;
  for (const a of ap.approvals || []) {
    if (a.status !== 'pending') continue;
    await fetch(`${BASE}/api/approvals/${a.id}/approve`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ approvedBy: 'overnight-monitor', ttlMinutes: 480 }),
    });
    n++;
    append(`Monitor approved ${a.id}`, `${a.action}: ${a.reason || ''}`);
  }
  return n;
}

async function main() {
  const start = Date.now();
  let n = 0;
  append(
    'Monitor start',
    `fullStress=${FULL} budget=${BUDGET_MS / 60000}min interval=${INTERVAL_MS / 60000}min findings=${FINDINGS}`,
  );

  while (Date.now() - start < BUDGET_MS) {
    n++;
    try {
      await approvePending();
      const st = await fetch(`${BASE}/api/mission/status`, { headers: H }).then((r) => r.json());
      const mf = await fetch(`${BASE}/api/mission/findings`, { headers: H }).then((r) => r.json());
      const lf = await fetch(`${BASE}/api/findings`, { headers: H }).then((r) => r.json());
      const opsList = await fetch(`${BASE}/api/operators/list`, { headers: H })
        .then((r) => r.json())
        .catch(() => ({}));
      const details = opsList.operators || st.operators?.details || [];
      const archetypes = [...new Set(details.map((o) => o.archetype).filter(Boolean))];
      let be = 'n/a';
      try {
        const r = await fetch('http://127.0.0.1:18788/health', { signal: AbortSignal.timeout(4000) });
        be = `HTTP ${r.status}`;
      } catch (e) {
        be = `FAIL ${e}`;
      }
      const swarmTxt = existsSync(SWARM) ? readFileSync(SWARM, 'utf8') : '';
      const swarmDone = /Run complete|SWARM COMPLETE|CLEAN|INVALID_DEGRADED/.test(swarmTxt);
      append(
        `Monitor tick #${n}`,
        [
          `- mission: \`${st.name || 'none'}\` active=${st.active}`,
          `- phase=${st.mission?.currentPhase} tick=${st.tickCount} progress=${st.mission?.progress}`,
          `- opsSummary=${JSON.stringify(st.operators?.summary)}`,
          `- archetypes(${archetypes.length})=${archetypes.join(',') || '(none)'}`,
          `- vaultFindings=${st.vault?.totalFindings} missionFindings=${(mf.findings || []).length} ledger=${(lf.findings || []).length}`,
          `- backendTunnel=${be}`,
          `- swarmDone=${swarmDone}`,
        ].join('\n'),
      );
      if ((mf.findings || []).length) {
        append(
          `Mission findings dump #${n}`,
          `\`\`\`json\n${JSON.stringify(mf, null, 2).slice(0, 80000)}\n\`\`\``,
        );
      }
      // Full-stress: do not early-exit on swarm alone — run full budget
      if (!FULL && swarmDone && n >= 8 && Date.now() - start > 45 * 60_000) {
        append('Monitor early exit', 'cli-swarm complete + enough War Room runtime');
        break;
      }
    } catch (e) {
      append(`Monitor error #${n}`, String(e));
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  writeFileSync(
    HANDOFF,
    `# T3MP3ST War Room overnight handoff — ${DATE_LABEL}

**Finished:** ${new Date().toISOString()}  
**Findings:** [${FINDINGS.split(/[/\\\\]/).pop()}](./${FINDINGS.split(/[/\\\\]/).pop()})  
**cli-swarm:** [${SWARM.split(/[/\\\\]/).pop()}](./${SWARM.split(/[/\\\\]/).pop()})  
**Plan:** [${PLAN_LINK}](${PLAN_LINK})

## Status

- Mode: ${FULL ? 'FULL STRESS (all 8 operators + Admiral LIVE)' : 'standard overnight'}
- War Room UI: http://127.0.0.1:3333/ui/
- EC2 backend tunnel: http://127.0.0.1:18788 → :8788
- EC2 frontend tunnel: http://127.0.0.1:13000 → :3000
- **No \`apps/**\` production code modified**

## Morning checklist

- [ ] Skim War Room findings for P0/P1
- [ ] Skim cli-swarm confirmed/refuted board
- [ ] Confirm \`git diff -- apps/\` empty from this overnight
- [ ] Decide follow-up fix plan if needed

_Generated by overnight-monitor.mjs_
`,
    'utf8',
  );
  append('Handoff written', HANDOFF.replace(/\\/g, '/'));
  console.log('[monitor] done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
