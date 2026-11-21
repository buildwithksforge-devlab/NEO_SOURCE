import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
export function DeleteIncorrectEmployeeButton({
  id,
  number,
  name,
  linkedProfile = false,
  onDeleted,
}: {
  id: string;
  number: string;
  name: string;
  linkedProfile?: boolean;
  onDeleted?: () => void;
}) {
  const { can, isAdmin } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false),
    [confirmation, setConfirmation] = useState(""),
    [reason, setReason] = useState(""),
    [problem, setProblem] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_hr_delete_incorrect_employee", {
        _employee: id,
        _confirmation: confirmation.trim(),
        _reason: reason.trim(),
      });
      if (error) throw Error(error.message);
      const result = data as {
        ok?: boolean;
        deleted?: boolean;
        employee_id?: string;
        linked_login_deleted?: boolean;
      } | null;
      if (
        !result?.ok ||
        result.deleted !== true ||
        result.employee_id !== id ||
        result.linked_login_deleted !== false
      )
        throw Error("Employee deletion could not be verified. Refresh before retrying.");
      return result;
    },
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["hr"] }),
        qc.invalidateQueries({ queryKey: ["hr-department"] }),
      ]),
  });
  if (!isAdmin && !can("hr-employees", "delete")) return null;
  return (
    <>
      <Button
        size="sm"
        variant="destructive"
        onClick={() => {
          setProblem(null);
          setOpen(true);
        }}
      >
        <Trash2 className="mr-2 size-4" />
        Delete incorrect record
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!remove.isPending) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete incorrect employee record</DialogTitle>
            <DialogDescription>
              This permanently removes {name} ({number}) and unused setup details. Payroll,
              attendance, leave activity, assignments and other linked history stop deletion. The
              audit entry remains. Login accounts are not deleted.
            </DialogDescription>
          </DialogHeader>
          {linkedProfile ? (
            <p className="text-sm text-destructive">
              This record has a linked login. Correct or unlink that account separately before
              deleting the employee record.
            </p>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="employee-delete-number">Type {number} to confirm</Label>
            <Input
              id="employee-delete-number"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
            />
            <Label htmlFor="employee-delete-reason">Why is this record incorrect?</Label>
            <Input
              id="employee-delete-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
            />
          </div>
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={remove.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                linkedProfile ||
                confirmation.trim() !== number ||
                reason.trim().length < 3 ||
                remove.isPending
              }
              onClick={async () => {
                try {
                  setProblem(null);
                  await remove.mutateAsync();
                  setOpen(false);
                  toast.success("Incorrect employee record deleted.");
                  if (onDeleted) onDeleted();
                  else await navigate({ to: "/hr/employees" });
                } catch (e) {
                  setProblem(e instanceof Error ? e.message : "Deletion failed.");
                }
              }}
            >
              {remove.isPending ? "Checking and deleting…" : "Delete this incorrect record"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
