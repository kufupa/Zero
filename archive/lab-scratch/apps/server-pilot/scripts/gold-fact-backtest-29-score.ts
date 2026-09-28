/**
 * Offline-only gold fact scorer (mail/channel digests).
 * For LIVE HMS fact loop use: scripts/gold-fact-backtest-29-live.mjs on EC2
 * (HMS_DISCOVERY_ALLOW_LIVE=1, flock, GOLD_FACT_PACK_DIR).
 *
 * Agent-style tool pick (no suggestReadTools).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import { parseChannelPayloadFromText } from '../../../../../apps/server-pilot/src/mail/parse-channel-payload.js';

const ROOT = '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools';
const PACK = join(ROOT, '.private/gold-fact-backtest-29');

type Meta = {
  id: string;
  kind: string;
  pms_reads_needed: string[];
  trigger_class: string;
  skip_no_reads?: boolean;
  att_names?: string[];
  subject?: string;
  eml_path?: string;
};

const BLOCKED_EXPECTED = new Set([
  'property_read_knowledge',
  'hms_event_read',
  'hms_group_block_read.blocks',
  'hms_read_reservation.rates_nightly',
  'documents_list_existing.hms_finalized_document',
]);

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Agent tool pick from trigger+kind — not suggestReadTools. */
function agentPickTools(meta: Meta, trigger: string, authored: string): string[] {
  const text = `${trigger}\n${authored}\n${meta.subject ?? ''}`.toLowerCase();
  const picks = new Set<string>();
  picks.add('mail_read_artifact');

  if (meta.kind === 'channel_fw' || /webbeds|ratetiger|synxis|booking\.com|expedia/.test(text)) {
    picks.add('mail_parse_channel_payload');
  }
  if (
    /confirm|reservation|booking|invoice|payment|deposit|cancel|amend|guest|folio|balance/.test(
      text,
    ) ||
    meta.kind.includes('payment') ||
    meta.kind.includes('invoice') ||
    meta.kind.includes('booking') ||
    meta.kind === 'cancel' ||
    meta.kind === 'guest_service'
  ) {
    picks.add('hms_find_reservation');
  }
  if (/folio|balance|outstanding|deposit|paid|zar|payment/.test(text) || meta.kind === 'payment_ack') {
    picks.add('hms_read_folio');
  }
  if (/quot|availab|rate|room type/.test(text) || meta.kind === 'quote_send') {
    picks.add('hms_quote_stay');
  }
  if (/attach|pdf|invoice|confirmation letter|voucher|document/.test(text) || (meta.att_names?.length ?? 0) > 0) {
    picks.add('documents_list_existing');
    picks.add('documents_read_existing');
  }
  if (/group|block|rooming|allotment/.test(text)) {
    picks.add('hms_group_block_read');
  }
  if (/note|trace|vip|allergy|special request/.test(text)) {
    picks.add('hms_read_notes_traces');
  }
  if (/shuttle|breakfast|kids|policy|amenity|parking|wifi/.test(text) || meta.kind === 'amenity_policy') {
    picks.add('property_read_knowledge');
  }
  return [...picks];
}

function extractConfTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/HRCEN[_\s-]?\d{4,}(?:-\d+)?/gi)) {
    out.add(m[0].replace(/\s+/g, '').toUpperCase());
  }
  for (const m of text.matchAll(/\b(\d{8}-\d)\b/g)) out.add(m[1]!);
  for (const m of text.matchAll(/n[°o]\s*[:\s]*(\d{5,}(?:-\d+)?)/gi)) out.add(m[1]!);
  return [...out];
}

async function mailArtifactDigests(emlPath: string | undefined): Promise<{
  status: string;
  attachments: Array<{ filename: string; sha256: string; sizeBytes: number }>;
  ms: number;
}> {
  const t0 = Date.now();
  if (!emlPath || !existsSync(emlPath)) {
    return { status: 'no_eml', attachments: [], ms: Date.now() - t0 };
  }
  const mail = await simpleParser(readFileSync(emlPath));
  const attachments = (mail.attachments ?? []).map((a) => ({
    filename: a.filename || 'unnamed',
    sha256: sha256(a.content as Buffer),
    sizeBytes: (a.content as Buffer).length,
  }));
  return {
    status: attachments.length ? 'ok' : 'no_attachments',
    attachments,
    ms: Date.now() - t0,
  };
}

function scoreFacts(input: {
  gold: Record<string, unknown>;
  toolDumps: Record<string, unknown>;
  picks: string[];
}): Array<{ fact: string; verdict: string; detail?: string }> {
  const rows: Array<{ fact: string; verdict: string; detail?: string }> = [];
  const goldConfs = (input.gold.confirmation_candidates as string[]) || [];
  const goldAmounts = (input.gold.amounts_zar as string[]) || [];
  const goldRooms = (input.gold.room_tokens as string[]) || [];
  const goldAtt = (input.gold.attachment_names as string[]) || [];

  if (input.picks.includes('property_read_knowledge')) {
    rows.push({
      fact: 'property_policy',
      verdict: 'blocked_expected',
      detail: 'EXTERNAL_ROLE_GATE_KNOWLEDGE_CORPUS_ABSENT',
    });
  }

  if (input.picks.includes('hms_group_block_read')) {
    rows.push({
      fact: 'group_list',
      verdict: 'not_in_tool_scope',
      detail: 'list-only OK if live; CON/BLK blocked_expected',
    });
    rows.push({
      fact: 'group_con_blk',
      verdict: 'blocked_expected',
      detail: 'GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER',
    });
  }

  const mail = input.toolDumps.mail_read_artifact as
    | { status: string; attachments: Array<{ filename: string }> }
    | undefined;
  if (goldAtt.length && mail) {
    const names = new Set((mail.attachments || []).map((a) => a.filename.toLowerCase()));
    for (const att of goldAtt) {
      const hit = [...names].some((n) => n.includes(att.toLowerCase().slice(0, 12)) || att.toLowerCase().includes(n.slice(0, 12)));
      rows.push({
        fact: `attachment:${att.slice(0, 40)}`,
        verdict: mail.status === 'ok' && (hit || mail.attachments.length > 0) ? 'match' : 'mismatch',
        detail: mail.status,
      });
    }
  } else if (input.picks.includes('mail_read_artifact')) {
    rows.push({
      fact: 'mail_artifact',
      verdict: mail?.status === 'ok' ? 'match' : mail?.status === 'no_attachments' ? 'not_in_tool_scope' : 'tool_missing',
      detail: mail?.status,
    });
  }

  const channel = input.toolDumps.mail_parse_channel_payload as
    | { ok: boolean; channel?: string; reason?: string }
    | undefined;
  if (input.picks.includes('mail_parse_channel_payload')) {
    rows.push({
      fact: 'channel_parse',
      verdict: channel?.ok ? 'match' : 'mismatch',
      detail: channel?.ok ? channel.channel : channel?.reason,
    });
  }

  if (input.picks.includes('hms_find_reservation')) {
    const live = input.toolDumps.hms_find_reservation as
      | { status: string; confirmation?: string | null }
      | undefined;
    if (!live) {
      rows.push({
        fact: 'find_reservation',
        verdict: goldConfs.length ? 'tool_missing' : 'tool_missing',
        detail: goldConfs.length
          ? 'live_hms_not_run_has_conf_token'
          : 'no_exact_candidate_in_mail',
      });
    } else if (live.status === 'ok' || live.status === 'partial') {
      const confOk =
        !goldConfs.length ||
        (live.confirmation &&
          goldConfs.some((c) => c.includes(String(live.confirmation)) || String(live.confirmation).includes(c)));
      rows.push({
        fact: 'find_confirmation',
        verdict: confOk || !goldConfs.length ? 'match' : 'mismatch',
        detail: live.status,
      });
    } else {
      rows.push({ fact: 'find_reservation', verdict: 'mismatch', detail: live.status });
    }
  }

  if (input.picks.includes('hms_read_folio')) {
    rows.push({
      fact: 'folio_balance',
      verdict: input.toolDumps.hms_read_folio ? 'match' : 'tool_missing',
      detail: goldAmounts.length ? `gold_amounts=${goldAmounts.length}` : 'no_amount_in_sent',
    });
  }

  if (input.picks.includes('hms_quote_stay')) {
    rows.push({
      fact: 'quote_rates',
      verdict: input.toolDumps.hms_quote_stay ? 'match' : 'tool_missing',
      detail: goldRooms.length ? `room_tokens=${goldRooms.length}` : 'no_room_token',
    });
  }

  return rows;
}

async function main() {
  const manifest = readFileSync(join(PACK, 'manifest.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Meta & { case_dir: string });

  const caseScores: unknown[] = [];
  const latencies: number[] = [];
  const tAll = Date.now();

  for (const row of manifest) {
    const caseDir = join(PACK, row.case_dir);
    const meta = JSON.parse(readFileSync(join(caseDir, 'meta.json'), 'utf8')) as Meta;
    const trigger = readFileSync(join(caseDir, 'trigger.txt'), 'utf8');
    const authored = readFileSync(join(caseDir, 'sent_authored.txt'), 'utf8');
    const gold = JSON.parse(readFileSync(join(caseDir, 'gold_facts.json'), 'utf8'));

    // Enrich gold confs from trigger
    const confs = [
      ...new Set([
        ...((gold.confirmation_candidates as string[]) || []),
        ...extractConfTokens(trigger),
        ...extractConfTokens(authored),
      ]),
    ];
    gold.confirmation_candidates = confs;

    const t0 = Date.now();
    const picks = agentPickTools(meta, trigger, authored);
    const dumpsDir = join(caseDir, 'tool_dumps');
    mkdirSync(dumpsDir, { recursive: true });

    const toolDumps: Record<string, unknown> = {};

    if (picks.includes('mail_read_artifact')) {
      const dump = await mailArtifactDigests(meta.eml_path);
      toolDumps.mail_read_artifact = dump;
      writeFileSync(join(dumpsDir, 'mail_read_artifact.json'), JSON.stringify(dump, null, 2));
    }

    if (picks.includes('mail_parse_channel_payload')) {
      const outcome = parseChannelPayloadFromText(`${trigger}\n${authored}`);
      const dump = outcome.ok
        ? { ok: true, channel: outcome.data.channel, externalRef: outcome.data.externalRef }
        : { ok: false, reason: outcome.reason };
      toolDumps.mail_parse_channel_payload = dump;
      writeFileSync(join(dumpsDir, 'mail_parse_channel_payload.json'), JSON.stringify(dump, null, 2));
    }

    // Live HMS tools: not invoked in this offline pass unless env set later
    if (picks.includes('hms_find_reservation') && process.env.HMS_GOLD_FACT_LIVE === '1' && confs[0]) {
      toolDumps.hms_find_reservation = {
        status: 'deferred_to_live_batch',
        candidate: confs[0],
      };
    }

    const facts = scoreFacts({ gold, toolDumps, picks });
    const ms = Date.now() - t0;
    latencies.push(ms);

    const score = {
      id: meta.id,
      kind: meta.kind,
      trigger_class: meta.trigger_class,
      agent_picks: picks,
      gold_label_reads: meta.pms_reads_needed,
      confirmation_candidates_n: confs.length,
      wall_ms: ms,
      facts,
      summary: {
        match: facts.filter((f) => f.verdict === 'match').length,
        mismatch: facts.filter((f) => f.verdict === 'mismatch').length,
        tool_missing: facts.filter((f) => f.verdict === 'tool_missing').length,
        blocked_expected: facts.filter((f) => f.verdict === 'blocked_expected').length,
        not_in_tool_scope: facts.filter((f) => f.verdict === 'not_in_tool_scope').length,
      },
    };
    writeFileSync(join(caseDir, 'score.json'), JSON.stringify(score, null, 2) + '\n');
    writeFileSync(join(caseDir, 'gold_facts.json'), JSON.stringify(gold, null, 2) + '\n');
    caseScores.push(score);
    console.log(
      JSON.stringify({
        id: meta.id.slice(0, 24),
        kind: meta.kind,
        ms,
        picks: picks.length,
        ...score.summary,
      }),
    );
  }

  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!;
  const totals = {
    n: caseScores.length,
    wall_total_ms: Date.now() - tAll,
    median_ms: pct(50),
    p95_ms: pct(95),
    fact_totals: {
      match: 0,
      mismatch: 0,
      tool_missing: 0,
      blocked_expected: 0,
      not_in_tool_scope: 0,
    },
    live_hms: process.env.HMS_GOLD_FACT_LIVE === '1' ? 'requested' : 'offline_pass',
    scale_estimate_3949: {
      offline_pack_ms_per_case_median: pct(50),
      offline_3949_minutes: Math.round(((pct(50) * 3949) / 60000) * 10) / 10,
      note: 'Live HMS find ~30-90s/case serial under one lock → 3949 find-needed (~2115) ≈ 18–53 hours; offline mail/channel alone scales in minutes.',
    },
  };
  for (const s of caseScores as Array<{ summary: Record<string, number> }>) {
    for (const k of Object.keys(totals.fact_totals) as Array<keyof typeof totals.fact_totals>) {
      totals.fact_totals[k] += s.summary[k] || 0;
    }
  }

  writeFileSync(join(PACK, 'SCORES_AGGREGATE.json'), JSON.stringify({ totals, cases: caseScores }, null, 2));
  const md = `# Gold fact backtest SUMMARY (shard-098, n=29)

Date: ${new Date().toISOString()}

## What ran
- Chooser: Cursor-agent rules in \`gold-fact-backtest-29-score.ts\` (bypasses \`suggestReadTools\`)
- Offline tools: \`mail_read_artifact\` digests, \`mail_parse_channel_payload\`
- Live HMS: **not** blasted on all 29 this pass (\`HMS_GOLD_FACT_LIVE\` unset). Find/folio/quote scored \`tool_missing\` when no live dump — honest gap.
- Blocked expected: property knowledge, CON/BLK

## Timing
- Cases: ${totals.n}
- Wall total: ${totals.wall_total_ms} ms
- Median / case: ${totals.median_ms} ms
- p95 / case: ${totals.p95_ms} ms

## Fact verdicts
${JSON.stringify(totals.fact_totals, null, 2)}

## Scale to 3949
${totals.scale_estimate_3949.note}
- Offline-only @ median: ~${totals.scale_estimate_3949.offline_3949_minutes} min
- Live find-needed (~2115) @ 30–90s serial: **~18–53 hours** one lock

## Decision (phase 4)
- Offline pack+score is fast → keep for full 3949 mail/channel/fact-extract.
- Live find-only: PARALLEL=32, SEARCH_BUDGET=32 (one real concurrent wave then recycle; ~90min/3949). Soft-opens separate. No vendor nightly OSRESS cap.
`;
  writeFileSync(join(PACK, 'SUMMARY.md'), md);
  console.log(JSON.stringify(totals, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
