/**
 * Queues a canonical business document for the trusted property print agent.
 *
 * Only printers matching the document's property and requested role are shown.
 * The local print agent records delivery outcomes; browser users cannot mark
 * queued jobs as successfully printed.
 */
import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { usePrinters, useQueuePrint } from "@/lib/printing";
import type { BusinessDocumentType } from "@/components/common/DocumentPrintButton";
import type { Printer as PrinterProfile } from "@/lib/printing";

function roleMatches(
  printer: PrinterProfile,
  requestedRole: string | undefined,
): boolean {
  if (!requestedRole) return true;

  const configured = String(printer.printer_role ?? "").toLowerCase();
  const requested = requestedRole.toLowerCase();

  if (requested === "restaurant") {
    return ["restaurant", "receipt", "pos"].includes(configured);
  }

  return configured === requested;
}

export function SendToPrinterButton({
  type,
  id,
  documentNumber,
  branchId,
  role,
  label = "Send to printer",
}: {
  type: BusinessDocumentType;
  id: string | null | undefined;
  /** Shown on the job so an operator recognises it at the printer. */
  documentNumber?: string | null;
  /** Exact property that owns the document being printed. */
  branchId?: string | null;
  /** Required printer role, e.g. restaurant, receipt or front_office. */
  role?: string;
  label?: string;
}) {
  const { organizationId, can, isAdmin } = useAuth();
  const printers = usePrinters(organizationId);
  const queue = useQueuePrint();

  const [open, setOpen] = useState(false);
  const [printer, setPrinter] = useState("");
  const [job, setJob] = useState<string | null>(null);

  const available = useMemo(
    () =>
      (printers.data ?? []).filter(
        (candidate) =>
          candidate.active &&
          (!branchId || candidate.branch_id === branchId) &&
          roleMatches(candidate, role),
      ),
    [branchId, printers.data, role],
  );

  const preferred = available[0] ?? null;

  if (!id) return null;

  if (
    !(
      isAdmin ||
      can("pos", "receipts", "print") ||
      can("front-office", "print")
    )
  ) {
    return null;
  }

  const reset = () => {
    setOpen(false);
    setPrinter("");
    setJob(null);
  };

  const send = () => {
    const target = printer || preferred?.id;

    if (!target) return;

    queue.mutate(
      {
        printer: target,
        documentType: type,
        title: documentNumber
          ? `${type} ${documentNumber}`
          : type,
        payload: {
          document_type: type,
          document_id: id,
          document_number: documentNumber ?? null,
          branch_id: branchId ?? null,
        },
      },
      {
        onSuccess: (created) => {
          setJob(String(created));
        },
      },
    );
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="gap-2"
        onClick={() => setOpen(true)}
      >
        <Printer className="size-4" />
        {label}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send to a printer</DialogTitle>
            <DialogDescription>
              {job
                ? "Queued for the trusted property print agent. The queue will update automatically after the printer transport reports its outcome."
                : "Choose a compatible printer at this document's property."}
            </DialogDescription>
          </DialogHeader>

          {job ? (
            <div className="flex items-start gap-3 rounded-md border p-4">
              <CheckCircle2 className="mt-0.5 size-5 text-success" />
              <div>
                <p className="font-medium">Print job queued</p>
                <p className="text-sm text-muted-foreground">
                  Job {job}. NEØ will retry or use the configured same-station
                  backup if the agent confirms that nothing printed.
                </p>
              </div>
            </div>
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active printer matches this property and printer role. Configure
              the printer's property, role, station and connection in
              Administration → Printers.
            </p>
          ) : (
            <div className="space-y-2">
              <Label>Printer</Label>
              <Select
                value={printer || preferred?.id || ""}
                onValueChange={setPrinter}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a printer" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                      {candidate.printer_role
                        ? ` · ${candidate.printer_role.replace(/_/g, " ")}`
                        : ""}
                      {candidate.health_status !== "online"
                        ? ` · ${candidate.health_status}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <DialogFooter>
            {job ? (
              <Button onClick={reset}>Close</Button>
            ) : (
              <Button
                disabled={available.length === 0 || queue.isPending}
                onClick={send}
              >
                {queue.isPending ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : null}
                Queue the print
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}