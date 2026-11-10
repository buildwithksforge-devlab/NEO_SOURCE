import { useEffect, useState } from "react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorState } from "@/components/common/StateSystem";
import {
  usePrinterDiscovery,
  useRequestPrinterDiscovery,
  type PrintAgent,
  type DiscoveredPrinter,
} from "@/lib/printing";

export function PrinterDiscoveryPanel({
  agents,
  onChoose,
}: {
  agents: PrintAgent[];
  onChoose: (printer: DiscoveredPrinter, branch: string) => void;
}) {
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("windows");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2500);
    return () => clearInterval(timer);
  }, []);
  const selected = agents.find((item) => item.id === agent && item.active);
  const status = usePrinterDiscovery(selected?.id ?? null);
  const request = useRequestPrinterDiscovery();
  const data = status.data;
  const pending = Boolean(data?.request_id && data.request_id !== data.reported_request_id);
  const timedOut = pending && now - Date.parse(data?.requested_at ?? "") > 120000;
  const stale = !data?.last_seen_at || now - Date.parse(data.last_seen_at) > 90000;
  return (
    <SectionCard
      title="Find printers on a property computer"
      description="Search through your own local print agent. No third-party printing service is used."
    >
      <div className="flex flex-wrap gap-3">
        <Select value={agent} onValueChange={setAgent}>
          <SelectTrigger className="w-64" aria-label="Property print agent">
            <SelectValue placeholder="Choose a property computer" />
          </SelectTrigger>
          <SelectContent>
            {agents
              .filter((item) => item.active && item.branch_id)
              .map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-64" aria-label="Printer search type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="windows">All installed Windows printers</SelectItem>
            <SelectItem value="network">Wi-Fi / LAN discovery</SelectItem>
            <SelectItem value="usb">Installed USB printers</SelectItem>
            <SelectItem value="bluetooth">Paired Bluetooth printer queues</SelectItem>
          </SelectContent>
        </Select>
        <Button
          disabled={!selected || status.isError || request.isPending || (pending && !timedOut)}
          onClick={() => {
            if (selected) request.mutate({ agent: selected.id, kind });
          }}
        >
          Search printers
        </Button>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        Keep the updated agent running on the selected property computer. USB and Bluetooth devices
        need their Windows driver/queue first; Bluetooth pairing is completed in Windows Settings.
        Wi-Fi/LAN searches local printer advertisements and installed queues. Office/IPP printers
        require an installed Windows queue; direct output here is for compatible ESC/POS thermal
        printers.
      </p>
      {!agents.some(item => item.active && item.branch_id) ? (
        <p role="status" className="mt-2 text-sm">
          No property computer is paired. Pair a computer in the print-agent section, download its
          private configuration and start the NEØ print agent on that computer before searching.
          Saving a printer name alone does not connect a printer.
        </p>
      ) : null}
      {status.isError ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : null}
      {selected && stale ? (
        <p role="status" className="mt-2 text-sm">
          Agent has not checked in recently. Start or update it before searching.
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="mt-2 text-sm">
          {timedOut
            ? "Search timed out. Check that the updated agent is running, then search again."
            : "Search requested; waiting for the local computer’s actual results…"}
        </p>
      ) : null}
      {data?.result ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm">
            Last search: {new Date(data.reported_at ?? "").toLocaleString()} ·{" "}
            {data.result.printers.length} detected
          </p>
          {data.result.notes.map((note, index) => (
            <p key={index} className="text-sm text-muted-foreground">
              {note}
            </p>
          ))}
          {data.result.printers.length === 0 ? (
            <p>
              No matching printers were detected. Check pairing, power and network, or enter a known
              address below.
            </p>
          ) : null}
          {data.result.printers.map((printer, index) => (
            <div
              key={`${printer.address}-${index}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0">
                <p className="break-words font-medium">{printer.name}</p>
                <p className="break-all text-sm">
                  {printer.address} · {printer.source}
                </p>
                <p className="text-sm text-muted-foreground">{printer.note}</p>
              </div>
              <Button
                variant="outline"
                disabled={printer.connection_type === "unsupported" || !selected?.branch_id}
                onClick={() => {
                  if (selected?.branch_id) onChoose(printer, selected.branch_id);
                }}
              >
                Use this printer
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}
