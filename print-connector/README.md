NEO PRINT AGENT BUNDLE (local code only)

This installs only the local printer connector. It DOES NOT install the HTTPS server endpoint, routing migrations or printer setup UI. The current Cloudflare deployment cannot serve this until those components are deployed.

Agent protocol expects HTTPS POST /api/public/print-agent/{claim,finish}. The connector needs the scope-limited NEO_PRINT_TOKEN issued by your NEØ connector admin (not service role).

Install:
1. Extract ZIP into NEO_SOURCE root, preserving print-connector/ folder.
2. `py -m unittest discover -s print-connector -p 'test_*.py' -v`
3. Once NEØ backend is deployed, copy print-connector/config.example.json to config.json and replace printer IDs and local device mapping.
4. Set `NEO_PRINT_TOKEN` only in the local PC environment and run `py print-connector/neo_print_agent.py print-connector/config.json`.

Windows installed ESC/POS printer: `py -m pip install pywin32`; choose type windows_spooler and printer_name in config. Bluetooth Classic printer: pair Windows SPP/COM printer, type bluetooth_classic, port COMx. Network: private LAN IP and TCP 9100. Cloud/BLE not supported.
Do not commit config.json with secrets. A Windows virtual PDF printer is not an ESC/POS RAW device; do not assume it prints raw ESC/POS correctly.

