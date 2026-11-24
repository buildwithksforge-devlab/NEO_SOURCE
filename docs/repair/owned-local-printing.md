# Owned local printing — setup and proof

Printer setup now lives at Configuration Centre → Integrations → Printers & Print Queue (`/admin/printers`). POS Settings links there; `/platform/printers` redirects there. POS no longer has a separate form that merely saves Bluetooth/Wi-Fi/cloud labels.

## What actually runs

- Your NEØ application owns the queue and the authenticated request/acknowledgement endpoints.
- Ordinary document **Print** now opens its authorised PDF preview and requests the device's printer dialog; **Download PDF** remains separate. This local change still needs deployment and browser/device acceptance. It does not require registering an application printer profile for each ordinary office print.
- The downloadable Windows agent is `public/downloads/NEO-Print-Agent-Windows.zip`, built from `agents/windows/NeoPrintAgent.cs` and `PrinterDiscovery.cs`. It runs on .NET Framework 4.8 without Node. Installed Windows queues use the Windows driver; direct network receipt/ticket jobs use ESC/POS. Its receipt/ticket text output is separate from the branded A4 PDF renderer.
- The alternative Node 22 agent is `neo-print-agent.mjs`. It communicates directly with TCP printers or the Windows RAW spooler. Its RAW Windows path requires a compatible thermal device; do not assume it has the packaged C# agent's driver-rendering behavior.
- Windows packaged-agent discovery now reads actual printer/port inventory, distinguishes USB/Bluetooth/network queues, resolves Bluetooth serial ports and browses local mDNS printer advertisements. The previous packaged implementation returned no network/Bluetooth results and listed every queue as USB; that defect is repaired locally and the download rebuilt.
- Windows discovery calls the native `Get-Printer` and `Get-PrinterPort` commands. USB and Bluetooth searches filter installed queues. Pair/install the device in Windows first; this code does not implement Bluetooth radio pairing, GATT drivers or arbitrary mobile-browser printing.
- Wi-Fi/LAN discovery sends a local mDNS query and reads advertised printer services, plus installed Windows network queues. Devices that do not advertise need a known IP address or Windows installation. Discovery does not depend on a paid cloud printing service or an outside discovery API.
- RAW network endpoints and Windows queues require a compatible ESC/POS thermal receipt/ticket printer. A detected IPP-only endpoint is shown but cannot be selected for unsupported direct RAW printing. Known PDF/XPS/fax/OneNote queues are excluded from physical-printer selection.
- A discovered queue or advertised service is discovery evidence. Queueing records a job. Agent completion records OS/network acceptance. A person still confirms the correct physical paper at the intended station.

The first-party NEØ endpoints are necessary to connect the hosted application to the local property computer without exposing a local printer port to the internet. Supabase and Cloudflare remain the existing database/hosting infrastructure; no new hosted printing vendor was added.

## Before starting

1. In the verified Supabase project, run `sql-editor/25_READ_ONLY_PRINT_PREFLIGHT.sql`. Compare deployed printing functions to the saved source and preserve recovery evidence. The SQL bundle refuses a different physical-agent contract. If that prerequisite is missing or different, reconcile it first; do not blindly deploy older migrations.
2. Apply `sql-editor/30_APPLY_LOCAL_PRINTER_DISCOVERY.sql` as one submission, then run `96_READ_ONLY_PRINT_POSTCHECK.sql`. It adds discovery metadata and narrowly scoped functions, with no new role grants or historical printer/job rewrites.
3. Review and deploy the matching app source and update the local agent files together. Only then will the new discovery controls exist in the hosted app.
4. In Configuration Centre, pair the correct property computer. Download its one-time `neo-print-agent.json` config. The file contains that property's secret: keep it locally, out of Git and out of shared evidence. The example file contains only a placeholder.

## Alternative Node agent from the checkout

```powershell
Set-Location 'C:\Users\Kelvin\Downloads\NEO_COMPLETE_2026-09-26\NEO_SOURCE'
$neoRuntime = 'C:\Users\Kelvin\Documents\Codex\2026-11-06\files-pasted-by-the-user-ne\work\tooling\node-v22.23.3-win-x64'
.\scripts\start-print-agent.ps1 -NodeDirectory $neoRuntime -ConfigPath '.\neo-print-agent.json'
```

Keep the terminal running while testing; Ctrl+C stops the agent. No background service has been installed or started here. The fixed local PowerShell adapters use a process-scoped execution policy; they do not change global PowerShell policy.

For a read-only inventory without an agent token:

```powershell
.\scripts\start-print-agent.ps1 -NodeDirectory $neoRuntime -Discover windows
.\scripts\start-print-agent.ps1 -NodeDirectory $neoRuntime -Discover usb
.\scripts\start-print-agent.ps1 -NodeDirectory $neoRuntime -Discover bluetooth
```

The token-free `print-agent` output folder also contains the standalone agent, its RAW and discovery adapters, runner and example config. If using that folder, call its `start-print-agent.ps1` and pass the private config path explicitly.

## Verify each required station

Select the property computer and click the required search. Waiting, timeout, empty inventory and errors stay visible. Selecting a supported detected device fills the real name/address/property; assign its department, station and printer role before saving. A returned saved profile ID is required for a successful save.

Queue one labelled test. Record profile/property/station, job ID, claim ID, agent-reported result and observed paper. Test receipt and Hot Kitchen/Pastry/Coffee/Bar routes, permitted/denied users, cross-property denial, wrong-station denial, known offline failure, safe retry, unknown-outcome review, compatible backup and controlled receipt reprint. A lost completion response must not silently print another copy. Do not mark PL01–PL06 passed until their own evidence exists.

Legacy labels such as `browser`, `bluetooth`, `wifi` or `cloud` are not rewritten automatically. Review their actual connection, choose supported network or installed-Windows transport, correct their address and verify the output. Existing jobs and profile history are preserved.

## Device and connection acceptance

| Use | Connection path | Required evidence |
| --- | --- | --- |
| Ordinary PDF/document printing | The current computer/tablet/phone's browser and installed printing service | Document opens; printer is offered by that device; correct A4/receipt paper and actual output |
| Automatic Ethernet/Wi-Fi thermal printing | Property agent -> configured compatible ESC/POS host/port | Device language, reachable address, correct station and labelled physical output |
| Automatic USB/Bluetooth printing | Windows driver queue on the property computer -> device | Device paired/installed, correct queue/driver, paper settings, agent assignment and labelled output |
| Orders submitted from another device | Authorised web app -> existing property queue -> property computer/agent | Role/property/station routing plus physical output; the submitting phone does not need to open raw printer sockets |

The same network printer may be usable either through its installed driver or through a compatible direct network protocol. Ethernet/Wi-Fi describes connectivity; it does not prove support for ESC/POS. IPP-only devices are detected but require their supported driver/service path. No pairing secret is needed for read-only `NEOPrintAgent.exe --discover network output.json` diagnostics.

16 November local checks: packaged Windows agent self-test passed 28 checks (including TCP loopback transport, USB/Bluetooth/network classification and DNS/RAW/IPP handling); Node agent/discovery tests passed 17 tests. Both Node and packaged-agent read-only discovery found no physical device on this computer's current connection. Windows lists only OneNote and Print to PDF. No driver was installed, live job claimed or physical paper verified.

## Protocol and platform references

Windows queue/port inventory follows [Microsoft PrintManagement documentation](https://learn.microsoft.com/en-us/powershell/module/printmanagement/get-printerport). Local discovery uses the [Multicast DNS protocol](https://www.rfc-editor.org/info/rfc6762/). These are native protocols/platform commands; the application does not call these documentation sites at runtime.
