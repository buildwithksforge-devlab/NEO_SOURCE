import type { PDFDocument } from "pdf-lib";

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
      const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "error" });
      if (!response.ok) continue;
      const contentLength = Number(response.headers.get("content-length"));
      if (contentLength > 2_000_000) continue;
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length > 2_000_000) continue;
      return data[0] === 137 && data[1] === 80 ? await pdf.embedPng(data) : await pdf.embedJpg(data);
    } catch { /* An unavailable logo must not block the document. */ }
  }
  return undefined;
}
