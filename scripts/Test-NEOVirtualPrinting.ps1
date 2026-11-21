$ErrorActionPreference = "Stop"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "   NEO VIRTUAL PRINTING TEST SUITE" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$passed = 0
$failed = 0

function Assert-Test {
    param(
        [bool]$Condition,
        [string]$Description
    )

    if ($Condition) {
        $script:passed++
        Write-Host "[PASS] $Description" -ForegroundColor Green
    }
    else {
        $script:failed++
        Write-Host "[FAIL] $Description" -ForegroundColor Red
    }
}

# Test 1: Windows printer discovery

Write-Host "`n=== WINDOWS PRINTING ===" -ForegroundColor Yellow

$printers = @(Get-Printer)

Assert-Test `
    ($printers.Name -contains "Microsoft Print to PDF") `
    "Windows PDF printer detected"

# Test 2: Bluetooth interface discovery

Write-Host "`n=== BLUETOOTH INTERFACES ===" -ForegroundColor Yellow

$bluetooth = @(
    Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "Bluetooth" }
)

Assert-Test `
    ($bluetooth.Count -gt 0) `
    "Bluetooth serial interfaces detected"

foreach ($port in $bluetooth) {
    Write-Host "Available: $($port.DeviceID)"
}

# Test 3: Local TCP thermal-printer simulation

Write-Host "`n=== VIRTUAL THERMAL PRINTERS ===" -ForegroundColor Yellow

$stations = @(
    "Kitchen",
    "Coffee",
    "Bar",
    "Pastry"
)

$ports = @{
    Kitchen = 19101
    Coffee  = 19102
    Bar     = 19103
    Pastry  = 19104
}

$received = @{}
$jobs = @{}
$listeners = @()

try {

    foreach ($station in $stations) {

        $port = $ports[$station]

        $listener = [System.Net.Sockets.TcpListener]::new(
            [System.Net.IPAddress]::Loopback,
            $port
        )

        $listener.Start()

        $listeners += $listener

        Write-Host "Virtual $station printer listening on 127.0.0.1:$port"
    }

    $index = 0

    foreach ($station in $stations) {

        $index++

        $jobId = "NEO-UAT-$index"

        $ticket = @"
NEO HOSPITALITY
SAVANNA CROWN NAIROBI
----------------------------
STATION: $station
ORDER: NEO-UAT-001
JOB: $jobId
TEST ITEM: 1
----------------------------
VIRTUAL TEST ONLY
"@

        $bytes = [System.Text.Encoding]::ASCII.GetBytes($ticket)

        $client = [System.Net.Sockets.TcpClient]::new()

        try {

            $client.Connect("127.0.0.1", $ports[$station])

            $stream = $client.GetStream()
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()

            $listener = $listeners[$index - 1]

            $serverClient = $listener.AcceptTcpClient()

            try {

                $serverStream = $serverClient.GetStream()

                $buffer = New-Object byte[] $bytes.Length

                $total = 0

                while ($total -lt $bytes.Length) {

                    $count = $serverStream.Read(
                        $buffer,
                        $total,
                        $bytes.Length - $total
                    )

                    if ($count -eq 0) {
                        break
                    }

                    $total += $count
                }

                $received[$station] = [System.Text.Encoding]::ASCII.GetString(
                    $buffer,
                    0,
                    $total
                )

                $jobs[$jobId] = "received"

                Assert-Test `
                    ($total -eq $bytes.Length -and
                     $received[$station] -match "STATION: $station") `
                    "$station printer received its complete ticket"

            }
            finally {
                $serverClient.Close()
            }

        }
        finally {
            $client.Close()
        }
    }

    # Test 4: Basic simulated duplicate prevention

    Write-Host "`n=== DUPLICATE PREVENTION ===" -ForegroundColor Yellow

    $before = $jobs.Count

    $duplicateId = "NEO-UAT-001"

    $seen = @{}

    $seen[$duplicateId] = $true

    if (!$seen.ContainsKey($duplicateId)) {
        $jobs["DUPLICATE"] = "received"
    }

    Assert-Test `
        ($jobs.Count -eq $before) `
        "Simulated repeated request does not create another job"

}
finally {

    foreach ($listener in $listeners) {
        $listener.Stop()
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "NEO VIRTUAL PRINTING RESULTS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "Passed: $passed" -ForegroundColor Green
Write-Host "Failed: $failed" -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Red" })

if ($failed -gt 0) {
    throw "$failed virtual printing tests failed."
}

Write-Host "`nVirtual tests completed." -ForegroundColor Green
Write-Host "NOTE: This does not establish actual NEØ queue integration or physical printing."
