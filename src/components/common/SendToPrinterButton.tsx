/**
 * Sends a canonical business document to a configured printer.
 *
 * NEØ never claims a document printed. The job is queued against a real
 * printer profile; whoever is standing at the printer confirms whether paper
 * came out. A failure retries on the same printer and, once the retry limit is
 * reached, fails over to the configured backup — all recorded on the job.
 */
import { useMemo, useState } from "react";
import { Loader2, Printer } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import { usePrinters, useQueuePrint, useRecordPrintResult } from "@/lib/printing";
import type { BusinessDocumentType } from "@/components/common/DocumentPrintButton";

export function SendToPrinterButton({
  type,
  id,
  documentNumber,
  role,
  label = "Send to printer",
}: {
  type: BusinessDocumentType;
  id: string | null | undefined;
  /** Shown on the job so an operator recognises it at the printer. */
  documentNumber?: string | null;
  /** Printer role preferred for this document, e.g. "front_office". */
  role?: string;
  label?: string;
}) {
  const { organizationId, can, isAdmin } = useAuth();
  const printers = usePrinters(organizationId);
  const queue = useQueuePrint();
  const record = useRecordPrintResult();
  const [open, setOpen] = useState(false);
  const [printer, setPrinter] = useState<string>("");
  const [job, setJob] = useState<string | null>(null);
  const [failure, setFailure] = useState("");

  const available = useMemo(
    () => (printers.data ?? []).filter((p) => p.active),
    [printers.data],
  );
  const preferred = useMemo(
    () => available.find((p) => (role ? p.printer_role === role : false)) ?? available[0],
    [available, role],
  );

  if (!id) return null;
  if (!(isAdmin || can("pos", "receipts", "print") || can("front-office", "print"))) return null;

  const reset = () => {
    setOpen(false);
    setJob(null);
    setFailure("");
  };

  const send = () => {
    const target = printer || preferred?.id;
    if (!target) return;
    queue.mutate(
      {
        printer: target,
        documentType: type,
        title: documentNumber ? `${type} ${documentNumber}` : type,
        payload: { document_type: type, document_id: id, document_number: documentNumber ?? null },
      },
      { onSuccess: (created) => setJob(String(created)) },
    );
  };

  return (
    <>
      <Button size="sm" variant="outline" className="gap-2" onClick={() => setOpen(true)}>
        <Printer className="size-4" />
        {label}
      </Button>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : reset())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send to a printer</DialogTitle>
            <DialogDescription>
              {job
                ? "The job is queued. Confirm what actually happened at the printer — NEØ does not assume it printed."
                : "Choose the printer this document should come out of."}
            </DialogDescription>
          </DialogHeader>

          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No printer is configured for this workspace yet. Add one in Administration → Printers,
              assign it to a department, then come back.
            </p>
          ) : !job ? (
            <div className="space-y-2">
              <Label>Printer</Label>
              <Select value={printer || preferred?.id || ""} onValueChange={setPrinter}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a printer" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      {p.printer_role ? ` · ${p.printer_role.replace(/_/g, " ")}` : ""}
                      {p.health_status && p.health_status !== "healthy" ? ` · ${p.health_status}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>If it did not print, what went wrong?</Label>
              <Textarea
                value={failure}
                onChange={(event) => setFailure(event.target.value)}
                placeholder="Out of paper, printer offline, jammed…"
                rows={3}
              />
            </div>
          )}

          <DialogFooter>
            {!job ? (
              <Button disabled={available.length === 0 || queue.isPending} onClick={send}>
                {queue.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Queue the print
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={record.isPending || failure.trim().length === 0}
                  onClick={() =>
                    record.mutate(
                      { job, success: false, error: failure.trim() },
                      { onSuccess: reset },
                    )
                  }
                >
                  It did not print
                </Button>
                <Button
                  disabled={record.isPending}
                  onClick={() => record.mutate({ job, success: true }, { onSuccess: reset })}
                >
                  It printed
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
