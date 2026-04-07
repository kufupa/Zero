#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform === 'win32') {
  const rootPs = root.replace(/\\/g, '\\\\').replace(/"/g, '`"');
  const ps = `$root = "${rootPs}"; $procs = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq "node.exe" -or $_.Name -eq "esbuild.exe" -or $_.Name -eq "workerd.exe") -and $_.CommandLine -like ("*" + $root + "*") }; foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Output "cleanup_complete"`;
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
} else {
  spawnSync('bash', ['-c', 'pkill -f "$1" || true', 'cleanup-dev', root], { stdio: 'inherit' });
}
