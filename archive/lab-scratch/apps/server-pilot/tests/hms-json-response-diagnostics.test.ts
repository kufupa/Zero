import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyOsressDiagnosticBody } from '../../../../../apps/server-pilot/src/hms/find-reservation-facade.js';

describe('private JSON response diagnostics', () => {
  it('emits status/size only behind the explicit diagnostic flag', () => {
    const source = readFileSync(new URL('../src/hms/runtime.ts', import.meta.url), 'utf8');
    const adapter = source.slice(source.indexOf('    async postJson(url, body) {'));
    expect(adapter.includes("stage: 'post_json_response'")).toBe(true);
    expect(adapter.includes("process.env.HMS_PROOF_DIAGNOSTICS === '1'")).toBe(true);
    const block = adapter.slice(adapter.indexOf("stage: 'post_json_response'"), adapter.indexOf('      if (\n        result.text'));
    expect(block).toContain('status: result.status');
    expect(block).toContain('bodyBytes:');
    expect(block).not.toContain('headers:');
    expect(block).not.toContain('body: result.text');
  });

  it('classifies a bounded locale bootstrap separately from generic HTML', () => {
    const body =
      '<html><script>loadLocalizedPage(document.cookie);document.langform.submit()</script>' +
      '<form name="langform" action="/web/base/OSRESV.HDR" method="post">' +
      '<input name="ewslanguage"></form></html>';

    expect(classifyOsressDiagnosticBody(body)).toBe('LOCALE_BOOTSTRAP');
    const facadeSource = readFileSync(
      new URL('../src/hms/find-reservation-facade.ts', import.meta.url),
      'utf8',
    );
    expect(facadeSource).toContain('code: classifyOsressDiagnosticBody(text)');
  });
});
