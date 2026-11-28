/** Keep the browser print preview in the current tab while the PDF is generated. */
export function openDocumentPrintWindow() {
  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Document print preview");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(12,22,31,.72);font:14px system-ui,sans-serif;color:#17212c";
  const panel = document.createElement("div");
  panel.style.cssText =
    "display:flex;flex-direction:column;width:min(100%,1280px);height:min(920px,calc(100vh - 32px));min-height:320px;overflow:hidden;border:1px solid #dbe2e8;border-radius:18px;background:#fff;box-shadow:0 24px 70px rgba(0,0,0,.28)";
  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px 20px;border-bottom:1px solid #e2e8ee;background:#fff";
  const heading = document.createElement("div");
  heading.style.cssText = "display:flex;align-items:center;gap:12px;min-width:0";
  const mark = document.createElement("span");
  mark.textContent = "NEØ";
  mark.style.cssText =
    "display:grid;place-items:center;width:42px;height:42px;flex:none;border-radius:12px;background:#e4f4ed;color:#176b4d;font-weight:800;letter-spacing:-.06em";
  const headingText = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "Document preview";
  title.style.cssText = "display:block;font-size:16px;line-height:1.35";
  const status = document.createElement("span");
  status.textContent = "Preparing your document…";
  status.style.cssText = "display:block;max-width:55vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#667583;font-size:12px";
  headingText.append(title, status);
  heading.append(mark, headingText);
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
  const dismiss = document.createElement("button");
  dismiss.textContent = "Close";
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", "Close document preview");
  dismiss.style.cssText =
    "padding:10px 14px;border:1px solid #d5dde5;border-radius:10px;background:#fff;color:#334155;font:600 13px system-ui;cursor:pointer";
  actions.append(dismiss);
  header.append(heading, actions);
  const hint = document.createElement("div");
  hint.style.cssText = "padding:10px 20px;border-bottom:1px solid #e2e8ee;background:#f7faf8;color:#496458;font-size:12px";
  hint.textContent = "Your document will appear here when it is ready.";
  const viewerArea = document.createElement("div");
  viewerArea.style.cssText = "display:flex;flex:1;min-height:0;align-items:center;justify-content:center;background:#e8edf1";
  const loading = document.createElement("span");
  loading.textContent = "Preparing the PDF preview…";
  loading.style.cssText = "color:#64748b";
  viewerArea.append(loading);
  panel.append(header, hint, viewerArea);
  overlay.append(panel);
  document.body.append(overlay);
  let url: string | null = null;
  let viewer: Window | null = null;
  let navigating = false;

  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    overlay.remove();
    priorFocus?.focus();
    if (!url || navigating) return;
    if (viewer && !viewer.closed) {
      const retainedUrl = url;
      const monitor = window.setInterval(() => {
        if (viewer?.closed) {
          URL.revokeObjectURL(retainedUrl);
          window.clearInterval(monitor);
        }
      }, 1000);
    } else URL.revokeObjectURL(url);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  dismiss.onclick = close;
  document.addEventListener("keydown", onKeyDown);
  dismiss.focus();

  return {
    close,
    show: (blob: Blob, filename: string) => {
      if (!overlay.isConnected) return;
      url = URL.createObjectURL(blob);
      title.textContent = /^receipt-/i.test(filename) ? "Receipt preview" : "Document preview";
      status.textContent = filename;
      const print = document.createElement("button");
      print.textContent = /^receipt-/i.test(filename) ? "Print receipt" : "Print document";
      print.type = "button";
      print.style.cssText =
        "padding:10px 16px;border:1px solid #176b4d;border-radius:10px;background:#176b4d;color:white;font:700 13px system-ui;cursor:pointer";
      print.onclick = () => {
        // A fresh click can open the native PDF viewer on devices that block
        // popups opened before an asynchronous document request completes.
        viewer = window.open(url!, "_blank");
        if (viewer) {
          viewer.opener = null;
          const printViewer = viewer;

          const requestPrint = () => {
            try {
              if (printViewer.closed) return;
              if (typeof printViewer.focus === "function") {
                printViewer.focus();
              }
              if (typeof printViewer.print === "function") {
                printViewer.print();
              }
            } catch {
              // Keep the native PDF viewer available for manual printing.
            }
          };

          try {
            if (typeof printViewer.addEventListener === "function") {
              printViewer.addEventListener(
                "load",
                requestPrint,
                { once: true }
              );
            }
          } catch {
            // Some native PDF viewers restrict scripting.
          }
        }
        else {
          navigating = true;
          window.location.assign(url!);
        }
      };
      const download = document.createElement("a");
      download.textContent = "Download PDF";
      download.href = url;
      download.download = filename;
      download.style.cssText =
        "padding:10px 14px;border:1px solid #d5dde5;border-radius:10px;background:#fff;color:#334155;font:600 13px system-ui;text-decoration:none";
      hint.textContent =
        "Select Print, then choose your printer in the browser PDF viewer. Check paper size and scale in your printer settings.";
      const frame = document.createElement("iframe");
      frame.title = filename;
      frame.style.cssText = "border:0;flex:1;width:100%;min-height:0;background:white";
      actions.prepend(print, download);
      frame.src = url;
      viewerArea.replaceChildren(frame);
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
