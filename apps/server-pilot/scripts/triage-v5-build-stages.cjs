const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '../../..');
const baseSha = process.argv[2] || '1ebe904ae065c4394e44fd7c9358657045b535ec';
const outDir = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(root, '.tmp/triage-quality/stage-src');
fs.mkdirSync(outDir, { recursive: true });

function gitShow(sha, rel) {
  return execSync(`git show ${sha}:${rel}`, { cwd: root, encoding: 'utf8' });
}

function extractSystemPrompt(src) {
  const start = src.indexOf('export function buildSystemPrompt');
  if (start < 0) throw new Error('buildSystemPrompt missing');
  const markers = ['export type PromptMessage', 'type PromptMessage'];
  let end = -1;
  for (const m of markers) {
    const i = src.indexOf(m, start);
    if (i >= 0 && (end < 0 || i < end)) end = i;
  }
  if (end < 0) throw new Error('PromptMessage marker missing');
  return src.slice(start, end);
}

const mailRel = 'apps/server-pilot/src/ai/workflows/mail-triage.ts';
const triageRel = 'apps/server-pilot/src/ai/triage.ts';
const mailC = fs.readFileSync(path.join(root, mailRel), 'utf8');
const triageC = fs.readFileSync(path.join(root, triageRel), 'utf8');
const mailV4 = gitShow(baseSha, mailRel);
const triageV4 = gitShow(baseSha, triageRel);

const oldSys = extractSystemPrompt(mailV4);
const newSys = extractSystemPrompt(mailC);
const stageA = mailC.replace(newSys, oldSys);

fs.writeFileSync(path.join(outDir, 'mail-triage-stage-a.ts'), stageA);
fs.writeFileSync(path.join(outDir, 'mail-triage-stage-b.ts'), mailC);
fs.writeFileSync(path.join(outDir, 'mail-triage-stage-c.ts'), mailC);
fs.writeFileSync(path.join(outDir, 'triage-stage-a.ts'), triageV4);
fs.writeFileSync(path.join(outDir, 'triage-stage-b.ts'), triageV4);
fs.writeFileSync(path.join(outDir, 'triage-stage-c.ts'), triageC);

console.log(
  JSON.stringify(
    {
      baseSha,
      outDir,
      stageA_oldRules: /## Decision rules/.test(stageA),
      stageA_ingestedAt: /ingestedAt/.test(stageA),
      stageA_noSeq: !/Decision sequence/.test(stageA),
      stageC_seq: /Decision sequence/.test(mailC),
      newRefineOpsOnly: /category === 'ops' &&[\r\n\s]*next\.urgent/.test(triageC),
    },
    null,
    2,
  ),
);
