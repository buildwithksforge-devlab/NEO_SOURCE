/**
 * Report a problem — the operator-facing defect logger.
 *
 * The certification lens says: if a receptionist cannot check someone in, if a
 * button does nothing, if a dropdown contains nonsense, if a receipt looks
 * cheap — log it. That only happens if logging takes seconds and is reachable
 * from wherever the person is standing, so this lives in the topbar on every
 * screen.
 *
 * The report is filed through `neo_report_defect`, which stamps the reporter,
 * the organisation and a readable reference. Any signed-in worker may report;
 * reading and resolving the queue still requires quality permissions, so a
 * waiter can raise a problem without gaining sight of the whole defect log.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Bug } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBranchScope } from "@/lib/branches";

const SEVERITIES = [
  { value: "low", label: "Cosmetic — it looks wrong but work continues" },
  { value: "medium", label: "Awkward — there is a workaround" },
  { value: "high", label: "Blocking me — I cannot finish this task" },
  { value: "critical", label: "Blocking the property — guests are affected" },
];

export function ReportProblemDialog({ variant = "icon" }: { variant?: "icon" | "menu" } = {}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { activeBranch } = useBranchScope();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [actual, setActual] = useState("");
  const [expected, setExpected] = useState("");
  const [severity, setSeverity] = useState("medium");

  const moduleName = pathname.split("/").filter(Boolean)[0] ?? "dashboard";

  const submit = useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_report_defect" as never, {
        _module: moduleName,
        _summary: summary,
        _actual: actual,
        _expected: expected,
        _steps: null,
        _severity: severity,
        _route: pathname,
        _branch: activeBranch?.id ?? null,
      } as never);
      if (error) throw error;
      return data as { reference?: string } | null;
    },
    onSuccess: (data) => {
      toast.success(
        data?.reference
          ? `Logged as ${data.reference}. It is now in the quality queue.`
          : "Logged. It is now in the quality queue.",
      );
      setSummary("");
      setActual("");
      setExpected("");
      setSeverity("medium");
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {variant === "menu" ? (
        <DialogTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left text-sm"
            aria-label="Report a problem"
          >
            <Bug className="size-4" /> Report a problem
          </button>
        </DialogTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Report a problem"
                className="size-10 shrink-0 rounded-xl text-muted-foreground hover:bg-primary-soft/60 hover:text-primary"
              >
                <Bug className="size-5" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>Report a problem</TooltipContent>
        </Tooltip>
      )}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Report a problem</DialogTitle>
          <DialogDescription>
            Anything that stopped you, misled you or looked wrong. The screen you are on
            ({pathname}) and the property you are viewing are attached automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="defect-summary">What went wrong?</Label>
            <Input
              id="defect-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Check-in button does nothing for a paid reservation"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="defect-actual">What actually happened</Label>
            <Textarea
              id="defect-actual"
              rows={3}
              value={actual}
              onChange={(e) => setActual(e.target.value)}
              placeholder="Nothing happened and no message appeared."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="defect-expected">What you expected instead</Label>
            <Textarea
              id="defect-expected"
              rows={2}
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              placeholder="The guest should be checked in and a folio opened."
            />
          </div>
          <div className="space-y-1.5">
            <Label>How badly does it affect the work?</Label>
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => submit.mutate()}
            disabled={submit.isPending || summary.trim().length < 5}
          >
            {submit.isPending ? "Sending…" : "Send report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
