/** Server-configured private Gotenberg endpoint. Never expose this port to model input. */
export function gotenbergConverter(url: string, fetchImpl: typeof fetch = fetch): (args: {
  bytes: Uint8Array; signal?: AbortSignal;
}) => Promise<Uint8Array> {
  const base = url.replace(/\/+$/, '');
  if (!base) throw new Error('PDF_CONVERTER_NOT_CONFIGURED');
  return async ({ bytes, signal }) => {
    const form = new FormData();
    form.append('files', new Blob([Uint8Array.from(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'quote.xlsx');
    const response = await fetchImpl(`${base}/forms/libreoffice/convert`, {
      method: 'POST', body: form, signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf' || !response.body) throw new Error('PDF_CONVERTER_RESPONSE');
    const limit = 20 * 1024 * 1024;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('PDF_CONVERTER_SIZE');
    const reader = response.body.getReader(), parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > limit) throw new Error('PDF_CONVERTER_SIZE');
        parts.push(part.value);
      }
    } catch (error) { await reader.cancel(); throw error; }
    finally { reader.releaseLock(); }
    const pdf = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { pdf.set(part, offset); offset += part.length; }
    return pdf;
  };
}
