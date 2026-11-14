import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument } from "pdf-lib";
import { DOCUMENT_FONT_REGULAR_BASE64, DOCUMENT_FONT_BOLD_BASE64 } from "./document-font-data";

/** The same font family used by the document preview, embedded for offline PDFs. */
export async function embedDocumentFonts(pdf: PDFDocument) {
  const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(decode(DOCUMENT_FONT_REGULAR_BASE64), { subset: true });
  const bold = await pdf.embedFont(decode(DOCUMENT_FONT_BOLD_BASE64), { subset: true });
  return { regular, bold };
}
