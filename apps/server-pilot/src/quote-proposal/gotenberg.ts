export async function convertXlsxWithGotenberg(
  xlsxBytes: Uint8Array,
  opts: { url: string; fetchImpl?: typeof fetch } = { url: '' },
): Promise<Uint8Array> {
  const base = opts.url.replace(/\/+$/, '');
  if (!base) throw new Error('GOTENBERG_URL missing');
  const form = new FormData();
  form.append('files', new Blob([xlsxBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'quote.xlsx');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base}/forms/libreoffice/convert`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`gotenberg convert failed: ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
