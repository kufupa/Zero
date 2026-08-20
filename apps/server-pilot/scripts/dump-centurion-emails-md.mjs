#!/usr/bin/env node

process.stderr.write(
  'CENTURION_MARKDOWN_DUMP_RETIRED: use scripts/export-centurion-thread-state-corpus.ts with --execute and explicit cutoffs.\n',
);
process.exitCode = 1;
