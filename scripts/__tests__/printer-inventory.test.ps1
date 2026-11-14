$ErrorActionPreference='Stop'
function Get-PrinterPort {
 [CmdletBinding()]param()
 @([pscustomobject]@{Name='USB001';PrinterHostAddress=$null},[pscustomobject]@{Name='BTH001';PrinterHostAddress=$null},[pscustomobject]@{Name='IP_10.0.0.2';PrinterHostAddress='10.0.0.2'},[pscustomobject]@{Name='PORTPROMPT:';PrinterHostAddress=$null})
}
function Get-Printer {
 [CmdletBinding()]param()
 @([pscustomobject]@{Name='USB thermal';PortName='USB001';DriverName='Thermal'},[pscustomobject]@{Name='Bluetooth thermal';PortName='BTH001';DriverName='Thermal'},[pscustomobject]@{Name='LAN thermal';PortName='IP_10.0.0.2';DriverName='Thermal'},[pscustomobject]@{Name='Microsoft Print to PDF';PortName='PORTPROMPT:';DriverName='Microsoft Print To PDF'})
}
$neoScript=Join-Path (Split-Path $PSScriptRoot -Parent) 'neo-printer-discovery.ps1'
$neoAll=(& $neoScript -Kind windows) | ConvertFrom-Json
if(@($neoAll.printers).Count -ne 4){throw 'Expected four installed fixture queues'}
if(($neoAll.printers | Where-Object name -eq 'Microsoft Print to PDF').connection_type -ne 'unsupported'){throw 'Virtual queue was offered as physical'}
foreach($neoKind in @('usb','bluetooth','network')){
 $neoResult=(& $neoScript -Kind $neoKind) | ConvertFrom-Json
 if(@($neoResult.printers).Count -ne 1 -or $neoResult.printers[0].transport -ne $neoKind){throw "Incorrect $neoKind inventory filtering"}
}
'PASS native inventory adapter: all queues, USB/Bluetooth/LAN filtering and virtual-printer exclusion.'