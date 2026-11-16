/** Open synchronously from a click, before awaiting the authorised PDF export. */
export function openDocumentPrintWindow() {
  const preview = window.open("about:blank", "_blank");
  if (!preview) throw new Error("Allow pop-ups for this site to open the document print preview.");
  preview.opener = null;
  const page = preview.document;
  page.title = "Preparing document";
  page.body.textContent = "Preparing your document…";

  return {
    close: () => preview.close(),
    show: (blob: Blob, filename: string) => {
      if (preview.closed) return;
      const url = URL.createObjectURL(blob);
      page.title = filename;
      page.body.replaceChildren();
      page.body.style.cssText =
        "margin:0;height:100vh;display:flex;flex-direction:column;font:14px system-ui;background:#f3f4f6";
      const toolbar = page.createElement("div");
      toolbar.style.cssText =
        "padding:12px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:white";
      const print = page.createElement("button");
      print.textContent = "Print / choose printer";
      print.disabled = true;
      const download = page.createElement("a");
      download.textContent = "Download PDF";
      download.href = url;
      download.download = filename;
      const direct = page.createElement("a");
      direct.textContent = "Open PDF directly";
      direct.href = url;
      direct.target = "_blank";
      direct.rel = "noopener";
      const hint = page.createElement("span");
      hint.textContent =
        "Choose your installed printer in the print dialog. If it does not open, use the PDF viewer’s print control.";
      const frame = page.createElement("iframe");
      frame.title = filename;
      frame.style.cssText = "border:0;flex:1;width:100%;min-height:0";
      const requestPrint = () => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          hint.textContent =
            "Use the PDF viewer’s print control, or open the PDF directly and print there.";
        }
      };
      print.onclick = requestPrint;
      frame.addEventListener(
        "load",
        () => {
          print.disabled = false;
          requestPrint();
        },
        { once: true },
      );
      toolbar.append(print, download, direct, hint);
      frame.src = url;
      page.body.append(toolbar, frame);
      // Keep the PDF alive through preview, cancel and repeated print attempts.
      // Revoking immediately after opening breaks some browser PDF viewers.
      const monitor = window.setInterval(() => {
        if (preview.closed) {
          URL.revokeObjectURL(url);
          window.clearInterval(monitor);
        }
      }, 1000);
    },
  };
}

export function downloadDocumentPdf(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
