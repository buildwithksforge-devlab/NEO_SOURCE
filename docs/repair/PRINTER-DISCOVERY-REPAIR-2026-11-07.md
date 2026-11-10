# Printer discovery repair — 7 November 2026

Source changes are local; this batch has not been deployed or paired as a running property agent.

Fixed a network discovery gap: PTR-only printer advertisements now trigger bounded SRV resolution, followed by missing IPv4 address resolution. Separate replies are assembled into a real endpoint. Repeated replies do not cause query loops, and follow-ups are limited to advertised printer instances and local hostnames. This follows the browse/resolve distinction in RFC 6763 (https://www.rfc-editor.org/rfc/rfc6763).

The Configuration Centre now explains when no active property computer is paired, including private configuration and local agent requirements. Saving a profile does not establish a printer connection.

Validation: all 15 print-agent tests passed, including the new three-message discovery regression. All 27 targeted UI/printing contract tests passed. Typecheck and production build status are recorded separately when complete.

A real read-only local network discovery on this computer found one Kyocera TASKalfa 4053ci at 192.168.1.245, advertising IPP on port 443 and RAW on port 9100. No print job was sent. A RAW port does not prove ESC/POS thermal compatibility. This office printer is not certified for the receipt writer. Existing Windows inventory contained OneNote and Microsoft Print to PDF only; no NEØ print-agent process or default local private config was found during the earlier inspection.

Still required: paired/running property agent, compatible printer installation or known network endpoint, property/station routing, a labelled physical print, offline failure handling and safe reprint proof. Bluetooth discovery still requires Windows pairing and a printer queue; it does not perform unpaired radio discovery. IPP-only direct printing is not implemented.

Separate accounting issue: the inspected historical revenue-reconciliation definition sums the outstanding posting queue, includes noneligible unfinished states as blocked, and compares those gross values with net revenue journal credits. It omits posted sources once they leave that queue. This calculation cannot establish earned-revenue reconciliation. SQL 74 requests deployed definitions and aggregate lifecycle evidence before replacement. No bulk posting, period opening, data deletion or financial correction was performed for this issue.
Final validation: TypeScript, production build and built-server smoke checks passed. Targeted UI/contract checks: 27 passed. No deployment or pairing performed.
