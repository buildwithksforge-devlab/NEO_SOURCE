import { useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  referenceFor,
  titleCase,
  useCustomers,
  useInvalidateCrm,
  useLoyaltyAccounts,
  useLoyaltyProgram,
} from "@/lib/crm";

export const Route = createFileRoute("/_shell/crm/loyalty")({
  head: () => ({
    meta: [
      { title: "Loyalty & Rewards — Guest CRM" },
      {
        name: "description",
        content:
          "Configurable loyalty programme, tiers, member accounts and an immutable points ledger with approval-controlled adjustments.",
      },
      { property: "og:title", content: "Loyalty & Rewards — Guest CRM" },
      { property: "og:description", content: "Hospitality loyalty programme and points ledger." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

const DEFAULT_TIERS = [
  { name: "Member", threshold_points: 0, sort_order: 1 },
  { name: "Silver", threshold_points: 2500, sort_order: 2 },
  { name: "Gold", threshold_points: 10000, sort_order: 3 },
  { name: "Platinum", threshold_points: 25000, sort_order: 4 },
];

function Page() {
  const { profile, user, isAdmin, can } = useAuth();
  const invalidate = useInvalidateCrm();
  const program = useLoyaltyProgram();
  const accounts = useLoyaltyAccounts();
  const customers = useCustomers();

  const [programName, setProgramName] = useState("Guest Rewards");
  const [enrolId, setEnrolId] = useState("");
  const [ledger, setLedger] = useState({ accountId: "", type: "earn", points: "", reason: "" });

  const canManage = can("crm-loyalty", "edit");
  const canAdjust = can("crm-loyalty", "override");
  const prog = program.data as {
    id: string;
    name: string;
    loyalty_tiers?: { id: string; name: string; threshold_points: number }[];
  } | null;

  async function createProgram() {
    if (!profile?.organization_id) return;
    const { data, error } = await supabase
      .from("loyalty_programs")
      .insert({
        organization_id: profile.organization_id,
        name: programName || "Guest Rewards",
        description: "Configurable hospitality loyalty programme.",
        created_by: user?.id ?? null,
      })
      .select("id")
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    await supabase.from("loyalty_tiers").insert(
      DEFAULT_TIERS.map((t) => ({
        organization_id: profile.organization_id,
        program_id: data.id,
        ...t,
      })),
    );
    void program.refetch();
    toast.success("Loyalty programme created — tiers and rules are fully editable");
  }

  async function enrol() {
    if (!profile?.organization_id || !prog || !enrolId) return;
    const { error } = await supabase.from("loyalty_accounts").insert({
      organization_id: profile.organization_id,
      customer_id: enrolId,
      program_id: prog.id,
      membership_number: referenceFor("LOY"),
      created_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.loyalty.enrol",
      module: "crm-loyalty",
      recordId: enrolId,
    });
    setEnrolId("");
    void accounts.refetch();
    invalidate();
    toast.success("Customer enrolled — starting balance is zero, no points were fabricated");
  }

  async function postLedger() {
    if (!profile?.organization_id || !ledger.accountId) return;
    const points = Number(ledger.points);
    if (!Number.isFinite(points) || points <= 0) {
      toast.error("Points must be greater than zero");
      return;
    }
    const row = (accounts.data ?? []).find(
      (a) => (a as unknown as { id: string }).id === ledger.accountId,
    ) as unknown as { id: string; customer_id: string } | undefined;
    if (!row) return;

    if (ledger.type === "adjust" && !canAdjust) {
      toast.error("Manual adjustments require the loyalty adjustment permission");
      return;
    }

    const { error } = await supabase.from("loyalty_transactions").insert({
      organization_id: profile.organization_id,
      account_id: row.id,
      customer_id: row.customer_id,
      transaction_type: ledger.type,
      points,
      source_module: "crm",
      source_reference: referenceFor("LTX"),
      reason: ledger.reason,
      created_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: `crm.loyalty.${ledger.type}`,
      module: "crm-loyalty",
      recordId: row.customer_id,
      newValue: { points, reason: ledger.reason },
    });
    setLedger({ accountId: "", type: "earn", points: "", reason: "" });
    void accounts.refetch();
    toast.success("Ledger entry posted");
  }

  return (
    <div>
      <PageHeader
        eyebrow="Guest CRM"
        title="Loyalty & Rewards"
        description="Points always move through the ledger — balances are never edited directly, and negative balances are blocked by the database."
      />

      {program.isLoading ? (
        <LoadingState variant="cards" rows={3} />
      ) : !prog ? (
        <SectionCard
          title="No loyalty programme configured"
          description="Create a programme to unlock enrolment, tiers and the points ledger. Every rule stays configurable."
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={programName} onChange={(e) => setProgramName(e.target.value)} />
            <Button onClick={createProgram} disabled={!canManage}>
              Create programme
            </Button>
          </div>
        </SectionCard>
      ) : (
        <div className="space-y-6">
          <SectionCard title={prog.name} description="Configurable tiers">
            <div className="flex flex-wrap gap-2">
              {(prog.loyalty_tiers ?? []).map((t) => (
                <StatusPill key={t.id} tone="info">
                  {t.name} · {t.threshold_points} pts
                </StatusPill>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="Enrol a customer">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={enrolId} onValueChange={setEnrolId}>
                <SelectTrigger className="sm:w-80">
                  <SelectValue placeholder="Select customer" />
                </SelectTrigger>
                <SelectContent>
                  {(customers.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.full_name} · {c.customer_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={enrol} disabled={!enrolId || !canManage}>
                Enrol
              </Button>
            </div>
          </SectionCard>

          <SectionCard
            title="Post a ledger entry"
            description="Earn, redeem, expire, adjust or reverse. Redemption beyond the available balance is rejected by the database."
          >
            <div className="grid gap-3 md:grid-cols-5">
              <Select
                value={ledger.accountId}
                onValueChange={(v) => setLedger({ ...ledger, accountId: v })}
              >
                <SelectTrigger className="md:col-span-2">
                  <SelectValue placeholder="Member" />
                </SelectTrigger>
                <SelectContent>
                  {(accounts.data ?? []).map((a) => {
                    const row = a as unknown as {
                      id: string;
                      membership_number: string;
                      customers: { full_name: string } | null;
                    };
                    return (
                      <SelectItem key={row.id} value={row.id}>
                        {row.customers?.full_name ?? row.membership_number}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Select value={ledger.type} onValueChange={(v) => setLedger({ ...ledger, type: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["earn", "redeem", "expire", "adjust", "reverse"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {titleCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                placeholder="Points"
                value={ledger.points}
                onChange={(e) => setLedger({ ...ledger, points: e.target.value })}
              />
              <Button onClick={postLedger} disabled={!ledger.accountId}>
                Post entry
              </Button>
            </div>
            <div className="mt-3 space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Reason
              </Label>
              <Input
                value={ledger.reason}
                onChange={(e) => setLedger({ ...ledger, reason: e.target.value })}
                placeholder="Recorded on the ledger entry and in the audit trail"
              />
            </div>
          </SectionCard>

          <SectionCard title="Members">
            {!accounts.data?.length ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No members enrolled yet.
              </p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {accounts.data.map((a) => {
                  const row = a as unknown as {
                    id: string;
                    membership_number: string;
                    points_available: number;
                    status: string;
                    customers: { full_name: string } | null;
                  };
                  return (
                    <li key={row.id} className="flex items-center justify-between py-2">
                      <div>
                        <p className="font-medium">{row.customers?.full_name ?? "Customer"}</p>
                        <p className="text-xs text-muted-foreground">{row.membership_number}</p>
                      </div>
                      <StatusPill tone="success">{row.points_available} pts</StatusPill>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/crm/loyalty">
      <Page />
    </OpsGuard>
  );
}
