/**
 * The single way NEØ produces a printable business document.
 *
 * Never prints the screen: the PDF is rendered server-side from the canonical
 * record, carries the property masthead and the system-issued document number,
 * and is refused for properties outside the signed-in user's scope.
 */
import { useState } from "react";
import { FileText, Loader2, Printer } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { exportBusinessDocument } from "@/lib/document-pdf.functions";
import { useAuth } from "@/lib/auth";

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

const MODULE: Record<BusinessDocumentType, string> = {
  pos_receipt: "pos",
  invoice: "finance",
  folio_statement: "front-office",
  beo: "events",
  purchase_order: "procurement",
  goods_receipt: "procurement",
  requisition: "inventory",
  stock_sheet: "inventory",
  staff_schedule: "hr-scheduling",
  task_sheet: "tasks",
  payslip: "human-resources",
};

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
  const module = MODULE[type];
  const allowed = isAdmin || can(module, "print") || can(module, "view");
  const run = useServerFn(exportBusinessDocument);
  const [busy, setBusy] = useState(false);

  if (!allowed || !id) return null;

  const download = async () => {
    setBusy(true);
    try {
      const result = await run({ data: { type, id } });
      const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(`${result.documentNumber} ready`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size={size} variant={variant} className={`gap-2 ${className ?? ""}`} disabled={busy} onClick={() => void download()}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : label.toLowerCase().includes("print") ? <Printer className="size-4" /> : <FileText className="size-4" />}
      {label}
    </Button>
  );
}
