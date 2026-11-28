import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument } from "pdf-lib";
import { DOCUMENT_FONT_REGULAR_BASE64, DOCUMENT_FONT_BOLD_BASE64 } from "./document-font-data";

// Font bytes are immutable and shared by every PDF rendered by this worker.
// Decode them once rather than converting the bundled base64 on each print.
let cachedFontBytes: { regular: Uint8Array; bold: Uint8Array } | undefined;

/** The same font family used by the document preview, embedded for offline PDFs. */
export async function embedDocumentFonts(pdf: PDFDocument) {
  cachedFontBytes ??= {
    regular: Uint8Array.from(atob(DOCUMENT_FONT_REGULAR_BASE64), (c) => c.charCodeAt(0)),
    bold: Uint8Array.from(atob(DOCUMENT_FONT_BOLD_BASE64), (c) => c.charCodeAt(0)),
  };
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(cachedFontBytes.regular, { subset: true });
  const bold = await pdf.embedFont(cachedFontBytes.bold, { subset: true });
  return { regular, bold };
}
