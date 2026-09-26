import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

type Blocker = { table: string; column: string; rows: number };
type DeleteResult = { ok: boolean; deleted: boolean; blockers: Blocker[]; name?: string };

function parseDeleteResult(value: unknown): DeleteResult {
  if (!value || typeof value !== "object") {
    throw new Error("The delete check returned an unreadable result. Nothing was deleted.");
  }
  const result = value as Partial<DeleteResult>;
  if (typeof result.ok !== "boolean" || !Array.isArray(result.blockers)) {
    throw new Error("The delete check was incomplete. Nothing was deleted.");
  }
  return {
    ok: result.ok,
    deleted: result.deleted === true,
    blockers: result.blockers,
    ...(result.name ? { name: result.name } : {}),
  };
}

/**
 * Deletion is only ever offered where nothing else depends on the record.
 * The database counts every reference first; if anything still points at the
 * role or department the delete is refused and the blockers are named, so
 * operational history is never silently detached from its structure.
 */
export function DeleteStructureRecord({
  kind,
  id,
  name,
  invalidateKeys,
  onDeleted,
}: {
  kind: "role" | "department";
  id: string;
  name: string;
  invalidateKeys: unknown[][];
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [blockers, setBlockers] = useState<Blocker[] | null>(null);

  const remove = useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_delete_structure_record", {
        _kind: kind,
        _id: id,
      });
      if (error) throw error;
      return parseDeleteResult(data);
    },
    onSuccess: (result) => {
      if (!result?.ok) {
        setBlockers(result?.blockers ?? []);
        return;
      }
      if (!result.deleted) {
        toast.error("The record was not deleted. Please refresh and try again.");
        return;
      }
      toast.success(`${result.name ?? name} deleted`);
      setOpen(false);
      setBlockers(null);
      for (const key of invalidateKeys) void qc.invalidateQueries({ queryKey: key });
      onDeleted?.();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const label = kind === "role" ? "role" : "department";

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => {
          setBlockers(null);
          setOpen(true);
        }}
      >
        <Trash2 className="size-4" /> Delete
      </Button>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setBlockers(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {label}</DialogTitle>
            <DialogDescription>
              {blockers
                ? `${name} is still in use, so it cannot be deleted. Deactivate it instead to take it out of daily use while its records stay intact.`
                : `${name} will be removed permanently. This is only possible while nothing is using it.`}
            </DialogDescription>
          </DialogHeader>

          {blockers ? (
            <ul className="max-h-56 space-y-1 overflow-auto rounded-md border border-border p-3 text-sm">
              {blockers.map((b) => (
                <li key={`${b.table}.${b.column}`} className="flex justify-between gap-3">
                  <span className="truncate text-muted-foreground">
                    {b.table.replace(/^public\./, "").replace(/_/g, " ")}
                  </span>
                  <span className="tabular-nums">{b.rows}</span>
                </li>
              ))}
              {blockers.length === 0 ? <li className="text-muted-foreground">No details returned.</li> : null}
            </ul>
          ) : null}

          <DialogFooter>
            <Button variant="outline" disabled={remove.isPending} onClick={() => setOpen(false)}>
              {blockers ? "Close" : "Cancel"}
            </Button>
            {blockers ? null : (
              <Button
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? "Checking…" : `Delete ${label}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
