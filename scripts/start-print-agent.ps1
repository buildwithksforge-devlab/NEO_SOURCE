[CmdletBinding()]
param([string]$NodeDirectory,[string]$ConfigPath,[ValidateSet('windows','usb','bluetooth','network')][string]$Discover)
$ErrorActionPreference='Stop'
$neoRoot=Split-Path $PSScriptRoot -Parent
if($NodeDirectory){$env:PATH="$NodeDirectory;$env:PATH"}
$neoNode=(Get-Command node.exe -ErrorAction Stop).Source
$neoVersion=& $neoNode --version
if($neoVersion -notmatch '^v22\.'){throw 'Use the Node 22 runtime specified by this project.'}
if($Discover){
 if($Discover -eq 'network'){throw 'Run Wi-Fi/LAN discovery from the Configuration Centre with the paired agent running. For installed network queues use -Discover windows.'}
 & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'neo-printer-discovery.ps1') -Kind $Discover
 exit $LASTEXITCODE
}
if(-not $ConfigPath){$ConfigPath=Join-Path $neoRoot 'neo-print-agent.json'}
$neoConfig=(Resolve-Path -LiteralPath $ConfigPath -ErrorAction Stop).Path
Write-Host 'Starting the local NEØ print agent. Keep this terminal running; Ctrl+C stops it.'
& $neoNode (Join-Path $PSScriptRoot 'neo-print-agent.mjs') $neoConfig
exit $LASTEXITCODE