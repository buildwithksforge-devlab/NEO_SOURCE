[CmdletBinding()]
param(
  [string]$NodeDirectory,
  [Parameter(Mandatory=$true)][string]$BaselineJson,
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory
)
$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if($NodeDirectory){$env:PATH="$NodeDirectory;$env:PATH"}
$neoNpm=(Get-Command npm.cmd -ErrorAction Stop).Source
$neoVersion=& node --version
if($neoVersion -notmatch '^v22\.'){throw 'Use the Node 22 version specified by .nvmrc'}
$neoBaseline=Get-Content -Raw -LiteralPath $BaselineJson | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$neoEvidenceRoot=(Resolve-Path -LiteralPath $EvidenceDirectory).Path
function Invoke-NeoCheck([string]$Name,[string[]]$Arguments){
  & $neoNpm @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $neoEvidenceRoot "$Name.log")
  if($LASTEXITCODE -ne 0){throw "$Name failed. See the saved log; no promotion is allowed."}
}
git diff --check
if($LASTEXITCODE -ne 0){throw 'Git diff check failed'}
Invoke-NeoCheck 'typecheck' @('run','typecheck')
$neoResultPath=Join-Path $neoEvidenceRoot 'offline-tests.json'
Invoke-NeoCheck 'offline-tests' @('run','test:offline','--','--maxWorkers=2','--reporter=default','--reporter=json',"--outputFile=$neoResultPath")
$neoCurrent=Get-Content -Raw -LiteralPath $neoResultPath | ConvertFrom-Json
function Get-NeoAssertionKey($File,$Assertion){
  $neoFileName=([string]$File.name).Replace([char]92,[char]47)
  $neoIndex=$neoFileName.LastIndexOf('/src/')
  if($neoIndex -ge 0){$neoFileName=$neoFileName.Substring($neoIndex+1)}
  return "${neoFileName}::$($Assertion.fullName)"
}
$neoNow=@{}
foreach($neoFile in $neoCurrent.testResults){foreach($neoAssertion in $neoFile.assertionResults){$neoNow[(Get-NeoAssertionKey $neoFile $neoAssertion)]=$neoAssertion.status}}
$neoRegressions=@(foreach($neoFile in $neoBaseline.testResults){foreach($neoAssertion in $neoFile.assertionResults){
  if($neoAssertion.status -eq 'passed'){
    $neoKey=Get-NeoAssertionKey $neoFile $neoAssertion
    if($neoNow[$neoKey] -ne 'passed'){[pscustomobject]@{Check=$neoKey;Observed=$neoNow[$neoKey]}}
  }
}})
ConvertTo-Json -InputObject @($neoRegressions) -Depth 5 | Set-Content (Join-Path $neoEvidenceRoot 'regressions.json') -Encoding utf8
if($neoRegressions.Count -gt 0){throw "$($neoRegressions.Count) formerly passed checks regressed, disappeared or were skipped"}
Invoke-NeoCheck 'device-capability-catalogue' @('run','test:repair-db')
Invoke-NeoCheck 'local-print-agent' @('run','test:print-agent')
Invoke-NeoCheck 'build-smoke' @('run','smoke')
[pscustomobject]@{
  Source=(Get-Location).Path
  Commit=(git rev-parse HEAD)
  Node=$neoVersion
  CompletedAtUtc=[DateTime]::UtcNow.ToString('o')
  OfflinePass=$neoCurrent.numPassedTests
  OfflineFail=$neoCurrent.numFailedTests
  OfflineSkipped=$neoCurrent.numPendingTests
  LostPreviouslyPassedChecks=$neoRegressions.Count
  SourceVerification='PASS'
  LaunchDecision='NO-GO pending per-workflow UAT evidence'
} | ConvertTo-Json | Set-Content (Join-Path $neoEvidenceRoot 'verification-summary.json') -Encoding utf8
Write-Host 'Source checks passed with no lost baseline passes. UAT promotion remains a separate evidence gate.'
