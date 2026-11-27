import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export function verifyPrinterAssignment(
  data: unknown,
  printerId: string,
  stationIds: string[],
) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Printer configuration was not confirmed.");
  }

  const result = data as Record<string, unknown>;

  if (
    result["ok"] !== true ||
    result["printer_id"] !== printerId ||
    !Array.isArray(result["station_ids"])
  ) {
    throw new Error("Saved printer configuration could not be verified.");
  }

  const expected = [...new Set(stationIds)].sort();
  const actual = [...new Set(result["station_ids"].map(String))].sort();

  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Saved station assignments differ from the selection.");
  }

  return actual;
}

export function useProductionPrinterAssignments(printerId: string) {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();

  return useQuery({
    queryKey: [
      "production-printer-assignments",
      organizationId,
      branchId,
      printerId,
    ],
    enabled: Boolean(organizationId && branchId && printerId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(
        supabase,
        "neo_get_production_printer_assignments",
        { _printer: printerId } as never,
      );

      if (error) throw new Error(error.message);

      if (
        !Array.isArray(data) ||
        data.some((value) => typeof value !== "string")
      ) {
        throw new Error("Printer assignments could not be verified.");
      }

      return data as string[];
    },
  });
}

export function useConfigureProductionPrinter() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      printerId: string;
      stationIds: string[];
    }) => {
      if (!input.printerId) {
        throw new Error("Select a production printer.");
      }

      const stationIds = [...new Set(input.stationIds)];

      const { data, error } = await guardedRpc(
        supabase,
        "neo_configure_production_printer",
        {
          _printer: input.printerId,
          _stations: stationIds,
        } as never,
      );

      if (error) throw new Error(error.message);

      return verifyPrinterAssignment(
        data,
        input.printerId,
        stationIds,
      );
    },
    onSuccess: () => {
      toast.success("Production printer assignments saved.");
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({
          queryKey: ["production-printer-assignments"],
        }),
        qc.invalidateQueries({ queryKey: ["printers"] }),
        qc.invalidateQueries({ queryKey: ["printing"] }),
      ]),
  });
}