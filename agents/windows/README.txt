NEO WINDOWS PRINT AGENT

1. Extract this package. Run "Install Print Agent.cmd".
2. In NEO > Configuration Centre > Printers & Print Queue, pair this property computer.
3. Download its configuration. In the agent, choose Import pairing configuration.
4. Assign the agent to the physical printer in NEO. For USB, first install the printer in Windows and enter the exact Windows queue name. For network ESC/POS printers, enter the printer address with optional port (default 9100).
5. Keep the agent running. Its tray menu offers Start with Windows.

The agent needs Windows 10/11 and .NET Framework 4.8. No Node installation or command window is needed. The pairing secret is encrypted for the current Windows user. The downloaded configuration contains the secret: keep it private and remove it after importing.

Printing sends canonical NEO receipt or production-ticket content through the installed Windows driver or the network printer. Windows driver handoff and network delivery are transport confirmations; they do not prove that paper physically emerged. Paper, device faults and cutter settings still need a real printer check. Microsoft Print to PDF and OneNote are not physical printers and cannot complete live physical jobs.

If the outcome is uncertain, the agent does not automatically print another copy. Review the printer and the NEO print queue before retrying. Failed acknowledgements are retained locally and retried without redelivering the job.

To update: Exit the agent from its tray menu and run the installer from the new extracted package. To disconnect: revoke the paired agent in NEO. To uninstall: turn off Start with Windows, exit the agent, and remove the desktop shortcut and %LOCALAPPDATA%\NEO\PrintAgent. Do not remove unresolved delivery records before reviewing them.
