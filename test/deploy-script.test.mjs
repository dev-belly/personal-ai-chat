import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const powershell = ['pwsh', 'powershell'].find((command) => (
  spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0
));
const script = fileURLToPath(new URL('../deploy-cloudflare.ps1', import.meta.url));

// Exercise the actual deployment script with an in-process npm stand-in. These
// tests cannot install packages, build, authenticate, or deploy to Cloudflare.
for (const failingStage of ['ci', 'run check', 'run deploy', null]) {
  test(`PowerShell deployment ${failingStage ? `stops at failed ${failingStage}` : 'reports success after all commands succeed'}`, {
    skip: !powershell && 'PowerShell is not installed',
  }, () => {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `
      function npm {
        $stage = $args -join ' '
        Write-Output ('MOCK_NPM:' + $stage)
        $global:LASTEXITCODE = if ($stage -eq $env:TEST_NPM_FAILURE) { 7 } else { 0 }
      }
      & $env:TEST_DEPLOY_SCRIPT
    `], {
      encoding: 'utf8',
      env: { ...process.env, TEST_DEPLOY_SCRIPT: script, TEST_NPM_FAILURE: failingStage || '' },
    });
    assert.ifError(result.error);
    const stages = [...result.stdout.matchAll(/MOCK_NPM:([^\r\n]+)/g)].map((match) => match[1]);
    const expected = ['ci', 'run check', 'run deploy'];
    if (failingStage) {
      assert.notEqual(result.status, 0);
      assert.deepEqual(stages, expected.slice(0, expected.indexOf(failingStage) + 1));
      assert.doesNotMatch(result.stdout, /Deployment completed/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(stages, expected);
      assert.match(result.stdout, /Deployment completed/);
    }
  });
}
