$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$log = Join-Path $root 'FINAL_GATE_OUTPUT.txt'
"NEØ FINAL GATE - $(Get-Date -Format o)" | Set-Content $log

function Run-Step($name, $cmd) {
  "`n=== $name ===" | Tee-Object -FilePath $log -Append
  Invoke-Expression $cmd 2>&1 | Tee-Object -FilePath $log -Append
  if ($LASTEXITCODE -ne 0) { throw "$name failed with exit code $LASTEXITCODE" }
}

$nodeVersion = node -v
"Node: $nodeVersion" | Tee-Object -FilePath $log -Append
if (-not $nodeVersion.StartsWith('v22.')) { throw "Node 22 is required. Current: $nodeVersion" }

Run-Step 'Clean install' 'npm ci --no-audit --no-fund'
Run-Step 'Typecheck' 'npm run typecheck'
Run-Step 'Offline tests' 'npm run test:offline'
$env:NEO_SECRET_LEAK_SENTINEL = 'NEO_TEST_SENTINEL_20260925'
Run-Step 'Production build' 'npm run build'
Run-Step 'Secret scan' 'npm run secret-scan'
Run-Step 'Build smoke' 'npm run smoke'

"`nFINAL GATE: PASS" | Tee-Object -FilePath $log -Append
Write-Host "PASS. Send FINAL_GATE_OUTPUT.txt back to ChatGPT for the live deployment/certification phase."
