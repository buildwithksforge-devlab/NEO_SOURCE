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
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
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

async function rpc<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await guardedRpc(sb, name, args ?? {});
  if (error) throw new Error(error.message);
  return data as T;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: [KEY] });
}

export function usePrinters(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, "printers", organizationId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb.from("printer_profiles").select("*").order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as Printer[];
    },
  });
}

export function usePrintJobs(organizationId: string | null | undefined) {
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
      if (error) throw new Error(error.message);
      return (data ?? []) as PrintJob[];
    },
  });
}

export function useSavePrinter() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: Row) => {
      const { id, ...values } = input;
      const query = id
        ? sb.from("printer_profiles").update(values).eq("id", id)
        : sb.from("printer_profiles").insert(values);
      const { error } = await query;
      if (error) throw new Error(error.message);
      return id ?? null;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Printer saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useQueuePrint() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { printer: string; documentType: string; title?: string; payload?: Row }) =>
      rpc<string>("neo_print_enqueue", {
        _printer: input.printer,
        _document_type: input.documentType,
        _title: input.title ?? null,
        _payload: input.payload ?? {},
      }),
    onSuccess: () => {
      invalidate();
      toast.success("Queued — record the result once you know whether it printed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecordPrintResult() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { job: string; success: boolean; error?: string }) =>
      rpc<Row>("neo_print_record_result", {
        _job: input.job,
        _success: input.success,
        _error: input.error ?? null,
      }),
    onSuccess: (result) => {
      invalidate();
      if (result?.["failed_over"]) toast.warning("Retries exhausted — sent to the backup printer");
      else if (result?.["status"] === "queued") toast.message("Failed — queued for another attempt");
      else if (result?.["status"] === "failed") toast.error("Failed with no backup printer configured");
      else toast.success("Recorded as printed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRetryPrintJob() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (job: string) => rpc("neo_print_retry", { _job: job }),
    onSuccess: () => {
      invalidate();
      toast.success("Job re-queued");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
