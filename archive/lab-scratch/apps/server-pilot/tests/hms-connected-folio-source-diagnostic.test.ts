import {
  buildBoundFolioDiagnosticManifest,
  summarizeFolioDepositFields,
  summarizeHdrTrial,
} from '../scripts/hms-connected-folio-source-diagnostic.js';
import { describe, expect, it } from 'vitest';
import { bundleStagehandTrial } from '../../../../stagehand/scripts/hms-stagehand-bundle.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

describe('connected FOL source diagnostic helpers', () => {
  it('does not bundle another CLI entrypoint through a shared helper import', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'hms-fol-cli-test-'));
    try {
      const result = await bundleStagehandTrial({
        root: fileURLToPath(new URL('../../../', import.meta.url)),
        out: path.join(temp, 'artifact'),
        entries: ['apps/server-pilot/scripts/hms-connected-folio-source-diagnostic.ts'],
        external: ['playwright@1.52.0'],
      });
      expect(result.manifest.files.map((file: { path: string }) => file.path))
        .not.toContain('source/apps/server-pilot/scripts/hms-single-context-normal-diagnostic.ts');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, 30_000);
  it('summarizes locale bootstrap and exact parent without retaining body or identity', () => {
    const locale = '<html><script>loadLocalizedPage(document.cookie);document.langform.submit()</script><form name="langform" action="/web/base/logindisp" method="post"><input name="ewslanguage"></form></html>';
    const result = summarizeHdrTrial(locale, { confirmationnumber: 'PRIVATE-CONF', reservationstayid: 'PRIVATE-STAY' }, 'original');
    expect(result.locale.recognized).toBe(true);
    expect(result.locale.actionPath).toBe('/web/base/logindisp');
    expect(result.parentMatched).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-');
  });
  it('returns only the observed numeric/currency deposit fields', () => {
    const result = summarizeFolioDepositFields({
      keys: ['untransferreddeposit', 'untransferreddepositcurr', 'guestname'],
      values: {
        untransferreddeposit: '12.50',
        untransferreddepositcurr: 'zar',
        guestname: 'private-name',
      },
    });

    expect(result).toEqual([
      {
        key: 'untransferreddeposit',
        kind: 'numeric',
        present: true,
        masked: false,
        value: '12.50',
      },
      {
        key: 'untransferreddepositcurr',
        kind: 'currency',
        present: true,
        masked: false,
        value: 'ZAR',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private-name');
  });

  it('distinguishes absent fields from present but unusable values', () => {
    expect(
      summarizeFolioDepositFields({
        keys: ['untransferreddeposit'],
        values: { untransferreddeposit: 'masked-value' },
      }),
    ).toEqual([
      {
        key: 'untransferreddeposit',
        kind: 'numeric',
        present: true,
        masked: 'unknown',
        value: null,
      },
      {
        key: 'untransferreddepositcurr',
        kind: 'currency',
        present: false,
        masked: 'unknown',
        value: null,
      },
    ]);
  });

  it('builds a manifest with only exact FOL plus reviewed auth/chrome rules', () => {
    const manifest = buildBoundFolioDiagnosticManifest('https://example.test', {
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'FOL',
      confirmationnumber: 'bound-confirmation',
      reservationstayid: 'bound-stay',
      propertycode: 'HRCEN',
    });
    const fol = manifest.rules.filter((rule) => rule.path === '/web/base/OSRESV.FOL');

    expect(fol).toHaveLength(1);
    expect(fol[0]?.variableBody).toEqual({});
    expect(fol[0]?.fixedBody).toMatchObject({
      CURRENT_TAB_NAME: 'FOL',
      confirmationnumber: 'bound-confirmation',
      reservationstayid: 'bound-stay',
      propertycode: 'HRCEN',
    });
    expect(manifest.rules.some((rule) => rule.path === '/web/base/OSRESV.FOL.xmlhttp')).toBe(false);
  });
});
