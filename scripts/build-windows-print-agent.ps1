param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\public\downloads'))
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Install .NET Framework 4.8 before building the Windows print agent.' }
$stage = Join-Path ([IO.Path]::GetTempPath()) ('neo-print-agent-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$source = Join-Path $PSScriptRoot '..\agents\windows\NeoPrintAgent.cs'
& $compiler /nologo /target:winexe /optimize+ ("/out:" + (Join-Path $stage 'NEOPrintAgent.exe')) /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Net.Http.dll /r:System.Web.Extensions.dll /r:System.Security.dll $source
if ($LASTEXITCODE -ne 0) { throw 'Windows agent compilation failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\agents\windows\Install Print Agent.cmd') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\agents\windows\README.txt') -Destination $stage
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$archive = Join-Path $OutputDirectory 'NEO-Print-Agent-Windows.zip'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'NEO-Print-Agent-Windows.sha256'), $hash + '  NEO-Print-Agent-Windows.zip' + [Environment]::NewLine)
Write-Output ('Built Windows print agent: ' + $hash)
