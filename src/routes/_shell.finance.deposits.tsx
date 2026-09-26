/**
 * Deposit reconciliation and deposit policy.
 *
 * The register shows each guest's deposit against the amount required for the
 * stay, what remains outstanding, and the Finance posting and journal the
 * deposit produced. The policy tab is where a property states once how the
 * required amount is calculated, so the desk and the gate read the same rule.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  FinStatus,
  financeHead,
} from "@/components/finance/FinanceShared";
import { money, shortDate } from "@/lib/finance";
import { useAuth } from "@/lib/auth";
import { useBranches } from "@/lib/branches";
import { useRatePlans } from "@/lib/pms-data";
import {
  describePolicy,
  useDeleteDepositPolicy,
  useDepositPolicies,
  useDepositReconciliation,
  usePostDeposit,
  useSaveDepositPolicy,
  type DepositBasis,
} from "@/lib/deposit-policies";


export const Route = createFileRoute("/_shell/finance/deposits")({
  head: financeHead(
    "Deposit Reconciliation",
    "Guest pre-arrival deposits, outstanding balances, Finance posting status and the journal each deposit produced.",
  ),
  component: () => (
    <FinanceGuard feature="reconciliation" action="view">
      <DepositsPage />
    </FinanceGuard>
  ),
});

function DepositsPage() {
  const rows = useDepositReconciliation();
  const postDeposit = usePostDeposit();
  const data = useMemo(() => rows.data ?? [], [rows.data]);

  const outstanding = data.reduce((s, r) => s + r.outstanding_amount, 0);
  const held = data.filter((r) => r.deposit_status === "held");
  const unposted = data.filter((r) => !r.journal_id);

  const lead: SummaryFigure = {
    id: "held",
    label: "Deposits held",
    value: rows.isLoading ? "…" : money(held.reduce((s, r) => s + r.amount, 0)),
    hint: "Guest money held as a liability, not revenue",
  };
  const figures: SummaryFigure[] = [
    { id: "count", label: "Deposits", value: rows.isLoading ? "…" : data.length },
    {
      id: "outstanding",
      label: "Still outstanding",
      value: rows.isLoading ? "…" : money(outstanding),
      tone: outstanding > 0 ? "warning" : "success",
    },
    {
      id: "applied",
      label: "Applied to folios",
      value: rows.isLoading ? "…" : data.filter((r) => r.applied_folio_id).length,
    },
    {
      id: "unposted",
      label: "Awaiting journal",
      value: rows.isLoading ? "…" : unposted.length,
      tone: unposted.length ? "warning" : "success",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deposit reconciliation"
        description="Each guest deposit, what remains outstanding against the stay, and the Finance posting and journal line it produced."
      />
      <SummaryStrip lead={lead} figures={figures} />

      <Tabs defaultValue="register">
        <TabsList>
          <TabsTrigger value="register">Deposit register</TabsTrigger>
          <TabsTrigger value="policy">Deposit policy</TabsTrigger>
        </TabsList>

        <TabsContent value="register" className="pt-4">
          <div className="rounded-xl border border-border/70 bg-card p-4">
            <FinanceQueryState
              isLoading={rows.isLoading}
              error={rows.error}
              isEmpty={data.length === 0}
              empty={
                <FinanceEmpty
                  title="No deposits recorded"
                  description="Pre-arrival deposits recorded against a reservation appear here with their posting and journal."
                />
              }
            >
              <DataTable
                unit="deposits"
                head={[
                  "Guest",
                  "Reservation",
                  "Arrival",
                  "Deposit",
                  "Required",
                  "Paid",
                  "Outstanding",
                  "Status",
                  "Folio",
                  "Posting",
                  "Journal",
                  "Debit",
                  "Credit",
                  "",
                ]}
              >

                {data.map((r) => (
                  <tr key={r.deposit_id} className="align-middle">
                    <td className="py-2 pr-4">
                      <div className="font-medium">{r.guest_name}</div>
                      <div className="text-xs text-muted-foreground">{r.property ?? "—"}</div>
                    </td>
                    <td className="py-2 pr-4">
                      {r.reservation_id ? (
                        <Link
                          to="/pms/reservations/$id"
                          params={{ id: r.reservation_id }}
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          {r.confirmation_number ?? "Reservation"}
                        </Link>
                      ) : (
                        (r.confirmation_number ?? "—")
                      )}
                    </td>
                    <td className="py-2 pr-4">{shortDate(r.arrival_date)}</td>
                    <td className="py-2 pr-4">{money(r.amount)}</td>
                    <td className="py-2 pr-4">{money(r.required_amount)}</td>
                    <td className="py-2 pr-4">{money(r.paid_amount)}</td>
                    <td className="py-2 pr-4">
                      {r.outstanding_amount > 0.009 ? (
                        <span className="font-medium text-warning">
                          {money(r.outstanding_amount)}
                        </span>
                      ) : (
                        "Settled"
                      )}
                    </td>
                    <td className="py-2 pr-4"><FinStatus value={r.deposit_status} /></td>
                    <td className="py-2 pr-4">
                      {r.applied_folio_id ? (
                        <Link
                          to="/pms/folios/$id"
                          params={{ id: r.applied_folio_id }}
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          Folio
                        </Link>
                      ) : (
                        "Not applied"
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {r.posting_status ? (
                        <FinStatus value={r.posting_status} />
                      ) : (
                        <span className="text-muted-foreground">Not queued</span>
                      )}
                      {r.posting_error ? (
                        <div className="text-xs text-destructive">{r.posting_error}</div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4">{r.journal_number ?? "—"}</td>
                    <td className="py-2 pr-4">{r.journal_id ? money(r.journal_debit) : "—"}</td>
                    <td className="py-2 pr-4">{r.journal_id ? money(r.journal_credit) : "—"}</td>
                    <td className="py-2 pr-4 text-right">
                      {r.journal_id ? null : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={postDeposit.isPending}
                          onClick={() => postDeposit.mutate(r.deposit_id)}
                        >
                          {r.posting_status === "failed" ? "Retry posting" : "Post to Finance"}
                        </Button>
                      )}
                    </td>
                  </tr>

                ))}
              </DataTable>
            </FinanceQueryState>
          </div>
        </TabsContent>

        <TabsContent value="policy" className="pt-4">
          <PolicyTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const BASES: DepositBasis[] = ["percentage", "flat", "nights"];

function PolicyTab() {
  const { can, isAdmin } = useAuth();
  const mayEdit = isAdmin || can("finance", "edit") || can("pms", "edit");
  const policies = useDepositPolicies();
  const branches = useBranches();
  const ratePlans = useRatePlans();
  const save = useSaveDepositPolicy();
  const remove = useDeleteDepositPolicy();

  const planName = (id: string | null) =>
    id
      ? (String(
          (ratePlans.data ?? []).find((p) => String(p["id"]) === id)?.["name"] ?? "Rate plan",
        ))
      : "Any rate";

  const blank = {
    id: "",
    name: "",
    branch_id: "all",
    rate_plan_id: "any",
    basis: "percentage" as DepositBasis,
    value: "30",
    minimum_amount: "0",
    reason: "Standard pre-arrival deposit",
    priority: "100",
    active: true,
  };

  const [form, setForm] = useState(blank);

  const reset = () => setForm(blank);


  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="rounded-xl border border-border/70 bg-card p-4">
        <FinanceQueryState
          isLoading={policies.isLoading}
          error={policies.error}
          isEmpty={(policies.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title="No deposit policy configured"
              description="Without a policy, a reservation only requires a deposit when one is entered by hand."
            />
          }
        >
          <DataTable
            unit="policies"
            head={[
              "Policy",
              "Property",
              "Rate plan",
              "Calculation",
              "Reason",
              "Priority",
              "Active",
              "",
            ]}
          >
            {(policies.data ?? []).map((p) => (
              <tr key={p.id} className="align-middle">
                <td className="py-2 pr-4 font-medium">{p.name}</td>
                <td className="py-2 pr-4">
                  {p.branch_id
                    ? ((branches.data ?? []).find((b) => b.id === p.branch_id)?.name ??
                      "Property")
                    : "All properties"}
                </td>
                <td className="py-2 pr-4">{planName(p.rate_plan_id)}</td>
                <td className="py-2 pr-4">{describePolicy(p)}</td>

                <td className="py-2 pr-4 text-xs text-muted-foreground">{p.reason}</td>
                <td className="py-2 pr-4">{p.priority}</td>
                <td className="py-2 pr-4">{p.active ? "Active" : "Inactive"}</td>
                <td className="py-2 pr-4 text-right">
                  {mayEdit ? (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setForm({
                            id: p.id,
                            name: p.name,
                            branch_id: p.branch_id ?? "all",
                            rate_plan_id: p.rate_plan_id ?? "any",

                            basis: p.basis,
                            value: String(p.value),
                            minimum_amount: String(p.minimum_amount),
                            reason: p.reason,
                            priority: String(p.priority),
                            active: p.active,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => remove.mutate(p.id)}
                        disabled={remove.isPending}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </div>

      {mayEdit ? (
        <form
          className="space-y-3 rounded-xl border border-border/70 bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              {
                ...(form.id ? { id: form.id } : {}),
                name: form.name.trim(),
                branch_id: form.branch_id === "all" ? null : form.branch_id,
                rate_plan_id: form.rate_plan_id === "any" ? null : form.rate_plan_id,

                basis: form.basis,
                value: Number(form.value),
                minimum_amount: Number(form.minimum_amount),
                reason: form.reason.trim(),
                priority: Number(form.priority),
                active: form.active,
              },
              { onSuccess: reset },
            );
          }}
        >
          <p className="text-sm font-semibold">{form.id ? "Edit policy" : "New deposit policy"}</p>
          <div className="space-y-1">
            <Label htmlFor="policy-name">Policy name</Label>
            <Input
              id="policy-name"
              value={form.name}
              required
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label>Property</Label>
            <Select
              value={form.branch_id}
              onValueChange={(v) => setForm((f) => ({ ...f, branch_id: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All properties</SelectItem>
                {(branches.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Room rate plan</Label>
            <Select
              value={form.rate_plan_id}
              onValueChange={(v) => setForm((f) => ({ ...f, rate_plan_id: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any rate plan</SelectItem>
                {(ratePlans.data ?? []).map((p) => (
                  <SelectItem key={String(p["id"])} value={String(p["id"])}>
                    {String(p["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              A rate-plan policy wins over a property policy, so a room&apos;s deposit follows the
              rate it is sold on.
            </p>
          </div>
          <div className="space-y-1">

            <Label>Basis</Label>
            <Select
              value={form.basis}
              onValueChange={(v) => setForm((f) => ({ ...f, basis: v as DepositBasis }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASES.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b === "percentage"
                      ? "Percentage of stay value"
                      : b === "nights"
                        ? "Number of nights"
                        : "Flat amount"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="policy-value">Value</Label>
              <Input
                id="policy-value"
                type="number"
                step="0.01"
                value={form.value}
                onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="policy-min">Minimum</Label>
              <Input
                id="policy-min"
                type="number"
                step="0.01"
                value={form.minimum_amount}
                onChange={(e) => setForm((f) => ({ ...f, minimum_amount: e.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="policy-reason">Policy reason shown to the guest and desk</Label>
            <Input
              id="policy-reason"
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="policy-priority">Priority</Label>
              <Input
                id="policy-priority"
                type="number"
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch
                id="policy-active"
                checked={form.active}
                onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))}
              />
              <Label htmlFor="policy-active">Active</Label>
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending || !form.name.trim()}>
              {form.id ? "Save policy" : "Create policy"}
            </Button>
            {form.id ? (
              <Button type="button" variant="ghost" onClick={reset}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
