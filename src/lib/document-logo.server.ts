import type { PDFDocument } from "pdf-lib";

// Keep a few successful logo downloads in each worker so a waiter printing the
// next receipt does not wait for the same remote image again.
const logoBytes = new Map<string, { data: Uint8Array; expires: number }>();

export async function embedDocumentLogo(pdf: PDFDocument, candidates: string[]) {
  for (const url of candidates) {
    if (!url) continue;
    try {
      const embedded = /^data:image\/(png|jpeg);base64,([a-z0-9+/=]+)$/i.exec(url);
      if (embedded && url.length <= 500_000) {
        const data = Buffer.from(embedded[2]!, "base64");
        return embedded[1]!.toLowerCase() === "png" ? await pdf.embedPng(data) : await pdf.embedJpg(data);
      }
      if (!/^https:\/\//i.test(url)) continue;
      const cached = logoBytes.get(url);
      let data = cached && cached.expires > Date.now() ? cached.data : undefined;
      if (!data) {
        logoBytes.delete(url);
        const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "error" });
        if (!response.ok) continue;
        const contentLength = Number(response.headers.get("content-length"));
        if (contentLength > 2_000_000) continue;
        data = new Uint8Array(await response.arrayBuffer());
        if (data.length <= 2_000_000) {
          if (logoBytes.size >= 8) logoBytes.delete(logoBytes.keys().next().value!);
          logoBytes.set(url, { data, expires: Date.now() + 300_000 });
        }
      }
      if (data.length > 2_000_000) continue;
      return data[0] === 137 && data[1] === 80 ? await pdf.embedPng(data) : await pdf.embedJpg(data);
    } catch { /* An unavailable logo must not block the document. */ }
  }
  return undefined;
}
