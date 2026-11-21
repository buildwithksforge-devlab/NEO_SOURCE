[CmdletBinding()]
param(
  [string]$NodeDirectory,
  [ValidateRange(1024,65535)][int]$Port=3000,
  [switch]$Check
)
$ErrorActionPreference='Stop'
$neoRoot=Split-Path $PSScriptRoot -Parent
if($NodeDirectory){
  $neoRuntime=(Resolve-Path -LiteralPath $NodeDirectory).Path
  if(-not (Test-Path -LiteralPath (Join-Path $neoRuntime 'node.exe')) -or -not (Test-Path -LiteralPath (Join-Path $neoRuntime 'npm.cmd'))){throw 'NodeDirectory must contain node.exe and npm.cmd'}
  $env:PATH="$neoRuntime;$env:PATH"
}
$neoNode=(Get-Command node -ErrorAction Stop).Source
$neoVersion=& $neoNode --version
if($neoVersion -notmatch '^v22\.'){throw 'Use Node 22 as specified by .nvmrc'}
if(-not (Test-Path -LiteralPath (Join-Path $neoRoot 'node_modules'))){throw 'Install the locked dependencies with npm ci before starting'}
Push-Location $neoRoot
try{
  if($Check){
    [pscustomobject]@{Source=$neoRoot;Node=$neoVersion;Url="http://127.0.0.1:$Port";Mode='Simulation connection check'}
    & $neoNode --disable-warning=ExperimentalWarning --env-file-if-exists=.env.local scripts/check-simulation-connection.mjs
    exit $LASTEXITCODE
  }
  & $neoNode --env-file-if-exists=.env.local node_modules/vite/bin/vite.js dev --host 127.0.0.1 --port $Port --strictPort
  if($LASTEXITCODE -ne 0){throw "Local server exited with code $LASTEXITCODE"}
}finally{Pop-Location}
