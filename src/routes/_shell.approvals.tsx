import { guardedRpc } from "@/lib/rpc-guard";
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Plus,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useScopedWorkerOptions } from "@/lib/scoped-options";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { describeAuthority, useMyApprovalAuthority } from "@/lib/finance-controls";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/approvals")({
  head: () => ({
    meta: [
      { title: "Approvals — NEØ" },
      {
        name: "description",
        content:
          "Central approval inbox for voids, refunds, discounts, purchases and rate changes.",
      },
      { property: "og:title", content: "Approvals — NEØ" },
      {
        property: "og:description",
        content:
          "Central approval inbox for voids, refunds, discounts, purchases and rate changes.",
      },
    ],
  }),
  component: ApprovalsPage,
});

/** The single authoritative request lifecycle. Nothing else defines status. */
export const REQUEST_STATUSES = [
  "draft",
  "pending_approval",
  "returned_for_correction",
  "approved_pending_execution",
  "executing",
  "completed",
  "rejected",
  "cancelled",
  "execution_failed",
] as const;

/** The single authoritative approval-step lifecycle. */
export const STEP_STATUSES = [
  "waiting",
  "active",
  "approved",
  "rejected",
  "returned",
  "escalated",
  "skipped",
  "cancelled",
] as const;

/** The four outcomes an approver may record. */
export const DECISIONS = ["approved", "rejected", "returned", "escalated"] as const;
export type Decision = (typeof DECISIONS)[number];

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

type ApprovalStep = {
  id: string;
  level: number;
  status: string;
  approver_user_id: string | null;
  approver_role_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  comment: string;
};

type ApprovalRequest = {
  id: string;
  reference: string;
  approval_type: string;
  requester_id: string;
  approver_id: string | null;
  reason: string;
  notes: string;
  amount: number | null;
  requested_percent: number | null;
  escalated_to_owner: boolean;
  level: number;
  max_level: number;
  status: RequestStatus;
  execution_status: string;
  execution_error: string;
  created_at: string;
  decided_at: string | null;
  completed_at: string | null;
  approval_steps: ApprovalStep[];
};

const TYPES = [
  { key: "void", name: "Void transaction" },
  { key: "refund", name: "Refund" },
  { key: "discount", name: "Discount override" },
  { key: "purchase", name: "Purchase order" },
  { key: "payment", name: "Payment release" },
  { key: "rate-change", name: "Rate change" },
  { key: "stock-adjustment", name: "Stock adjustment" },
  { key: "leave", name: "Staff leave" },
];

const STATUS_LABEL: Record<RequestStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending",
  returned_for_correction: "Returned for correction",
  approved_pending_execution: "Approved — awaiting execution",
  executing: "Executing",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  execution_failed: "Execution failed",
};

/** The currently active step, i.e. the only level that can be acted on. */
export function activeStep(request: Pick<ApprovalRequest, "approval_steps">): ApprovalStep | null {
  return (
    [...(request.approval_steps ?? [])]
      .sort((a, b) => a.level - b.level)
      .find((s) => s.status === "active") ?? null
  );
}

/** A request only reaches an approver's inbox while their level is the active one. */
export function isInMyInbox(
  request: ApprovalRequest,
  userId: string | null,
  roleIds: string[] = [],
): boolean {
  if (request.status !== "pending_approval") return false;
  if (!userId || request.requester_id === userId) return false;
  const step = activeStep(request);
  if (!step) return false;
  if (step.approver_user_id) return step.approver_user_id === userId;
  return Boolean(step.approver_role_id && roleIds.includes(step.approver_role_id));
}

function ApprovalsPage() {
  const { organizationId, user, can, access } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { applyTo, filterKey } = useActivePropertyFilter();

  const requests = useQuery({
    queryKey: ["approval-requests", organizationId, filterKey],
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("approval_requests")
          .select(
            "*, approval_steps(id, level, status, approver_user_id, approver_role_id, decided_by, decided_at, comment)",
          ),
        "approval_requests",
      ).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as ApprovalRequest[];
    },
  });

  // Canonical profiles.id options for the active property only.
  const staff = useScopedWorkerOptions();

  const canApprove = can("administration", "approvals", "decide");

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["approval-requests"] });
    void qc.invalidateQueries({ queryKey: ["dashboard-approvals"] });
    void qc.invalidateQueries({ queryKey: ["notifications"] });
    void qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  const decide = useMutation({
    mutationFn: async ({
      request,
      action,
      comment,
    }: {
      request: ApprovalRequest;
      action: Decision;
      comment: string;
    }) => {
      const step = activeStep(request);
      const { data, error } = await guardedRpc(supabase, "neo_approval_decide", {
        _request: request.id,
        _action: action,
        _comment: comment,
        _idempotency_key: `approval:${request.id}:level:${step?.level ?? request.level}:${action}`,
      });
      if (error) throw error;
      const result = (data ?? {}) as {
        ok?: boolean;
        error?: string;
        status?: string;
        escalated?: boolean;
      };
      if (result.ok === false) throw new Error(result.error ?? "Decision could not be recorded.");
      return result;
    },
    onSuccess: (result) => {
      toast.success(
        result.status === "returned_for_correction"
          ? "Returned to the requester for correction"
          : result.escalated
            ? "Beyond your configured limit — escalated to the Owner"
            : result.status === "execution_failed"
              ? "Approved, but the authorised action failed — see Execution failed."
              : "Decision recorded",
      );
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const retry = useMutation({
    mutationFn: async (request: ApprovalRequest) => {
      const { data, error } = await guardedRpc(supabase, "neo_approval_retry_execution", {
        _request: request.id,
      });
      if (error) throw error;
      const result = (data ?? {}) as { ok?: boolean; error?: string };
      if (result.ok === false) throw new Error(result.error ?? "Execution failed again.");
      return result;
    },
    onSuccess: () => {
      toast.success("Action executed");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const all = requests.data ?? [];
  const loading = requests.isLoading;
  const uid = user?.id ?? null;

  const inbox = all.filter((r) => isInMyInbox(r, uid, access.roleIds));
  const mine = all.filter((r) => r.requester_id === uid);
  const myActive = mine.filter((r) =>
    ["pending_approval", "approved_pending_execution", "executing", "execution_failed"].includes(
      r.status,
    ),
  );
  const awaitingExecution = all.filter((r) =>
    ["approved_pending_execution", "executing"].includes(r.status),
  );
  const returned = all.filter((r) => r.status === "returned_for_correction");
  const failed = all.filter((r) => r.status === "execution_failed");
  const completed = all.filter((r) => r.status === "completed");
  const rejected = all.filter((r) => r.status === "rejected");
  const cancelled = all.filter((r) => r.status === "cancelled");

  const nameOf = (id: string | null) =>
    (staff.data ?? []).find((s) => s.id === id)?.full_name ?? "—";

  const count = (n: number) => (loading ? "…" : String(n));

  const list = (
    items: ApprovalRequest[],
    showActions: boolean,
    emptyText = "Nothing in this queue.",
  ) =>
    loading ? (
      <LoadingState rows={3} />
    ) : items.length === 0 ? (
      <EmptyState inline title="Nothing in this queue" description={emptyText} />
    ) : (
      <ul className="space-y-3">
        {items.map((r) => (
          <ApprovalRow
            key={r.id}
            request={r}
            requester={nameOf(r.requester_id)}
            nameOf={nameOf}
            canAct={showActions && isInMyInbox(r, uid, access.roleIds)}
            onDecide={(action, comment) => decide.mutate({ request: r, action, comment })}
            onRetry={canApprove ? () => retry.mutate(r) : undefined}
          />
        ))}
      </ul>
    );

  return (
    <div>
      <PageHeader
        eyebrow="Management"
        title="Approvals"
        description="One lifecycle: every decision, chain step, notification, task and downstream action is derived from the same record."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" /> Raise request
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Pending my decision" value={count(inbox.length)} icon={ClipboardCheck} />
        <StatCard label="Completed" value={count(completed.length)} icon={CheckCircle2} />
        <StatCard label="Rejected" value={count(rejected.length)} icon={XCircle} />
        <StatCard
          label="Raised by me — waiting on someone else"
          value={count(myActive.length)}
          icon={ClipboardCheck}
        />
      </div>

      {canApprove ? <AuthorityPanel /> : null}

      <SectionCard
        title="Approval inbox"
        description="Only the currently active level reaches an approver. Anything you raised yourself never appears here — it waits on an independent approver, even where your role holds approval authority."
      >
        <Tabs defaultValue="pending">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="pending">Pending ({count(inbox.length)})</TabsTrigger>
            <TabsTrigger value="mine">My requests ({count(mine.length)})</TabsTrigger>
            <TabsTrigger value="returned">Returned ({count(returned.length)})</TabsTrigger>
            <TabsTrigger value="execution">
              Awaiting execution ({count(awaitingExecution.length)})
            </TabsTrigger>
            <TabsTrigger value="failed">Execution failed ({count(failed.length)})</TabsTrigger>
            <TabsTrigger value="completed">Completed ({count(completed.length)})</TabsTrigger>
            <TabsTrigger value="rejected">Rejected ({count(rejected.length)})</TabsTrigger>
            <TabsTrigger value="cancelled">Cancelled ({count(cancelled.length)})</TabsTrigger>
          </TabsList>
          <TabsContent value="pending" className="pt-4">
            {list(inbox, true, "No request is currently waiting on your decision.")}
          </TabsContent>
          <TabsContent value="mine" className="space-y-6 pt-4">
            <MyGroup
              title="Awaiting approval"
              items={mine.filter((r) => r.status === "pending_approval")}
              render={list}
            />
            <MyGroup
              title="Approved — awaiting execution"
              items={mine.filter((r) =>
                ["approved_pending_execution", "executing"].includes(r.status),
              )}
              render={list}
            />
            <MyGroup
              title="Execution failed"
              items={mine.filter((r) => r.status === "execution_failed")}
              render={list}
            />
            <MyGroup
              title="Completed"
              items={mine.filter((r) => r.status === "completed")}
              render={list}
            />
            <MyGroup
              title="Rejected"
              items={mine.filter((r) => r.status === "rejected")}
              render={list}
            />
            <MyGroup
              title="Cancelled"
              items={mine.filter((r) => r.status === "cancelled")}
              render={list}
            />
          </TabsContent>
          <TabsContent value="returned" className="pt-4">
            {list(returned, false, "Nothing has been returned for correction.")}
          </TabsContent>
          <TabsContent value="execution" className="pt-4">
            {list(awaitingExecution, false)}
          </TabsContent>
          <TabsContent value="failed" className="pt-4">
            {list(failed, false)}
          </TabsContent>
          <TabsContent value="completed" className="pt-4">
            {list(completed, false)}
          </TabsContent>
          <TabsContent value="rejected" className="pt-4">
            {list(rejected, false)}
          </TabsContent>
          <TabsContent value="cancelled" className="pt-4">
            {list(cancelled, false)}
          </TabsContent>
        </Tabs>
      </SectionCard>

      <RaiseRequestDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (payload) => {
          if (!organizationId || !user) return;
          const { data: ref } = await guardedRpc(supabase, "next_document_number", {
            _doc_type: "approval",
          });
          const { error } = await supabase.from("approval_requests").insert({
            organization_id: organizationId,
            requester_id: user.id,
            reference: (ref as string) ?? "",
            status: "pending_approval",
            ...payload,
          });
          if (error) throw error;
          refresh();
        }}
      />
    </div>
  );
}

/** The caller's configured limits, resolved server-side. Read-only here. */
function AuthorityPanel() {
  const authority = useMyApprovalAuthority();
  const rows = authority.data ?? [];
  return (
    <SectionCard
      className="mb-6"
      title="My approval authority"
      description="Limits are configured by the Owner or System Administrator. Anything above a limit is escalated automatically."
    >
      {authority.isLoading ? (
        <LoadingState rows={2} />
      ) : rows.length === 0 ? (
        <EmptyState
          inline
          title="No approval limits configured"
          description="No approval limits are configured for you yet."
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((a) => (
            <li key={`${a.approval_type}-${a.level}`} className="surface-panel p-3">
              <p className="text-sm font-medium">
                {TYPES.find((t) => t.key === a.approval_type)?.name ?? a.approval_type}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Level {a.level} · {describeAuthority(a)}
                {a.escalate_above_limit ? " · escalates above limit" : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function MyGroup({
  title,
  items,
  render,
}: {
  title: string;
  items: ApprovalRequest[];
  render: (items: ApprovalRequest[], showActions: boolean, emptyText?: string) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title} ({items.length})
      </p>
      {render(items, false)}
    </div>
  );
}

function ApprovalRow({
  request,
  requester,
  nameOf,
  canAct,
  onDecide,
  onRetry,
}: {
  request: ApprovalRequest;
  requester: string;
  nameOf: (id: string | null) => string;
  canAct: boolean;
  onDecide: (action: Decision, comment: string) => void;
  onRetry?: (() => void) | undefined;
}) {
  const [comment, setComment] = useState("");
  const tone =
    request.status === "completed"
      ? "success"
      : request.status === "rejected" || request.status === "execution_failed"
        ? "destructive"
        : request.status === "cancelled"
          ? "default"
          : "warning";
  const step = activeStep(request);
  const steps = [...(request.approval_steps ?? [])].sort((a, b) => a.level - b.level);

  return (
    <li className="surface-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">
              {TYPES.find((t) => t.key === request.approval_type)?.name ?? request.approval_type}
            </p>
            <StatusPill tone={tone}>{STATUS_LABEL[request.status] ?? request.status}</StatusPill>
            {request.escalated_to_owner ? (
              <StatusPill tone="warning">Escalated to Owner</StatusPill>
            ) : null}
            {request.status === "pending_approval" && step ? (
              <StatusPill tone="info">
                Level {step.level} of {request.max_level}
              </StatusPill>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {request.reason || "No reason given"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {request.reference ? `${request.reference} · ` : ""}
            {requester} · {new Date(request.created_at).toLocaleString()}
            {request.amount !== null ? ` · amount ${request.amount.toLocaleString()}` : ""}
            {request.requested_percent !== null ? ` · ${request.requested_percent}%` : ""}
          </p>
          {steps.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
              {steps.map((s) => (
                <li key={s.id}>
                  Level {s.level}: <span className="font-medium">{s.status}</span>
                  {s.decided_at
                    ? ` · ${nameOf(s.decided_by)} · ${new Date(s.decided_at).toLocaleString()}`
                    : ""}
                  {s.comment ? ` · “${s.comment}”` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {request.status === "execution_failed" ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="size-3.5" />{" "}
              {request.execution_error || "The authorised action failed."}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          {canAct ? (
            <>
              <Input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Decision comment"
                className="h-8 w-56"
                aria-label="Decision comment"
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => onDecide("returned", comment)}>
                  Return for correction
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDecide("escalated", comment)}>
                  Escalate to Owner
                </Button>
                <Button size="sm" variant="outline" onClick={() => onDecide("rejected", comment)}>
                  Reject
                </Button>
                <Button size="sm" onClick={() => onDecide("approved", comment)}>
                  Approve
                </Button>
              </div>
            </>
          ) : null}
          {request.status === "execution_failed" && onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RotateCcw className="size-4" /> Retry action
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function RaiseRequestDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate: (payload: {
    approval_type: string;
    reason: string;
    amount: number | null;
    max_level: number;
  }) => Promise<void>;
}) {
  const [type, setType] = useState("void");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [levels, setLevels] = useState("1");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      toast.error("A reason is mandatory for every approval request.");
      return;
    }
    try {
      await onCreate({
        approval_type: type,
        reason,
        amount: amount ? Number(amount) : null,
        max_level: Number(levels),
      });
      toast.success("Request submitted");
      onOpenChange(false);
      setReason("");
      setAmount("");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Raise approval request</DialogTitle>
          <DialogDescription>
            A reason is mandatory and is stored in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reason">Reason</Label>
            <Textarea
              id="reason"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="amount">Amount (optional)</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Approval levels</Label>
              <Select value={levels} onValueChange={setLevels}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Single level</SelectItem>
                  <SelectItem value="2">Two levels</SelectItem>
                  <SelectItem value="3">Three levels</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Submit request</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
