param(
    [string]$PrinterName,
    [switch]$TestPrint
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "    NEO PRINTER HARDWARE DIAGNOSTICS"
Write-Host "======================================" -ForegroundColor Cyan

if (!(Get-Command Get-Printer -ErrorAction SilentlyContinue)) {
    throw "Windows PrintManagement is unavailable."
}

$printers = @(Get-Printer)

Write-Host ""
Write-Host "WINDOWS INSTALLED PRINTERS" -ForegroundColor Yellow

if ($printers.Count -eq 0) {
    Write-Host "No printers installed." -ForegroundColor Red
}
else {
    $printers |
        Select-Object Name, DriverName, PortName, PrinterStatus |
        Format-Table -AutoSize
}

Write-Host ""
Write-Host "PRINTER CONNECTION PORTS" -ForegroundColor Yellow

Get-PrinterPort |
    Select-Object Name, PrinterHostAddress, PortNumber, Description |
    Format-Table -AutoSize

Write-Host ""
Write-Host "SERIAL / BLUETOOTH COM PORTS" -ForegroundColor Yellow

Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue |
    Select-Object Name, DeviceID, Description |
    Format-Table -AutoSize

if ($TestPrint) {

    if (!$PrinterName) {
        throw "Specify -PrinterName when using -TestPrint."
    }

    $selected = $printers |
        Where-Object { $_.Name -eq $PrinterName } |
        Select-Object -First 1

    if (!$selected) {
        throw "Printer not installed: $PrinterName"
    }

    $ticket = @"
NEO HOSPITALITY OPERATING SYSTEM
--------------------------------
WINDOWS PRINT CONNECTION TEST

Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

Printer: $PrinterName

This is a connection test.

--------------------------------
NEO PRINTING DIAGNOSTICS
"@

    $ticket | Out-Printer -Name $PrinterName

    Write-Host ""
    Write-Host "Print job submitted to Windows." -ForegroundColor Green
    Write-Host "Check the physical printer for paper output." -ForegroundColor Yellow
    Write-Host "Submission does not prove physical printing succeeded."
}

Write-Host ""
Write-Host "Diagnostics completed." -ForegroundColor Green
