$ErrorActionPreference = "Stop"

$EXPECTED_WORKER = "neo-preview"
$EXPECTED_ACCOUNT = "a8f39d59dfcd73614466adf7d87a907d"
$EXPECTED_URL = "https://neo-preview.neo-hospitality.workers.dev"

Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# Use installed package entrypoints; do not depend on the host NVM npm/npx trust shim.
$tscEntry = Join-Path (Get-Location).Path "node_modules/typescript/bin/tsc"
$viteEntry = Join-Path (Get-Location).Path "node_modules/vite/bin/vite.js"
$wranglerEntry = Join-Path (Get-Location).Path "node_modules/wrangler/bin/wrangler.js"
if (!(Test-Path -LiteralPath $wranglerEntry)) {
    $cachedWrangler = Get-ChildItem (Join-Path $env:LOCALAPPDATA "npm-cache/_npx") -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object { Join-Path $_.FullName "node_modules/wrangler/bin/wrangler.js" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if (!$cachedWrangler) { throw "Install Wrangler before deployment; no package was downloaded." }
    $wranglerEntry = $cachedWrangler
}
if (!(Test-Path -LiteralPath $tscEntry) -or !(Test-Path -LiteralPath $viteEntry)) {
    throw "Install project dependencies before deployment."
}

node scripts/check-migration-versions.mjs
if ($LASTEXITCODE -ne 0) { throw "Migration versions failed. Deployment cancelled." }

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "NEO PROTECTED DEPLOYMENT" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "TARGET: $EXPECTED_URL"
Write-Host "WORKER: $EXPECTED_WORKER"

# Check TypeScript before building.
Write-Host "`nChecking TypeScript..." -ForegroundColor Yellow

node $tscEntry --noEmit

if ($LASTEXITCODE -ne 0) {
    throw "TypeScript failed. Deployment cancelled."
}

# Build fresh application.
Write-Host "`nBuilding NEØ..." -ForegroundColor Yellow

node $viteEntry build

if ($LASTEXITCODE -ne 0) {
    throw "Build failed. Deployment cancelled."
}

node scripts/build-smoke.mjs --no-build
if ($LASTEXITCODE -ne 0) { throw "Built-server smoke failed. Deployment cancelled." }

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
# Keep the verified runtime contract. Nitro's local calendar date can already
# be tomorrow in Nairobi while Cloudflare still rejects it as a future UTC day.
$config.compatibility_date = "2026-11-13"

# Runtime settings belong to the existing Worker. A generated build has no
# vars; deploying it must not erase saved backend routing or provider settings.
$config | Add-Member -NotePropertyName "keep_vars" -NotePropertyValue $true -Force

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

if ($verify.keep_vars -ne $true) {
    throw "Runtime variable preservation disabled. Deployment blocked."
}

# Confirm that the original Worker already exists.
Write-Host "`nChecking original Worker..." -ForegroundColor Yellow

node $wranglerEntry deployments list --name $EXPECTED_WORKER --json | Out-Null

if ($LASTEXITCODE -ne 0) {
    throw "Original Worker not found. Deployment blocked."
}

Write-Host "`nDeploying ONLY to neo-preview..." -ForegroundColor Green

node $wranglerEntry deploy --config $configPath

if ($LASTEXITCODE -ne 0) {
    throw "Deployment failed."
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Green
Write-Host "NEO DEPLOYMENT SUCCESSFUL" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Green
Write-Host $EXPECTED_URL
