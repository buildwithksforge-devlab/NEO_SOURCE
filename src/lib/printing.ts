/**
 * Printer integration data layer.
 *
 * NEØ does not pretend to have printed anything. A print is queued in the
 * database; a printing agent (or the operator, for a test print) records the
 * real outcome. Failures retry on the same printer and, once the retry limit
 * is reached, fail over to the configured backup printer.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const sb = supabase as unknown as {
  from: (t: string) => any;
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

const KEY = "printing";

export type Printer = {
  id: string;
  name: string;
  printer_role: string | null;
  branch_id: string | null;
  department_id: string | null;
  station_id: string | null;
  fallback_printer_id: string | null;
  connection_type: string | null;
  address: string | null;
  status: string | null;
  health_status: string;
  retry_limit: number;
  retry_backoff_seconds: number;
  last_error: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_checked_at: string | null;
  active: boolean;
};

export type PrintJob = {
  id: string;
  printer_id: string;
  original_printer_id: string | null;
  document_type: string;
  title: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  failed_over: boolean;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
};

export type PosReceiptPrintState = {
  hasCompletedPrint: boolean;
  latest: {
    id: string;
    status: string;
    is_duplicate: boolean;
    completed_at: string | null;
  } | null;
};

async function rpc<T = unknown>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await guardedRpc(sb, name, args ?? {});

  if (error) {
    throw new Error(error.message);
  }

  return data as T;
}

function useInvalidate() {
  const qc = useQueryClient();

  return () => {
    void qc.invalidateQueries({
      queryKey: [KEY],
    });
  };
}

/**
 * All configured printers visible to the current organisation.
 */
export function usePrinters(
  organizationId: string | null | undefined,
) {
  return useQuery({
    queryKey: [KEY, "printers", organizationId ?? null],
    enabled: Boolean(organizationId),

    queryFn: async () => {
      const { data, error } = await sb
        .from("printer_profiles")
        .select("*")
        .order("name");

      if (error) {
        throw new Error(error.message);
      }

      return (data ?? []) as Printer[];
    },
  });
}

/**
 * Recent organisation print jobs.
 *
 * This is primarily used by printer administration / monitoring screens.
 * POS order pages should use usePosReceiptPrintState() instead of loading the
 * organisation-wide print history.
 */
export function usePrintJobs(
  organizationId: string | null | undefined,
) {
  return useQuery({
    queryKey: [KEY, "jobs", organizationId ?? null],
    enabled: Boolean(organizationId),
    refetchInterval: 15000,

    queryFn: async () => {
      const { data, error } = await sb
        .from("print_jobs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) {
        throw new Error(error.message);
      }

      return (data ?? []) as PrintJob[];
    },
  });
}

/**
 * Returns whether this exact POS order already has a successfully completed
 * physical receipt print.
 *
 * The backend remains authoritative:
 *
 * - no completed print -> pos.receipts.print
 * - completed print exists -> any new physical copy is a reprint and requires
 *   pos.receipts.reprint
 *
 * This hook is only for presenting the correct action in the UI. It must not
 * be treated as the security boundary.
 */
export function usePosReceiptPrintState(
  orderId: string | null | undefined,
) {
  return useQuery<PosReceiptPrintState>({
    queryKey: [
      KEY,
      "pos-receipt-state",
      orderId ?? null,
    ],

    enabled: Boolean(orderId),

    queryFn: async () => {
      if (!orderId) {
        return {
          hasCompletedPrint: false,
          latest: null,
        };
      }

      const { data, error } = await sb
        .from("print_jobs")
        .select(
          "id, status, is_duplicate, completed_at",
        )
        .eq("order_id", orderId)
        .eq("document_type", "pos_receipt")
        .eq("status", "completed")
        .not("completed_at", "is", null)
        .order("completed_at", {
          ascending: false,
        })
        .limit(1);

      if (error) {
        throw new Error(error.message);
      }

      const row = data?.[0] ?? null;

      const latest = row
        ? {
            id: String(row.id),
            status: String(row.status),
            is_duplicate: Boolean(row.is_duplicate),
            completed_at:
              row.completed_at === null ||
              row.completed_at === undefined
                ? null
                : String(row.completed_at),
          }
        : null;

      return {
        hasCompletedPrint: Boolean(
          latest?.completed_at,
        ),
        latest,
      };
    },
  });
}

/**
 * Create or update a printer profile.
 */
export function useSavePrinter() {
  const invalidate = useInvalidate();

  return useMutation({
    mutationFn: async (input: Row) => {
      const { id, ...values } = input;

      const query = id
        ? sb
            .from("printer_profiles")
            .update(values)
            .eq("id", id)
        : sb
            .from("printer_profiles")
            .insert(values);

      const { error } = await query;

      if (error) {
        throw new Error(error.message);
      }

      return id ?? null;
    },

    onSuccess: () => {
      invalidate();
      toast.success("Printer saved");
    },

    onError: (e: Error) => {
      toast.error(e.message);
    },
  });
}

/**
 * Queue a document for physical printing.
 *
 * For POS receipts, neo_print_enqueue is responsible for deciding whether the
 * request is the first print or a reprint and enforcing the corresponding
 * permission.
 */
export function useQueuePrint() {
  const invalidate = useInvalidate();

  return useMutation({
    mutationFn: (input: {
      printer: string;
      documentType: string;
      title?: string;
      payload?: Row;
    }) =>
      rpc<string>("neo_print_enqueue", {
        _printer: input.printer,
        _document_type: input.documentType,
        _title: input.title ?? null,
        _payload: input.payload ?? {},
      }),

    onSuccess: () => {
      invalidate();

      toast.success(
        "Queued — record the result once you know whether it printed",
      );
    },

    onError: (e: Error) => {
      if (
        e.message.includes(
          "receipt_reprint_permission_required",
        )
      ) {
        toast.error(
          "This receipt has already been printed. Reprint permission is required.",
        );
        return;
      }

      toast.error(e.message);
    },
  });
}

/**
 * Record the real physical outcome of a queued print job.
 *
 * A successful result is what makes a POS receipt count as having been
 * physically printed. Queueing alone does not.
 */
export function useRecordPrintResult() {
  const invalidate = useInvalidate();

  return useMutation({
    mutationFn: (input: {
      job: string;
      success: boolean;
      error?: string;
    }) =>
      rpc<Row>("neo_print_record_result", {
        _job: input.job,
        _success: input.success,
        _error: input.error ?? null,
      }),

    onSuccess: (result) => {
      invalidate();

      if (result?.["failed_over"]) {
        toast.warning(
          "Retries exhausted — sent to the backup printer",
        );
      } else if (
        result?.["status"] === "queued"
      ) {
        toast.message(
          "Failed — queued for another attempt",
        );
      } else if (
        result?.["status"] === "failed"
      ) {
        toast.error(
          "Failed with no backup printer configured",
        );
      } else if (
        result?.["is_duplicate"] === true
      ) {
        toast.success(
          "Receipt reprint recorded as printed",
        );
      } else {
        toast.success(
          "Recorded as printed",
        );
      }
    },

    onError: (e: Error) => {
      if (
        e.message.includes(
          "receipt_reprint_permission_required",
        )
      ) {
        toast.error(
          "Reprint permission is required for this receipt.",
        );
        return;
      }

      toast.error(e.message);
    },
  });
}

/**
 * Retry the same physical print job.
 *
 * This does not create a new receipt copy classification. A failed first-print
 * job remains a first-print job; a failed reprint remains a reprint.
 */
export function useRetryPrintJob() {
  const invalidate = useInvalidate();

  return useMutation({
    mutationFn: (job: string) =>
      rpc("neo_print_retry", {
        _job: job,
      }),

    onSuccess: () => {
      invalidate();
      toast.success("Job re-queued");
    },

    onError: (e: Error) => {
      if (
        e.message.includes(
          "receipt_reprint_permission_required",
        )
      ) {
        toast.error(
          "Reprint permission is required for this receipt.",
        );
        return;
      }

      toast.error(e.message);
    },
  });
}