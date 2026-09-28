import { describe, expect, it } from 'vitest';
import {
  GOLD_FACT_LIVE_METHOD,
  aggregateCaseFunnels,
  buildCascade,
  classifyToolDump,
  emptyFunnel,
  observeFunnel,
  picksWithForcedChildren,
  scoreClaimKeys,
  summarizeVerdicts,
} from '../scripts/gold-fact-live-collect.mjs';

describe('gold-fact live collect', () => {
  it('locks default method id to drain-before-recycle path', () => {
    expect(GOLD_FACT_LIVE_METHOD.id).toBe(
      'session_reuse_request_parallel_drain_before_recycle',
    );
    expect(GOLD_FACT_LIVE_METHOD.softOpenRecycleOn813).toBe(false);
    expect(GOLD_FACT_LIVE_METHOD.drainInflightBeforeRecycle).toBe(true);
  });

  it('classifies find dumps into funnel buckets', () => {
    expect(
      classifyToolDump('hms_find_reservation', {
        status: 'partial',
        parse: 'ok',
        responseClass: 'pagedata',
      }),
    ).toEqual({ bucket: 'hit', parseOk: true, hit: true, stub813: false });
    expect(
      classifyToolDump('hms_find_reservation', {
        status: 'loadLocalized',
        parse: 'no_pagedata',
        responseClass: 'loadLocalized',
        searchBytes: 813,
      }),
    ).toEqual({ bucket: 'stub_813', parseOk: false, hit: false, stub813: true });
    expect(
      classifyToolDump('hms_read_folio', { status: 'skipped_need_find' }),
    ).toMatchObject({ bucket: 'skipped_need_find' });
  });

  it('builds find→child cascade starved_by_find', () => {
    const cascade = buildCascade(
      { status: 'not_found', parse: 'ok' },
      { hms_read_folio: { status: 'skipped_need_find' } },
    );
    expect(cascade.find_hit).toBe(false);
    expect(cascade.children.hms_read_folio.cascade).toBe('starved_by_find');
  });

  it('forces folio/notes picks after find hit', () => {
    const picks = picksWithForcedChildren(['hms_find_reservation'], {
      status: 'partial',
      confirmation: 'HRCEN1',
      stayId: '9',
    });
    expect(picks).toContain('hms_read_folio');
    expect(picks).toContain('hms_read_notes_traces');
  });

  it('aggregates funnels and claim scores', () => {
    let f = emptyFunnel();
    f = observeFunnel(f, 'hms_find_reservation', {
      status: 'partial',
      parse: 'ok',
      responseClass: 'pagedata',
      ms: 10,
    });
    f = observeFunnel(f, 'hms_find_reservation', { status: 'not_found', parse: 'ok', ms: 5 });
    expect(f.attempted).toBe(2);
    expect(f.hit).toBe(1);
    expect(f.pagedata).toBe(2);
    expect(f.not_found).toBe(1);

    const byTool = aggregateCaseFunnels([{ tools: { hms_find_reservation: f } }]);
    expect(byTool.hms_find_reservation.hit).toBe(1);

    const claims = scoreClaimKeys({
      gold: { confirmation_candidates: ['HRCEN1'], date_strings: [] },
      toolDumps: {
        hms_find_reservation: {
          status: 'partial',
          parse: 'ok',
          responseClass: 'pagedata',
          confirmation: 'HRCEN1',
        },
      },
      picks: ['hms_find_reservation'],
      cascade: buildCascade(
        { status: 'partial', confirmation: 'HRCEN1' },
        { hms_read_folio: { status: 'ok' } },
      ),
    });
    expect(claims.some((r) => r.claimKey === 'find.confirmation' && r.verdict === 'match')).toBe(
      true,
    );
    expect(summarizeVerdicts(claims).match).toBeGreaterThan(0);
  });
});
