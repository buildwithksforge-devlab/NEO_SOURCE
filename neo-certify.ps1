param(
    [switch]$LocalDatabase,
    [switch]$RemotePreflight,
    [switch]$SecurityAudit
)

$ErrorActionPreference = 'Continue'

$started = Get-Date
$stamp = $started.ToString('yyyyMMdd-HHmmss')
$reportDir = Join-Path $PWD 'certification-reports'
$report = Join-Path $reportDir "NEO-CERTIFICATION-$stamp.txt"

New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

$script:Passed = 0
$script:Failed = 0
$script:Warnings = 0

function Write-Report {
    param(
        [string]$Text = '',
        [ConsoleColor]$Color = [ConsoleColor]::Gray
    )

    Write-Host $Text -ForegroundColor $Color
    Add-Content -Path $report -Value $Text
}

function Section {
    param([string]$Name)

    Write-Report ''
    Write-Report ('=' * 78) DarkGray
    Write-Report $Name Cyan
    Write-Report ('=' * 78) DarkGray
}

function Pass {
    param([string]$Message)

    $script:Passed++
    Write-Report "[PASS] $Message" Green
}

function Fail {
    param([string]$Message)

    $script:Failed++
    Write-Report "[FAIL] $Message" Red
}

function Warn {
    param([string]$Message)

    $script:Warnings++
    Write-Report "[WARN] $Message" Yellow
}

function Invoke-CertCommand {
    param(
        [string]$Name,
        [scriptblock]$Command,
        [switch]$Optional
    )

    Write-Report ''
    Write-Report ">>> $Name" White

    try {
        $output = & $Command 2>&1 | Out-String

        if ($output) {
            Write-Report $output.TrimEnd()
        }

        if ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) {
            Pass $Name
            return $true
        }

        if ($Optional) {
            Warn "$Name exited with code $LASTEXITCODE"
            return $false
        }

        Fail "$Name exited with code $LASTEXITCODE"
        return $false
    }
    catch {
        if ($Optional) {
            Warn "$Name could not run: $($_.Exception.Message)"
        }
        else {
            Fail "$Name could not run: $($_.Exception.Message)"
        }

        return $false
    }
}

function Test-CommandExists {
    param([string]$Command)

    return $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Get-PackageScripts {
    if (-not (Test-Path '.\package.json')) {
        return @{}
    }

    $package = Get-Content '.\package.json' -Raw | ConvertFrom-Json

    $scripts = @{}

    if ($package.scripts) {
        $package.scripts.PSObject.Properties | ForEach-Object {
            $scripts[$_.Name] = $_.Value
        }
    }

    return $scripts
}

Write-Report 'NEÃ˜ WHOLE-SYSTEM CERTIFICATION' Magenta
Write-Report "Started: $started"
Write-Report "Project: $PWD"
Write-Report "Machine: $env:COMPUTERNAME"
Write-Report "User: $env:USERNAME"

# ======================================================================
# 1. PROJECT STRUCTURE
# ======================================================================

Section '1. PROJECT STRUCTURE'

$required = @(
    'package.json',
    'src',
    'supabase',
    'supabase\migrations'
)

foreach ($item in $required) {
    if (Test-Path $item) {
        Pass "Found $item"
    }
    else {
        Fail "Missing $item"
    }
}

# ======================================================================
# 2. TOOLCHAIN
# ======================================================================

Section '2. TOOLCHAIN'

foreach ($cmd in @('node', 'npm', 'npx', 'git')) {
    if (Test-CommandExists $cmd) {
        $version = & $cmd --version 2>&1 | Select-Object -First 1
        Pass "$cmd available ($version)"
    }
    else {
        Fail "$cmd not available"
    }
}

# ======================================================================
# 3. SOURCE-CONTROL SAFETY
# ======================================================================

Section '3. SOURCE CONTROL'

if (Test-CommandExists 'git') {
    Invoke-CertCommand 'Git status' {
        git status --short
    } -Optional

    Invoke-CertCommand 'Git branch' {
        git branch --show-current
    } -Optional
}

# ======================================================================
# 4. MERGE / SOURCE CORRUPTION
# ======================================================================

Section '4. SOURCE CORRUPTION SCAN'

$sourceExtensions = @(
    '*.ts','*.tsx','*.js','*.jsx',
    '*.sql','*.json','*.css','*.md'
)

$sourceFiles = foreach ($ext in $sourceExtensions) {
    Get-ChildItem -Recurse -File -Filter $ext -ErrorAction SilentlyContinue |
        Where-Object {
            $_.FullName -notmatch '\\node_modules\\' -and
            $_.FullName -notmatch '\\dist\\' -and
            $_.FullName -notmatch '\\build\\'
        }
}

$mergeProblems = $sourceFiles |
    Select-String -Pattern '^(<<<<<<<|=======|>>>>>>>)' -ErrorAction SilentlyContinue

if ($mergeProblems) {
    Fail "Merge-conflict markers found: $($mergeProblems.Count)"
    $mergeProblems | ForEach-Object {
        Write-Report "  $($_.Path):$($_.LineNumber) $($_.Line)"
    }
}
else {
    Pass 'No merge-conflict markers'
}

# ======================================================================
# 5. MIGRATION INTEGRITY
# ======================================================================

Section '5. DATABASE MIGRATION INTEGRITY'

$migrations = Get-ChildItem '.\supabase\migrations' -File -Filter '*.sql' |
    Sort-Object Name

if ($migrations.Count -gt 0) {
    Pass "$($migrations.Count) SQL migrations discovered"
}
else {
    Fail 'No SQL migrations discovered'
}

$badNames = $migrations |
    Where-Object { $_.Name -notmatch '^\d{14}_.+\.sql$' }

if ($badNames) {
    Warn 'Migration files with non-standard timestamps:'
    $badNames | ForEach-Object {
        Write-Report "  $($_.Name)"
    }
}
else {
    Pass 'Migration filenames use timestamp convention'
}

$duplicateVersions = $migrations |
    ForEach-Object {
        [PSCustomObject]@{
            Version = $_.BaseName.Substring(0, [Math]::Min(14, $_.BaseName.Length))
            Name = $_.Name
        }
    } |
    Group-Object Version |
    Where-Object Count -gt 1

if ($duplicateVersions) {
    Fail 'Duplicate migration timestamps detected'

    foreach ($group in $duplicateVersions) {
        Write-Report "  Timestamp $($group.Name)"
        $group.Group | ForEach-Object {
            Write-Report "    $($_.Name)"
        }
    }
}
else {
    Pass 'No duplicate migration timestamps'
}

# ======================================================================
# 6. BATCH ARCHITECTURE CONTRACT
# ======================================================================

Section '6. BATCH INVENTORY ARCHITECTURE'

$batchMigration =
    '.\supabase\migrations\20261005123000_batch_operational_consumption.sql'

if (Test-Path $batchMigration) {

    $batchSql = Get-Content $batchMigration -Raw

    $markers = @(
        'batch_component_log_only',
        'batch_operational_consumption',
        'batch_canonical_recipe_consumption',
        'neo_consume_prepared_batch',
        'inventory_convert_strict',
        'remaining_quantity',
        'consumed_quantity',
        'batch.operational.restored'
    )

    foreach ($marker in $markers) {
        if ($batchSql.Contains($marker)) {
            Pass "Batch contract: $marker"
        }
        else {
            Fail "Batch contract missing: $marker"
        }
    }

    $productionStart =
        $batchSql.IndexOf(
            'CREATE OR REPLACE FUNCTION public.neo_production_batch_post'
        )

    $allocatorStart =
        $batchSql.IndexOf(
            'CREATE OR REPLACE FUNCTION public.neo_consume_prepared_batch'
        )

    if ($productionStart -ge 0 -and $allocatorStart -gt $productionStart) {

        $productionBody =
            $batchSql.Substring(
                $productionStart,
                $allocatorStart - $productionStart
            )

        if ($productionBody -match 'inventory_apply_movement\s*\(') {
            Fail 'New production posting still performs inventory movement'
        }
        else {
            Pass 'Production posting performs no canonical stock movement'
        }
    }
    else {
        Fail 'Could not isolate production batch function'
    }

    if (
        $batchSql -match
        'v_batch_use_recipe\s*/\s*v_recipe\.yield_quantity'
    ) {
        Pass 'Batch recipe fraction is based on actual batch usage'
    }
    else {
        Fail 'Batch canonical quantity calculation not found'
    }

}
else {
    Fail 'Batch architecture migration not found'
}

# ======================================================================
# 7. AUTHORIZATION / SECURITY-DEFINER SCAN
# ======================================================================

Section '7. DATABASE FUNCTION SECURITY'

$sqlFiles = Get-ChildItem '.\supabase\migrations' -File -Filter '*.sql'

$securityDefinerCount = 0
$searchPathWarnings = 0

foreach ($file in $sqlFiles) {
    $content = Get-Content $file.FullName -Raw

    $securityDefinerCount +=
        ([regex]::Matches(
            $content,
            'SECURITY\s+DEFINER',
            'IgnoreCase'
        )).Count
}

Write-Report "SECURITY DEFINER occurrences: $securityDefinerCount"

$potentialUnsafe = $sqlFiles |
    Select-String -Pattern 'SECURITY DEFINER' |
    Where-Object {
        $text = Get-Content $_.Path -Raw
        $text -notmatch 'SET\s+search_path'
    }

if ($potentialUnsafe) {
    Warn 'Some migration files contain SECURITY DEFINER without an obvious search_path'
}
else {
    Pass 'SECURITY DEFINER migration scan completed'
}

# ======================================================================
# 8. SECRET / KEY SCAN
# ======================================================================

Section '8. SECRET AND KEY SCAN'

$secretPatterns = @(
    'service_role_key\s*[:=]\s*["''][A-Za-z0-9_\-\.]{20,}',
    'SUPABASE_SERVICE_ROLE_KEY\s*=\s*[A-Za-z0-9_\-\.]{20,}',
    'sk_live_[A-Za-z0-9]+',
    '-----BEGIN PRIVATE KEY-----'
)

$secretHits = @()

foreach ($pattern in $secretPatterns) {
    $secretHits += $sourceFiles |
        Select-String -Pattern $pattern -ErrorAction SilentlyContinue
}

if ($secretHits) {
    Fail "Potential hard-coded secrets detected: $($secretHits.Count)"

    $secretHits |
        Select-Object Path, LineNumber |
        ForEach-Object {
            Write-Report "  $($_.Path):$($_.LineNumber)"
        }
}
else {
    Pass 'No obvious hard-coded production secrets detected'
}

# ======================================================================
# 9. TODO / FIXME / HACK
# ======================================================================

Section '9. UNFINISHED-CODE SCAN'

$unfinished = $sourceFiles |
    Select-String -Pattern '\b(TODO|FIXME|HACK|XXX)\b' `
    -ErrorAction SilentlyContinue

if ($unfinished) {
    Warn "$($unfinished.Count) TODO/FIXME/HACK markers remain"

    $unfinished |
        Select-Object -First 40 |
        ForEach-Object {
            Write-Report "  $($_.Path):$($_.LineNumber) $($_.Line.Trim())"
        }
}
else {
    Pass 'No TODO/FIXME/HACK markers'
}

# ======================================================================
# 10. PACKAGE TESTS
# ======================================================================

Section '10. TYPESCRIPT / FRONTEND / UNIT TESTS'

$scripts = Get-PackageScripts

if ($scripts.ContainsKey('typecheck')) {
    Invoke-CertCommand 'TypeScript typecheck' {
        npm run typecheck
    }
}
else {
    Invoke-CertCommand 'TypeScript compiler noEmit' {
        npx tsc --noEmit
    } -Optional
}

if ($scripts.ContainsKey('lint')) {
    Invoke-CertCommand 'ESLint / project lint' {
        npm run lint
    }
}
else {
    Warn 'No lint package script configured'
}

# Always run Vitest directly so every discovered test is included.
Invoke-CertCommand 'Complete Vitest suite' {
    npx vitest run
}

if (Test-Path '.\src\lib\__tests__\batch-sale-consumption-contract.test.ts') {
    Invoke-CertCommand 'Prepared batch inventory contract' {
        npx vitest run `
          src/lib/__tests__/batch-sale-consumption-contract.test.ts
    }
}

# ======================================================================
# 11. PRODUCTION BUILD
# ======================================================================

Section '11. PRODUCTION BUILD'

if ($scripts.ContainsKey('build')) {
    Invoke-CertCommand 'Production application build' {
        npm run build
    }
}
else {
    Warn 'No build script configured'
}

# ======================================================================
# 12. TEST INVENTORY
# ======================================================================

Section '12. AUTOMATED TEST INVENTORY'

$testFiles = Get-ChildItem '.\src' -Recurse -File `
    -Include '*.test.ts','*.test.tsx','*.spec.ts','*.spec.tsx' `
    -ErrorAction SilentlyContinue

Write-Report "Automated test files: $($testFiles.Count)"

$areas = @{
    'POS / Orders' =
        'pos|order|kds|sale|void|payment'
    'Inventory / Stores' =
        'inventory|stock|store|requisition|procurement|grn'
    'Finance' =
        'finance|journal|folio|receipt|refund|till|cash'
    'Front Office / PMS' =
        'reservation|arrival|checkin|checkout|folio|room'
    'Kitchen / Production' =
        'kitchen|recipe|batch|production|waste'
    'Housekeeping' =
        'housekeep'
    'Laundry' =
        'laundry'
    'Maintenance' =
        'maintenance|asset'
    'Delivery' =
        'delivery|rider|pin'
    'Events' =
        'event|conference|beo'
    'Auth / Permissions' =
        'auth|permission|role|login|session'
}

foreach ($area in $areas.GetEnumerator()) {

    $matching = $testFiles |
        Where-Object {
            $_.Name -match $area.Value -or
            $_.FullName -match $area.Value
        }

    if ($matching.Count -gt 0) {
        Pass "$($area.Key): $($matching.Count) automated test file(s)"
    }
    else {
        Warn "$($area.Key): no specifically named automated test found"
    }
}

# ======================================================================
# 13. LOCAL SUPABASE CERTIFICATION
# ======================================================================

if ($LocalDatabase) {

    Section '13. LOCAL SUPABASE DATABASE CERTIFICATION'

    if (-not (Test-CommandExists 'npx')) {
        Fail 'npx unavailable - cannot run Supabase'
    }
    else {

        Invoke-CertCommand 'Supabase CLI version' {
            npx supabase --version
        }

        Invoke-CertCommand 'Start local Supabase stack' {
            npx supabase start
        }

        Write-Report ''
        Write-Report 'LOCAL DATABASE RESET:' Yellow
        Write-Report 'This deletes only the LOCAL Supabase database and replays every migration.' Yellow

        $answer =
            Read-Host 'Type RESET-LOCAL to perform the complete local migration rebuild'

        if ($answer -eq 'RESET-LOCAL') {

            Invoke-CertCommand 'Full local DB reset / migration replay' {
                npx supabase db reset --local
            }

            Invoke-CertCommand 'Local PL/pgSQL schema lint' {
                npx supabase db lint `
                    --local `
                    --level error `
                    --fail-on error
            }

            Invoke-CertCommand 'Local migration history' {
                npx supabase migration list --local
            }
        }
        else {
            Warn 'Local database rebuild skipped by operator'
        }
    }
}

# ======================================================================
# 14. REMOTE DATABASE PREFLIGHT
# ======================================================================

if ($RemotePreflight) {

    Section '14. LIVE / LINKED DATABASE PREFLIGHT'

    Write-Report 'NO MIGRATIONS WILL BE APPLIED IN THIS SECTION.' Yellow

    Invoke-CertCommand 'Local vs remote migration history' {
        npx supabase migration list --linked
    }

    Invoke-CertCommand 'Remote DB push dry-run' {
        npx supabase db push --dry-run
    }

    Invoke-CertCommand 'Remote database PL/pgSQL lint' {
        npx supabase db lint `
            --linked `
            --level error `
            --fail-on error
    } -Optional
}

# ======================================================================
# 15. DEPENDENCY AUDIT
# ======================================================================

if ($SecurityAudit) {

    Section '15. NPM DEPENDENCY SECURITY'

    Invoke-CertCommand 'npm production dependency audit' {
        npm audit --omit=dev
    } -Optional
}

# ======================================================================
# FINAL RESULT
# ======================================================================

Section 'CERTIFICATION RESULT'

$ended = Get-Date
$duration = $ended - $started

Write-Report "PASS:     $script:Passed" Green
Write-Report "FAIL:     $script:Failed" $(if ($script:Failed) { 'Red' } else { 'Green' })
Write-Report "WARNINGS: $script:Warnings" Yellow
Write-Report "Duration: $($duration.ToString())"
Write-Report "Report:   $report"

Write-Report ''

if ($script:Failed -eq 0) {
    Write-Report 'AUTOMATED CERTIFICATION: PASS' Green
    exit 0
}
else {
    Write-Report 'AUTOMATED CERTIFICATION: FAILED' Red
    exit 1
}
