/**
 * The single way NEØ produces a downloadable business document.
 *
 * Business documents are rendered server-side from the canonical database
 * record, carry the property identity and system-issued document number, and
 * remain subject to backend scope and permission checks.
 *
 * POS receipts use the dedicated least-privilege receipt capability instead of
 * broad POS module access, so operational staff such as Waiters/Cashiers can
 * print legitimate customer receipts without receiving management authority.
 */
import { useState } from "react";
import { FileText, Loader2, Printer } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { exportBusinessDocument } from "@/lib/document-pdf.functions";
import { downloadDocumentPdf, openDocumentPrintWindow } from "@/lib/browser-document";

export type BusinessDocumentType =
  | "pos_receipt"
  | "invoice"
  | "credit_note"
  | "folio_statement"
  | "beo"
  | "purchase_order"
  | "goods_receipt"
  | "requisition"
  | "stock_sheet"
  | "staff_schedule"
  | "task_sheet"
  | "payslip";

type DocumentPermission = {
  module: string;
  feature?: string;
  action: string;
};

/**
 * Canonical frontend permission required to expose each document action.
 *
 * The backend remains authoritative. This mapping exists only so the UI does
 * not hide an action from a user who already holds the correct capability.
 */
const DOCUMENT_PERMISSIONS: Record<BusinessDocumentType, DocumentPermission> = {
  pos_receipt: {
    module: "pos",
    feature: "receipts",
    action: "print",
  },
  invoice: {
    module: "finance",
    action: "print",
  },
  credit_note: {
    module: "finance",
    action: "print",
  },
  folio_statement: {
    module: "front-office",
    action: "print",
  },
  beo: {
    module: "events",
    action: "print",
  },
  purchase_order: {
    module: "procurement",
    action: "print",
  },
  goods_receipt: {
    module: "procurement",
    action: "print",
  },
  requisition: {
    module: "inventory",
    action: "print",
  },
  stock_sheet: {
    module: "inventory",
    action: "print",
  },
  staff_schedule: {
    module: "hr-scheduling",
    action: "print",
  },
  task_sheet: {
    module: "tasks",
    action: "print",
  },
  payslip: {
    module: "human-resources",
    action: "print",
  },
};

function canPrintDocument(
  type: BusinessDocumentType,
  can: (module: string, actionOrFeature: string, action?: string) => boolean,
  isAdmin: boolean,
) {
  if (isAdmin) return true;
  if (type === "pos_receipt" && can("restaurant", "orders", "create")) return true;

  const permission = DOCUMENT_PERMISSIONS[type];

  if (permission.feature) {
    return can(permission.module, permission.feature, permission.action);
  }

  /*
   * Preserve the existing module-level compatibility for non-POS documents.
   * Some older document surfaces still rely on module-wide print/view grants.
   *
   * POS receipts intentionally do not use this fallback because they already
   * have the explicit `pos.receipts.print` capability.
   */
  return can(permission.module, permission.action) || can(permission.module, "view");
}

function decodeDocumentPdf(value: string): Uint8Array<ArrayBuffer> {
  const encoded = value.replace(/^data:application\/pdf;base64,/i, "").replace(/\s/g, "");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

export function DocumentPrintButton({
  type,
  id,
  label = "Print document",
  variant = "outline",
  size = "sm",
  className,
}: {
  type: BusinessDocumentType;
  id: string | null | undefined;
  label?: string;
  variant?: "outline" | "default" | "ghost" | "secondary";
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  const { can, isAdmin } = useAuth();
  const run = useServerFn(exportBusinessDocument);
  const [busy, setBusy] = useState(false);

  const allowed = canPrintDocument(type, can, isAdmin);

  if (!allowed || !id) return null;

  const download = async (action: "print" | "download") => {
    if (busy) return;

    setBusy(true);

    let preview: ReturnType<typeof openDocumentPrintWindow> | undefined;
    let previewBlocked = false;
    try {
      if (action === "print") {
        try {
          preview = openDocumentPrintWindow();
        } catch {
          // Some devices block a new tab even for a direct button click.
          // Still fetch the authorised PDF and let the operator print it locally.
          previewBlocked = true;
        }
      }
      const input = {
        data: {
          type,
          id,
        },
      };
      let result = await run(input);
      if (!result || typeof result.base64 !== "string") {
        throw new Error("The document service returned no PDF. Please try again; if it continues, report this receipt number.");
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = decodeDocumentPdf(result.base64);
      } catch {
        // Export is read-only. A single retry handles an incomplete response
        // without queuing another print job or changing the sale.
        result = await run(input);
        if (!result || typeof result.base64 !== "string") {
          throw new Error("The document service returned no PDF. Please try again; if it continues, report this receipt number.");
        }
        try {
          bytes = decodeDocumentPdf(result.base64);
        } catch {
          throw new Error("The PDF response could not be decoded on this device. Refresh the page and try again.");
        }
      }

      const blob = new Blob([bytes], {
        type: "application/pdf",
      });

      if (preview) preview.show(blob, result.filename);
      else downloadDocumentPdf(blob, result.filename);

      toast.success(previewBlocked
        ? `${result.documentNumber} downloaded. Open the PDF and use its Print control.`
        : `${result.documentNumber} ready`);
    } catch (error) {
      preview?.close();
      const message =
        error instanceof Error ? error.message : "The document could not be generated.";

      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const isDownloadLabel = /download|\bpdf\b/i.test(label) && !/print/i.test(label);
  const isPrintLabel = !isDownloadLabel;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size={size}
        variant={variant}
        className={`gap-2 ${className ?? ""}`}
        disabled={busy}
        onClick={() => void download(isPrintLabel ? "print" : "download")}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : isPrintLabel ? (
          <Printer className="size-4" />
        ) : (
          <FileText className="size-4" />
        )}

        {label}
      </Button>
      <Button
        size={size}
        variant="outline"
        disabled={busy}
        onClick={() => void download(isPrintLabel ? "download" : "print")}
      >
        {isPrintLabel ? <FileText className="mr-2 size-4" /> : <Printer className="mr-2 size-4" />}
        {isPrintLabel ? "Download PDF" : "Print"}
      </Button>
    </span>
  );
}
