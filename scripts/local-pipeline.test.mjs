import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test.skipIf(process.platform !== 'win32')('PowerShell local pipeline regression suite', () => {
  const script = fileURLToPath(new URL('./Test-CI06.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], {
    encoding: 'utf8', timeout: 120000, windowsHide: true
  });
  expect(result.error, String(result.error)).toBeUndefined();
  expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
}, 130000);
