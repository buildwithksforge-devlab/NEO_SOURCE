$ErrorActionPreference = "Stop"

$EXPECTED_WORKER = "neo-preview"
$EXPECTED_ACCOUNT = "a8f39d59dfcd73614466adf7d87a907d"
$EXPECTED_URL = "https://neo-preview.neo-hospitality.workers.dev"

Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "NEO PROTECTED DEPLOYMENT" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "TARGET: $EXPECTED_URL"
Write-Host "WORKER: $EXPECTED_WORKER"

# Check TypeScript before building.
Write-Host "`nChecking TypeScript..." -ForegroundColor Yellow

npx tsc --noEmit

if ($LASTEXITCODE -ne 0) {
    throw "TypeScript failed. Deployment cancelled."
}

# Build fresh application.
Write-Host "`nBuilding NEØ..." -ForegroundColor Yellow

npm run build

if ($LASTEXITCODE -ne 0) {
    throw "Build failed. Deployment cancelled."
}

# Nitro generates the configuration here.
$configPath = ".output/server/wrangler.json"

if (!(Test-Path $configPath)) {
    throw "Wrangler configuration missing. Deployment cancelled."
}

# Preserve the generated configuration before modifying it.
Copy-Item $configPath "$configPath.BEFORE_PROTECTED_DEPLOY" -Force

$config = Get-Content $configPath -Raw | ConvertFrom-Json

Write-Host "Generated Worker: $($config.name)"

# Force the existing original Worker.
$config.name = $EXPECTED_WORKER

# Set the account explicitly.
if ($config.PSObject.Properties.Name -contains "account_id") {
    $config.account_id = $EXPECTED_ACCOUNT
} else {
    $config | Add-Member -NotePropertyName "account_id" -NotePropertyValue $EXPECTED_ACCOUNT
}

# Write UTF-8 without BOM.
$utf8 = New-Object System.Text.UTF8Encoding($false)

$json = $config | ConvertTo-Json -Depth 100

[System.IO.File]::WriteAllText(
    (Join-Path (Get-Location).Path $configPath),
    $json,
    $utf8
)

# Verify before any deployment.
$verify = Get-Content $configPath -Raw | ConvertFrom-Json

if ($verify.name -ne $EXPECTED_WORKER) {
    throw "WRONG WORKER. Deployment blocked."
}

if ($verify.account_id -ne $EXPECTED_ACCOUNT) {
    throw "WRONG CLOUDFLARE ACCOUNT. Deployment blocked."
}

# Confirm that the original Worker already exists.
Write-Host "`nChecking original Worker..." -ForegroundColor Yellow

npx wrangler deployments list --name $EXPECTED_WORKER --json | Out-Null

if ($LASTEXITCODE -ne 0) {
    throw "Original Worker not found. Deployment blocked."
}

Write-Host "`nDeploying ONLY to neo-preview..." -ForegroundColor Green

npx wrangler deploy --config $configPath

if ($LASTEXITCODE -ne 0) {
    throw "Deployment failed."
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Green
Write-Host "NEO DEPLOYMENT SUCCESSFUL" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Green
Write-Host $EXPECTED_URL