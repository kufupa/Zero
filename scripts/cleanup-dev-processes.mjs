#!/usr/bin/env node
/**
 * Stops dev-related node / esbuild / workerd for this repo, then frees common dev ports.
 *
 * Why two steps (see also vitejs/vite#5743, evanw/esbuild zombie issues, Windows orphan PIDs):
 * - Command-line path matching can miss when the shell uses "/" vs "\\" or different spelling.
 * - Killing the listener PID with taskkill /T removes child esbuild/workerd even when the
 *   child's command line does not include the repo path.
 *
 * Env:
 * - CLEANUP_DEV_PORTS — comma-separated ports (default: 3000,8787,8788,5173)
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_PORTS = [3000, 8787, 8788, 5173];

function parsePorts() {
  const raw = process.env.CLEANUP_DEV_PORTS ?? process.env.DEV_CLEANUP_PORTS;
  if (!raw?.trim()) return DEFAULT_PORTS;
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n) && n > 0);
}

if (process.platform === 'win32') {
  const ports = parsePorts();
  const portsLiteral = ports.join(',');

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$root = $env:CLEANUP_DEV_ROOT
if (-not $root) { Write-Error 'CLEANUP_DEV_ROOT missing'; exit 1 }

$variants = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
[void]$variants.Add($root)
[void]$variants.Add($root.Replace('\\','/'))
try {
  $resolved = (Resolve-Path -LiteralPath $root).Path
  [void]$variants.Add($resolved)
  [void]$variants.Add($resolved.Replace('\\','/'))
} catch { }

function Test-CmdlineMatchesRepo([string] $cmd) {
  if ([string]::IsNullOrEmpty($cmd)) { return $false }
  foreach ($v in $variants) {
    if ($cmd.IndexOf($v, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }
  return $false
}

$names = 'node.exe','esbuild.exe','workerd.exe'
$procs = Get-CimInstance Win32_Process | Where-Object {
  ($names -contains $_.Name) -and (Test-CmdlineMatchesRepo $_.CommandLine)
}
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

$pids = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($port in @(${portsLiteral})) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    [void]$pids.Add($_.OwningProcess)
  }
}
foreach ($killPid in $pids) {
  & taskkill.exe /PID $killPid /T /F 2>$null | Out-Null
}

Write-Output 'cleanup_complete'
`.trim();

  spawnSync('powershell', ['-NoProfile', '-Command', ps], {
    stdio: 'inherit',
    env: { ...process.env, CLEANUP_DEV_ROOT: root },
  });
} else {
  const roots = [root, root.replace(/\\/g, '/')].filter((v, i, a) => a.indexOf(v) === i);
  for (const r of roots) {
    spawnSync('bash', ['-c', 'pkill -f "$1" || true', 'cleanup-dev', r], { stdio: 'inherit' });
  }

  const ports = parsePorts();
  for (const port of ports) {
    spawnSync('bash', [
      '-lc',
      `pids=$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true); if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null || true; fi`,
    ], { stdio: 'inherit' });
  }
}
