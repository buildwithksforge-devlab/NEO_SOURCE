param([ValidateSet('windows','usb','bluetooth','network')][string]$Kind='windows')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$neoPorts=@{}
Get-PrinterPort -ErrorAction Stop | ForEach-Object {$neoPorts[$_.Name]=$_}
$neoPrinters=@(Get-Printer -ErrorAction Stop | ForEach-Object {
 $neoPort=$neoPorts[$_.PortName]
 $neoTransport=if($_.PortName -match 'BTH|Bluetooth'){'bluetooth'}elseif($_.PortName -match '^USB|^DOT4'){'usb'}elseif($neoPort.PrinterHostAddress -or $_.PortName -match '^WSD|^IP_'){'network'}else{'windows'}
 if($Kind -eq 'windows' -or $Kind -eq $neoTransport){
  $neoVirtual=($_.DriverName+' '+$_.Name) -match 'Microsoft Print To PDF|Microsoft XPS|OneNote|Adobe PDF|PDFCreator|\bFax\b'
  $neoConnection=if($neoVirtual){'unsupported'}else{'windows'}
  $neoNote=if($neoVirtual){'Virtual document queue; not a physical ESC/POS printer.'}else{'Installed queue detected; verify ESC/POS compatibility and a labelled test print.'}
  [pscustomobject]@{name=$_.Name;address=$_.Name;connection_type=$neoConnection;transport=$neoTransport;source='Windows installed queue';driver=$_.DriverName;note=$neoNote}
 }
} | Select-Object -First 100)
[pscustomobject]@{printers=$neoPrinters;notes=@('USB/Bluetooth devices must be paired or installed in Windows first. This searches actual installed queues; it does not perform radio pairing or install drivers.')} | ConvertTo-Json -Depth 5 -Compress