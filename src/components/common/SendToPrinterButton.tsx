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
import { usePrinters, useQueuePrint, usePrintJobDelivery } from "@/lib/printing";
import type { Printer as PrinterProfile } from "@/lib/printing";

function roleMatches(printer: PrinterProfile, requestedRole: string | undefined): boolean {
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
  existingJobId,
  label = "Send to printer",
}: {
  // The queue currently supplies canonical document data only for POS receipts.
  // Other business documents use the authorised PDF/browser print path.
  type: "pos_receipt";
  id: string | null | undefined;
  /** Shown on the job so an operator recognises it at the printer. */
  documentNumber?: string | null;
  /** Exact property that owns the document being printed. */
  branchId?: string | null;
  /** Required printer role, e.g. restaurant, receipt or front_office. */
  role?: string;
  existingJobId?: string | null;
  label?: string;
}) {
  const { organizationId, can, isAdmin } = useAuth();
  const printers = usePrinters(organizationId);
  const queue = useQueuePrint();

  const [open, setOpen] = useState(false);
  const [printer, setPrinter] = useState("");
  const [submittedJobId, setJob] = useState<string | null>(null);
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null);
  const job = submittedJobId ?? trackedJobId ?? existingJobId;
  const delivery = usePrintJobDelivery(open ? job : null, organizationId);

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

  if (!(
    isAdmin ||
    can("pos", "receipts", "print") ||
    (type === "pos_receipt" && can("restaurant", "orders", "create")) ||
    can("front-office", "print")
  )) {
    return null;
  }

  const reset = () => {
    setOpen(false);
    setPrinter("");
    setJob(null);
    setTrackedJobId(null);
  };

  const send = () => {
    const target = printer || preferred?.id;

    if (!target || job || queue.isPending) return;

    queue.mutate(
      {
        printer: target,
        documentType: type,
        title: documentNumber ? `${type} ${documentNumber}` : type,
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
      <Button size="sm" variant="outline" className="gap-2" onClick={() => {
        setTrackedJobId(existingJobId ?? null);
        setOpen(true);
      }}>
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
            <DialogTitle>{job ? "Receipt print status" : "Send to a printer"}</DialogTitle>
            <DialogDescription>
              {job
                ? "Queued for the trusted property print agent. The queue will update automatically after the printer transport reports its outcome."
                : "Choose a compatible printer at this document's property."}
            </DialogDescription>
          </DialogHeader>

          {job ? (
            <div className="flex items-start gap-3 rounded-md border p-4">
              {delivery.data?.status === "completed" ? (
                <CheckCircle2 className="mt-0.5 size-5 text-success" />
              ) : (
                <Printer className="mt-0.5 size-5" />
              )}
              <div>
                <p className="font-medium">
                  {delivery.data?.status === "completed"
                    ? "Delivered to printer transport"
                    : delivery.data?.status === "failed"
                      ? "Printer needs attention"
                      : delivery.data?.status === "printing"
                        ? "Sending to printer"
                        : "Print job queued"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Job {job}.{" "}
                  {delivery.data?.status === "completed"
                    ? "The agent reports successful handoff. Check the printer for paper output."
                    : (delivery.data?.last_error ??
                      "Waiting for the paired property computer. If it confirms nothing printed, NEØ can retry or use the configured same-station backup.")}
                  {delivery.isError
                    ? " The latest outcome could not be loaded; check the print queue before retrying."
                    : ""}
                </p>
              </div>
            </div>
          ) : printers.isLoading ? (
            <p role="status" className="text-sm text-muted-foreground">Loading property printers…</p>
          ) : printers.isError ? (
            <Button variant="outline" onClick={() => void printers.refetch()}>Retry loading printers</Button>
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active printer matches this property and printer role. Configure the printer's
              property, role, station and connection in Configuration Centre → Integrations →
              Printers & Print Queue.
            </p>
          ) : (
            <div className="space-y-2">
              <Label>Printer</Label>
              <Select value={printer || preferred?.id || ""} onValueChange={setPrinter}>
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
                      {candidate.health_status !== "online" ? ` · ${candidate.health_status}` : ""}
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
              <Button disabled={printers.isError || available.length === 0 || queue.isPending} onClick={send}>
                {queue.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Queue the print
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
