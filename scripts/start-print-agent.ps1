[CmdletBinding()]
param([string]$NodeDirectory,[string]$ConfigPath,[ValidateSet('windows','usb','bluetooth','network')][string]$Discover)
$ErrorActionPreference='Stop'
$neoRoot=Split-Path $PSScriptRoot -Parent
if($Discover -and $Discover -ne 'network'){
 & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'neo-printer-discovery.ps1') -Kind $Discover
 exit $LASTEXITCODE
}
if($NodeDirectory){$env:PATH="$NodeDirectory;$env:PATH"}
$neoNode=(Get-Command node.exe -ErrorAction Stop).Source
$neoVersion=& $neoNode --version
if($neoVersion -notmatch '^v22\.'){throw 'Use the Node 22 runtime specified by this project.'}
if($Discover -eq 'network'){
 & $neoNode (Join-Path $PSScriptRoot 'neo-printer-discovery-cli.mjs') network
 exit $LASTEXITCODE
}
if(-not $ConfigPath){$ConfigPath=Join-Path $neoRoot 'neo-print-agent.json'}
if(-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)){
 throw 'Agent configuration is missing. In Configuration Centre > Printers, pair this property computer and download its private neo-print-agent.json. Run again with -ConfigPath pointing to that file. Local discovery with -Discover windows or -Discover network does not require pairing.'
}
$neoConfig=(Resolve-Path -LiteralPath $ConfigPath -ErrorAction Stop).Path
Write-Host 'Starting the local NEØ print agent. Keep this terminal running; Ctrl+C stops it.'
& $neoNode (Join-Path $PSScriptRoot 'neo-print-agent.mjs') $neoConfig
exit $LASTEXITCODE
