/**
 * GOV-APP-01 — deliberate self-approval exceptions.
 *
 * The platform rule is that whoever raises a controlled record cannot approve
 * that same record. A workspace may record a written, dated exception for one
 * workflow at a time; every use of it is logged against the person who raised
 * the record and the person who approved it.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { MAKER_CHECKER_TABLES } from "@/lib/maker-checker";

type ExceptionRow = {
  id: string;
  workflow_key: string;
  reason: string;
  effective_from: string;
  effective_to: string | null;
  active: boolean;
};

export function SelfApprovalExceptions({ mayConfigure }: { mayConfigure: boolean }) {
  const { organizationId, user } = useAuth();
  const qc = useQueryClient();
  const [workflow, setWorkflow] = useState("");
  const [reason, setReason] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const rows = useQuery({
    queryKey: ["self-approval-exceptions", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("self_approval_exceptions")
        .select("id, workflow_key, reason, effective_from, effective_to, active")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ExceptionRow[];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!organizationId) throw new Error("No workspace context.");
      if (!workflow) throw new Error("Choose the workflow this exception covers.");
      if (reason.trim().length < 20)
        throw new Error("Write at least 20 characters explaining why this exception exists.");
      const { error } = await supabase.from("self_approval_exceptions").insert({
        organization_id: organizationId,
        workflow_key: workflow,
        reason: reason.trim(),
        created_by: user?.id ?? null,
        ...(from ? { effective_from: from } : {}),
        ...(to ? { effective_to: to } : {}),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Exception recorded");
      setWorkflow("");
      setReason("");
      setFrom("");
      setTo("");
      void qc.invalidateQueries({ queryKey: ["self-approval-exceptions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const withdraw = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("self_approval_exceptions")
        .update({ active: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Exception withdrawn");
      void qc.invalidateQueries({ queryKey: ["self-approval-exceptions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const labelFor = (key: string) =>
    MAKER_CHECKER_TABLES.find((t) => t.table === key)?.label ?? key;

  return (
    <SectionCard
      title="Self-approval exceptions"
      description="By default nobody may approve a record they raised themselves, whatever their role. Record an exception only where your organisation has decided otherwise; every use is logged."
    >
      {mayConfigure ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
          <div className="grid gap-1.5">
            <Label>Workflow</Label>
            <Select value={workflow} onValueChange={setWorkflow}>
              <SelectTrigger>
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                {MAKER_CHECKER_TABLES.map((t) => (
                  <SelectItem key={t.table} value={t.table}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="exc-from">Effective from</Label>
            <NeoDatePicker id="exc-from" value={from} onChange={(v) => setFrom(v)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="exc-to">Effective to (optional)</Label>
            <NeoDatePicker
              id="exc-to"
              value={to}
              placeholder="No end date"
              min={from || undefined}
              onChange={(v) => setTo(v)}
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2 lg:col-span-4">
            <Label htmlFor="exc-reason">Written justification</Label>
            <Textarea
              id="exc-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this workflow may be self-approved here, and who decided it."
            />
          </div>
          <div>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              <ShieldAlert className="size-4" /> Record exception
            </Button>
          </div>
        </div>
      ) : null}

      {rows.isLoading ? (
        <LoadingState rows={2} />
      ) : (rows.data ?? []).length === 0 ? (
        <EmptyState
          inline
          title="No exceptions recorded"
          description="Maker/checker separation applies to every controlled workflow in this workspace."
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {(rows.data ?? []).map((r) => (
            <li key={r.id} className="surface-panel p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{labelFor(r.workflow_key)}</p>
                <StatusPill tone={r.active ? "warning" : "default"}>
                  {r.active ? "Active" : "Withdrawn"}
                </StatusPill>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {r.effective_from}
                {r.effective_to ? ` → ${r.effective_to}` : " → open ended"}
              </p>
              <p className="mt-1 text-xs">{r.reason}</p>
              {mayConfigure && r.active ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => withdraw.mutate(r.id)}
                  disabled={withdraw.isPending}
                >
                  Withdraw
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
