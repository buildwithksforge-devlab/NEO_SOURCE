param(
    [ValidateSet("List","Print","Test")]
    [string]$Action = "List",

    [ValidateSet("Windows","Bluetooth","Network")]
    [string]$Type = "Windows",

    [string]$PrinterName,
    [string]$Port,
    [string]$HostAddress,

    [int]$TcpPort = 9100,

    [string]$Station = "Kitchen",
    [string]$JobId,
    [string]$Text = "NEO HOSPITALITY TEST PRINT",

    [switch]$Simulation
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$stateFolder = Join-Path $root "state"

New-Item -ItemType Directory -Path $stateFolder -Force | Out-Null

function Show-Printers {

    Write-Host "`nNEO LOCAL PRINTING ENGINE" -ForegroundColor Cyan

    Write-Host "`nWINDOWS PRINTERS" -ForegroundColor Yellow

    Get-Printer |
        Select-Object Name,DriverName,PortName,PrinterStatus |
        Format-Table -AutoSize

    Write-Host "`nBLUETOOTH / SERIAL PORTS" -ForegroundColor Yellow

    Get-CimInstance Win32_SerialPort |
        Select-Object Name,DeviceID |
        Format-Table -AutoSize
}

function Send-Network {

    param(
        [string]$Address,
        [int]$PortNumber,
        [byte[]]$Bytes
    )

    $ip = [System.Net.IPAddress]::None

    if (-not [System.Net.IPAddress]::TryParse(
        $Address,
        [ref]$ip
    )) {
        throw "A valid printer IP address is required."
    }

    if ($ip.AddressFamily -ne
        [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw "Only IPv4 network printers are supported here."
    }

    $client = [System.Net.Sockets.TcpClient]::new()

    $connected = $false

    try {
        $connectTask = $client.ConnectAsync($ip,$PortNumber)

        if (-not $connectTask.Wait(5000)) {
            throw "Printer connection timed out."
        }

        $connected = $true

        $stream = $client.GetStream()
        $stream.WriteTimeout = 5000
        $stream.Write($Bytes,0,$Bytes.Length)
        $stream.Flush()
    }
    catch {
        if ($connected) {
            throw "Network delivery uncertain: $($_.Exception.Message)"
        }

        throw "Network printer connection failed: $($_.Exception.Message)"
    }
    finally {
        $client.Dispose()
    }
}

function Send-Bluetooth {

    param(
        [string]$ComPort,
        [byte[]]$Bytes
    )

    if ($ComPort -notmatch '^COM\d{1,3}$') {
        throw "A valid COM port is required."
    }

    $serial = [System.IO.Ports.SerialPort]::new(
        $ComPort,
        9600,
        [System.IO.Ports.Parity]::None,
        8,
        [System.IO.Ports.StopBits]::One
    )

    $serial.WriteTimeout = 5000

    $opened = $false

    try {
        $serial.Open()
        $opened = $true
        $serial.Write($Bytes,0,$Bytes.Length)
    }
    catch {
        if ($opened) {
            throw "Bluetooth delivery uncertain: $($_.Exception.Message)"
        }

        throw "Bluetooth printer connection failed: $($_.Exception.Message)"
    }
    finally {
        $serial.Dispose()
    }
}

function Send-Windows {

    param(
        [string]$Name,
        [string]$Content
    )

    $printer = Get-Printer -Name $Name -ErrorAction SilentlyContinue

    if (!$printer) {
        throw "Windows printer not installed: $Name"
    }

    $Content | Out-Printer -Name $Name
}

if ($Action -eq "List") {
    Show-Printers
    return
}

if (!$JobId) {
    $JobId = [guid]::NewGuid().ToString()
}

if ($JobId -notmatch '^[a-zA-Z0-9_-]{1,100}$') {
    throw "Invalid print job identifier."
}

$recordPath = Join-Path $stateFolder "$JobId.json"

if (Test-Path -LiteralPath $recordPath) {
    $previous = Get-Content -LiteralPath $recordPath -Raw |
        ConvertFrom-Json

    Write-Host "Job already recorded: $($previous.status)" -ForegroundColor Yellow
    Write-Host "Existing job will not be printed again automatically."
    return
}

$ticket = @"
NEO HOSPITALITY OPERATING SYSTEM
================================
STATION: $Station
JOB: $JobId
DATE: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
--------------------------------
$Text
--------------------------------
NEO LOCAL PRINTING
"@

$bytes = [System.Text.Encoding]::ASCII.GetBytes(
    $ticket + "`n`n`n"
)

$record = @{
    job_id = $JobId
    station = $Station
    type = $Type
    status = "dispatching"
    created_at = (Get-Date).ToString("o")
    error = $null
}

# Record the job BEFORE delivery to avoid silently
# dispatching the same identifier multiple times.
$record |
    ConvertTo-Json |
    Set-Content -LiteralPath $recordPath -Encoding UTF8

try {

    if ($Simulation) {

        $record.status = "simulated"
        Write-Host "[SIMULATION] $Station ticket processed" -ForegroundColor Green

    }
    elseif ($Type -eq "Windows") {

        if (!$PrinterName) {
            throw "PrinterName is required."
        }

        Send-Windows -Name $PrinterName -Content $ticket

        $record.status = "submitted_to_windows"

    }
    elseif ($Type -eq "Bluetooth") {

        if (!$Port) {
            throw "Bluetooth COM port is required."
        }

        Send-Bluetooth -ComPort $Port -Bytes $bytes

        $record.status = "bytes_sent"

    }
    elseif ($Type -eq "Network") {

        if (!$HostAddress) {
            throw "Network printer address is required."
        }

        Send-Network `
            -Address $HostAddress `
            -PortNumber $TcpPort `
            -Bytes $bytes

        $record.status = "bytes_sent"
    }

    Write-Host "JOB: $JobId" -ForegroundColor Cyan
    Write-Host "STATUS: $($record.status)" -ForegroundColor Green
    Write-Host "Paper output has NOT been independently verified." -ForegroundColor Yellow
}
catch {

    $record.status = "outcome_requires_review"
    $record.error = $_.Exception.Message

    Write-Host "[FAIL] $($record.error)" -ForegroundColor Red
    Write-Host "Review before retrying this job." -ForegroundColor Yellow
}
finally {

    $record.completed_at = (Get-Date).ToString("o")

    $record |
        ConvertTo-Json |
        Set-Content -LiteralPath $recordPath -Encoding UTF8
}
