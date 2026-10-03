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

export type BusinessDocumentType =
  | "pos_receipt"
  | "invoice"
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
  can: (
    module: string,
    actionOrFeature: string,
    action?: string,
  ) => boolean,
  isAdmin: boolean,
) {
  if (isAdmin) return true;

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
  return (
    can(permission.module, permission.action) ||
    can(permission.module, "view")
  );
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

  const download = async () => {
    if (busy) return;

    setBusy(true);

    try {
      const result = await run({
        data: {
          type,
          id,
        },
      });

      const bytes = Uint8Array.from(
        atob(result.base64),
        (character) => character.charCodeAt(0),
      );

      const blob = new Blob([bytes], {
        type: "application/pdf",
      });

      const url = URL.createObjectURL(blob);

      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.filename;
        anchor.rel = "noopener";

        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }

      toast.success(`${result.documentNumber} ready`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The document could not be generated.";

      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const isPrintLabel = label.toLowerCase().includes("print");

  return (
    <Button
      size={size}
      variant={variant}
      className={`gap-2 ${className ?? ""}`}
      disabled={busy}
      onClick={() => void download()}
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
  );
}