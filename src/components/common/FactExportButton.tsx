/**
 * Download the reconciled canonical facts for the selected property and
 * period — exactly what Dashboard, Analytics and Finance display.
 */
import { useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SHARED_FACT_PATHS } from "@/components/common/fact-paths";
import {
  downloadTextFile,
  factExportCsv,
  factExportFilename,
  useReconciliationMeta,
} from "@/lib/fact-export";
import { factsAuthorised, useFactReconciliation, useFacts, type FactScope } from "@/lib/facts";
import { exportManagementReportPdf } from "@/lib/report-pdf.functions";
import { useAuth } from "@/lib/auth";

export function FactExportButton({
  scope,
  scopeLabel,
  paths = SHARED_FACT_PATHS,
  enabled = true,
  title = "Management report",
}: {
  scope: FactScope;
  scopeLabel: string;
  paths?: string[];
  enabled?: boolean;
  title?: string;
}) {
  const { can, isAdmin } = useAuth();
  const canExport = can("reports", "export") || isAdmin;
  const facts = useFacts(scope, enabled);
  const reconciliation = useFactReconciliation(scope, enabled);
  const meta = useReconciliationMeta(scope, enabled);
  const exportPdf = useServerFn(exportManagementReportPdf);
  const [pdfBusy, setPdfBusy] = useState(false);

  const ready = facts.isSuccess && factsAuthorised(facts.data) && !reconciliation.isLoading;

  if (!canExport) return null;

  const downloadPdf = async () => {
    if (!scope.from || !scope.to) {
      toast.error("Choose a report period before exporting.");
      return;
    }
    setPdfBusy(true);
    try {
      const result = await exportPdf({ data: { title, branchId: scope.branchId, from: scope.from, to: scope.to, paths } });
      const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" className="gap-2" disabled={!ready || pdfBusy} onClick={() => void downloadPdf()}>
        {pdfBusy ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />} Export PDF
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="gap-2"
        disabled={!ready || pdfBusy}
        title={ready ? "Download the reconciled facts for this property and period" : "Available once the facts have loaded"}
        onClick={() => downloadTextFile(factExportFilename(scope), factExportCsv({ facts: facts.data, paths, reconciliation: reconciliation.data ?? [], meta: meta.data, scope, scopeLabel }))}
      >
        <Download className="size-4" /> Export CSV
      </Button>
    </div>
  );
}
