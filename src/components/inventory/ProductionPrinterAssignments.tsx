import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import {
  useProductionPrinterAssignments,
  useConfigureProductionPrinter,
} from "@/lib/production-printer-assignments";

export function ProductionPrinterAssignments() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();

  return (
    <PrinterWorkspace
      key={`${organizationId ?? ""}:${branchId ?? ""}`}
    />
  );
}

function PrinterWorkspace() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const [printerId, setPrinterId] = useState("");

  const printers = useQuery({
    queryKey: ["production-printer-settings", organizationId, branchId],
    enabled: Boolean(organizationId && branchId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("printer_profiles")
        .select("*")
        .eq("organization_id", organizationId!)
        .eq("branch_id", branchId!);

      if (error) throw error;

      return (data ?? []).filter((row) => {
        const printer = row as unknown as Record<string, unknown>;

        return (
          printer["active"] === true &&
          ["production", "kitchen", "coffee", "bar", "pastry"]
            .includes(String(printer["printer_role"] ?? "").toLowerCase())
        );
      });
    },
  });

  const stations = useQuery({
    queryKey: ["production-printer-stations", organizationId, branchId],
    enabled: Boolean(organizationId && branchId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("operational_stations")
        .select("*")
        .eq("organization_id", organizationId!);

      if (error) throw error;

      return (data ?? []).filter((row) => {
        const station = row as unknown as Record<string, unknown>;

        return (
          station["active"] === true &&
          (
            station["branch_id"] === null ||
            station["branch_id"] === branchId
          )
        );
      });
    },
  });

  const selectedPrinter = printers.data?.find(
    (row) => row.id === printerId,
  );

  if (!branchId) return null;

  return (
    <section className="rounded-xl border p-4 space-y-4">
      <div>
        <h3 className="text-lg font-semibold">
          Shared production printers
        </h3>
        <p className="text-sm text-muted-foreground">
          Assign additional production stations to a single physical
          printer without changing their production queues.
        </p>
      </div>

      <select
        aria-label="Production printer"
        className="w-full rounded-md border bg-background p-2"
        value={printerId}
        onChange={(event) => setPrinterId(event.target.value)}
        disabled={printers.isLoading || printers.isError}
      >
        <option value="">Select production printer</option>

        {(printers.data ?? []).map((row) => {
          const printer = row as unknown as Record<string, unknown>;

          return (
            <option key={row.id} value={row.id}>
              {String(
                printer["name"] ??
                printer["display_name"] ??
                row.id
              )}
            </option>
          );
        })}
      </select>

      {printers.isError || stations.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Printer or station configuration could not be loaded.
        </p>
      ) : null}

      {printers.isSuccess && printers.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No active production printers are configured for this property.
        </p>
      ) : null}

      {selectedPrinter && stations.isSuccess ? (
        <AssignmentEditor
          key={printerId}
          printerId={printerId}
          primaryStationId={
            String(
              (
                selectedPrinter as unknown as Record<string, unknown>
              )["station_id"] ?? ""
            )
          }
          stations={stations.data.map((row) => ({
            id: row.id,
            name: String(
              (
                row as unknown as Record<string, unknown>
              )["name"] ?? row.id
            ),
          }))}
        />
      ) : null}
    </section>
  );
}

function AssignmentEditor({
  printerId,
  primaryStationId,
  stations,
}: {
  printerId: string;
  primaryStationId: string;
  stations: { id: string; name: string }[];
}) {
  const assignments = useProductionPrinterAssignments(printerId);
  const save = useConfigureProductionPrinter();

  const [draft, setDraft] = useState<string[] | null>(null);

  const saved = assignments.data ?? [];
  const selected = draft ?? saved;

  const eligible = stations.filter(
    (station) => station.id !== primaryStationId,
  );

  const eligibleIds = new Set(
    eligible.map((station) => station.id),
  );

  const unavailable = selected.filter(
    (id) => !eligibleIds.has(id),
  );

  const normalized = selected.filter(
    (id) => eligibleIds.has(id),
  );

  const changed =
    JSON.stringify([...new Set(normalized)].sort()) !==
    JSON.stringify([...new Set(saved)].sort());

  function toggleStation(id: string) {
    setDraft((current) => {
      const existing = current ?? saved;

      return existing.includes(id)
        ? existing.filter((value) => value !== id)
        : [...existing, id];
    });
  }

  if (assignments.isLoading) {
    return <p className="text-sm">Loading saved assignments...</p>;
  }

  if (assignments.isError) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          Shared printer configuration is unavailable or outside
          your authorised access.
        </p>

        <Button
          variant="outline"
          onClick={() => void assignments.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {primaryStationId ? (
        <div className="rounded-md border p-3 text-sm">
          Existing dedicated station:{" "}
          {stations.find(
            (station) => station.id === primaryStationId,
          )?.name ?? "Unavailable station"}

          <p className="text-muted-foreground">
            The existing dedicated assignment remains active.
          </p>
        </div>
      ) : null}

      <p className="text-sm font-medium">
        Additional production stations
      </p>

      {eligible.map((station) => (
        <label
          key={station.id}
          className="flex items-center gap-3 rounded-md border p-3"
        >
          <input
            type="checkbox"
            checked={selected.includes(station.id)}
            disabled={save.isPending}
            onChange={() => toggleStation(station.id)}
          />
          <span>{station.name}</span>
        </label>
      ))}

      {unavailable.length > 0 ? (
        <p role="alert" className="text-sm text-amber-700">
          {unavailable.length} previous assignments are no longer
          available. Saving will remove those additional assignments.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={save.isPending}
          onClick={() => setDraft(eligible.map((row) => row.id))}
        >
          Select all
        </Button>

        <Button
          variant="outline"
          disabled={save.isPending}
          onClick={() => setDraft([])}
        >
          Clear additional stations
        </Button>

        <Button
          variant="outline"
          disabled={save.isPending}
          onClick={() => setDraft(null)}
        >
          Reset changes
        </Button>

        <Button
          disabled={
            save.isPending ||
            !assignments.isSuccess ||
            !changed
          }
          onClick={async () => {
            try {
              const confirmed = await save.mutateAsync({
                printerId,
                stationIds: normalized,
              });

              setDraft(confirmed);
            } catch {
              // Preserve unsaved selection for correction or retry.
            }
          }}
        >
          {save.isPending ? "Saving..." : "Save printer assignments"}
        </Button>
      </div>
    </div>
  );
}