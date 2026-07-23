export type CopySenderEmailResult = 'copied' | 'empty' | 'failed';

export async function copySenderEmail(email: string): Promise<CopySenderEmailResult> {
  const trimmed = email.trim();
  if (!trimmed) return 'empty';
  try {
    await navigator.clipboard.writeText(trimmed);
    return 'copied';
  } catch {
    return 'failed';
  }
}
