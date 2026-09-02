import { readFileSync } from 'node:fs';
import { askNavaHermes } from '../apps/server-pilot/src/ops/nava-hermes-bridge.ts';

async function main(): Promise<void> {
  const hermesHome = '/home/ubuntu/.hermes/profiles/zero';
  const sessionId = readFileSync(
    '.private/connected-mailbox-corpus/nava-hermes-session.id',
    'utf8',
  ).trim();

  const questions = [
    'What should we build first for the hotel reservationist inbox?',
    'How many threads are human-locked and why?',
    'Is SynXis failure in email proof of a CRS outage?',
  ];

  let sid = sessionId;
  for (const q of questions) {
    console.log(`\nQ: ${q}`);
    const result = await askNavaHermes({
      hermesHome,
      cwd: process.cwd(),
      sessionId: sid,
      question: q,
      timeoutMs: 180_000,
    });
    if (result.sessionId) sid = result.sessionId;
    console.log(`OK=${String(result.ok)} SID=${sid}`);
    console.log(`A: ${result.text}`);
    if (!result.ok) {
      console.error(result.error ?? result.stderr);
      process.exit(1);
    }
  }
  console.log('\nMULTI_OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
