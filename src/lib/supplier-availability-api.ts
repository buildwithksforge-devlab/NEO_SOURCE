import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

import {
  assertAvailabilityResponse,
  type AvailabilityLine,
} from "@/lib/supplier-availability";

const db = supabase as any;

export function useSubmitSupplierAvailability() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      branchId: string;
      relationshipId: string;
      rfqId: string;
      attemptId: string;
      lines: AvailabilityLine[];
      notes?: string;
    }) => {
      if (
        !input.branchId ||
        !input.relationshipId ||
        !input.rfqId ||
        !input.attemptId ||
        !input.lines.length
      ) {
        throw new Error("Incomplete supplier response.");
      }

      const { data, error } = await db.rpc(
        "neo_partner_supplier_availability_submit",
        {
          _branch: input.branchId,
          _relationship: input.relationshipId,
          _rfq: input.rfqId,
          _lines: input.lines,
          _notes: input.notes ?? null,
          _attempt: input.attemptId,
        }
      );

      if (error) throw error;

      return {
        responseId: assertAvailabilityResponse(data),
        rfqId: input.rfqId,
      };
    },

    onSuccess: async (_result, input) => {
      await Promise.all([
        qc.invalidateQueries({
          queryKey: ["supplier-availability-history"],
        }),
        qc.invalidateQueries({
          queryKey: [
            "partner-supplier-rfqs",
            input.branchId,
            input.relationshipId,
          ],
        }),
        qc.invalidateQueries({
          queryKey: ["procurement-department"],
        }),
      ]);
    },
  });
}

export function useSupplierAvailabilityHistory(
  rfqId: string | null
) {
  const { organizationId, user } = useAuth();

  return useQuery({
    queryKey: [
      "supplier-availability-history",
      organizationId,
      user?.id,
      rfqId,
    ],

    enabled: Boolean(
      organizationId &&
      user?.id &&
      rfqId
    ),

    queryFn: async () => {
      const { data, error } = await db.rpc(
        "neo_procurement_supplier_availability_history",
        {
          _rfq: rfqId,
        }
      );

      if (error) throw error;

      if (!Array.isArray(data)) {
        throw new Error(
          "Supplier availability history could not be verified."
        );
      }

      return data as Record<string, unknown>[];
    },
  });
}