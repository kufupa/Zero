#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRootAlt = repoRoot.replace(/\\/g, '/');
const repoRoots = [...new Set([repoRoot, repoRootAlt])];
const isWin = process.platform === 'win32';
const currentPid = process.pid;

const isTargetCommand = (command) => /\b(node|esbuild|workerd)(\.exe)?\b/i.test(command);
const isFromRepo = (command) => repoRoots.some((root) => command.includes(root));

const cleanWindows = () => {
  const escapedRoots = repoRoots.map((root) => root.replace(/'/g, "''"));
  const script = `
$repoRoots = @(${escapedRoots.map((root) => `'${root}'`).join(', ')});
$currentPid = ${currentPid};
$targetNames = @('node', 'node.exe', 'esbuild', 'esbuild.exe', 'workerd', 'workerd.exe');

$ids = @();
Get-CimInstance Win32_Process | Where-Object {
  $name = $_.Name.ToLower()
  if ($_.ProcessId -eq $currentPid) { return $false }
  if ($targetNames -notcontains $name) { return $false }
  if (-not $_.CommandLine) { return $false }
  foreach ($root in $repoRoots) {
    if ($_.CommandLine -like "*$root*") { return $true }
  }
  return $false
} | ForEach-Object {
  $ids += $_.ProcessId
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

if ($ids.Count -eq 0) { return }
$ids | Sort-Object -Unique
`;

  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  const ids = (result.stdout || '').split(/\r?\n/).filter(Boolean);
  if (ids.length > 0) {
    console.log(`[cleanup-dev] Stopped ${ids.length} repo-scoped dev process(es).`);
  } else {
    console.log('[cleanup-dev] No matching repo-scoped dev processes found.');
  }
};

const cleanUnix = () => {
  const isCurrentProcess = (pid) => String(pid) === String(currentPid);
  const procList = spawnSync('ps', ['-eo', 'pid=,command='], {
    encoding: 'utf8',
  });

  if (procList.error) {
    throw procList.error;
  }

  const lines = (procList.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const pids = new Set(
    lines
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        const command = match[2];
        if (!isTargetCommand(command) || !isFromRepo(command) || isCurrentProcess(match[1])) return null;
        return match[1];
      })
      .filter(Boolean),
  );

  if (pids.size === 0) {
    console.log('[cleanup-dev] No matching repo-scoped dev processes found.');
    return;
  }

  for (const pid of pids) {
    spawnSync('kill', ['-9', pid]);
  }

  console.log(`[cleanup-dev] Stopped ${pids.size} repo-scoped dev process(es).`);
};

try {
  if (isWin) {
    cleanWindows();
  } else {
    cleanUnix();
  }
} catch (error) {
  console.error('[cleanup-dev] Failed to clean up dev processes:', error.message);
  process.exitCode = 1;
}
