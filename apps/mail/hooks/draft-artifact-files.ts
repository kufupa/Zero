export async function uniqueVerifiedFiles(current: File[], incoming: File[]): Promise<File[]> {
  const hash = async (f: File) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer())), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  const existing = new Set(await Promise.all(current.map(hash)));
  const added: File[] = [];
  for (const file of incoming) {
    const digest = await hash(file);
    if (!existing.has(digest)) {
      existing.add(digest);
      added.push(file);
    }
  }
  return added;
}
