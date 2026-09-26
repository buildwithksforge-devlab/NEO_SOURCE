import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { Gift, Percent, Receipt, TrendingDown } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { NeoDateRangePicker } from "@/components/common/DatePicker";
import { QueryState } from "@/components/pms/PmsShared";
import { Button } from "@/components/ui/button";
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
import { useTenant } from "@/lib/tenant";
import { useAuth } from "@/lib/auth";
import { useVisibility } from "@/lib/visibility";
import {
  BENEFICIARY_TYPES,
  COMPLIMENTARY_CATEGORIES,
  PRICING_TYPES,
  complimentaryValue,
  formatDateTime,
  lpoStatusTone,
  money,
  num,
  titleCase,
  type Row,
} from "@/lib/procurement";
import {
  useApproveComplimentary,
  useComplimentaryRegister,
  useSaveComplimentary,
} from "@/lib/procurement-data";

export const Route = createFileRoute("/_shell/complimentary")({
  head: () => ({
    meta: [
      { title: "Complimentary & Cost-Price Register — NEØ" },
      {
        name: "description",
        content:
          "Every free, staff and at-cost item recorded with its selling price, real cost and authorising manager.",
      },
      { property: "og:title", content: "Complimentary & Cost-Price Register — NEØ" },
      {
        property: "og:description",
        content:
          "Every free, staff and at-cost item recorded with its selling price, real cost and authorising manager.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

const todayIso = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;

function Page() {
  const { tenant } = useTenant();
  const { can } = useAuth();
  const showCost = useVisibility().canSeeCost("production-cost");
  const symbol = tenant.regional.currencySymbol;
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayIso());
  const [pricingType, setPricingType] = useState("all");
  const register = useComplimentaryRegister({ from, to, pricingType });
  const save = useSaveComplimentary();
  const approve = useApproveComplimentary();

  const canApprove = can?.("finance", "approve") ?? false;
  const rows = (register.data ?? []) as Row[];

  const totals = useMemo(() => {
    const givenAway = rows.reduce((s, r) => s + complimentaryValue(r), 0);
    const realCost = rows.reduce((s, r) => s + num(r["actual_cost"]) * num(r["quantity"], 1), 0);
    const charged = rows.reduce((s, r) => s + num(r["amount_charged"]), 0);
    const pending = rows.filter((r) => String(r["status"] ?? "pending") === "pending").length;
    return { givenAway, realCost, charged, pending };
  }, [rows]);

  const [form, setForm] = useState<Row>({
    item_name: "",
    category: "meal",
    pricing_type: "complimentary",
    beneficiary_type: "guest",
    beneficiary_name: "",
    quantity: 1,
    normal_selling_price: 0,
    amount_charged: 0,
    actual_cost: 0,
    reason: "",
  });
  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  const formValid =
    String(form["item_name"]).trim().length > 1 && String(form["reason"]).trim().length > 4;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Revenue Control"
        title="Complimentary & cost-price register"
        description="Free items, staff meals, client at-cost orders and management complimentaries are never invisible — each records its normal selling price, the real ingredient cost, who authorised it and why."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Value given away"
          value={money(totals.givenAway, symbol)}
          hint="Selling price not charged"
          icon={Gift}
          tone="warning"
        />
        {showCost ? (
          <StatCard
            label="Real cost absorbed"
            value={money(totals.realCost, symbol)}
            hint="Ingredient and service cost"
            icon={TrendingDown}
            tone="warning"
          />
        ) : null}
        <StatCard
          label="Amount charged"
          value={money(totals.charged, symbol)}
          hint="Recovered at cost or reduced price"
          icon={Receipt}
        />
        <StatCard
          label="Awaiting approval"
          value={String(totals.pending)}
          hint="Pending manager authorisation"
          icon={Percent}
        />
      </div>

      <SectionCard
        title="Filters"
        description="Narrow the register by period and pricing type, then export."
      >
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <Label className="text-xs">Period</Label>
            <NeoDateRangePicker
              from={from}
              to={to}
              quick={["today", "this-week", "this-month"]}
              onChange={({ from: f, to: t }) => {
                setFrom(f);
                setTo(t);
              }}
            />
          </div>
          <div>
            <Label className="text-xs">Pricing type</Label>
            <Select value={pricingType} onValueChange={setPricingType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {PRICING_TYPES.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => exportCsv(rows, symbol)}
              disabled={rows.length === 0}
            >
              Export CSV
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Record a special-price transaction"
        description="Cost-price and complimentary items need a reason and a manager approval."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Label className="text-xs">Item or service</Label>
            <Input
              value={String(form["item_name"])}
              onChange={(e) => set("item_name", e.target.value)}
              placeholder="e.g. Grilled tilapia"
            />
          </div>
          <div>
            <Label className="text-xs">Category</Label>
            <Select value={String(form["category"])} onValueChange={(v) => set("category", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPLIMENTARY_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Pricing type</Label>
            <Select
              value={String(form["pricing_type"])}
              onValueChange={(v) => set("pricing_type", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRICING_TYPES.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Beneficiary type</Label>
            <Select
              value={String(form["beneficiary_type"])}
              onValueChange={(v) => set("beneficiary_type", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BENEFICIARY_TYPES.map((b) => (
                  <SelectItem key={b} value={b}>
                    {titleCase(b)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Beneficiary name</Label>
            <Input
              value={String(form["beneficiary_name"])}
              onChange={(e) => set("beneficiary_name", e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Quantity</Label>
            <Input
              type="number"
              min={1}
              value={num(form["quantity"], 1)}
              onChange={(e) => set("quantity", Number(e.target.value))}
            />
          </div>
          <div>
            <Label className="text-xs">Normal selling price</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={num(form["normal_selling_price"])}
              onChange={(e) => set("normal_selling_price", Number(e.target.value))}
            />
          </div>
          <div>
            <Label className="text-xs">Amount charged</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={num(form["amount_charged"])}
              onChange={(e) => set("amount_charged", Number(e.target.value))}
            />
          </div>
          <div>
            <Label className="text-xs">Actual cost (per unit)</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={num(form["actual_cost"])}
              onChange={(e) => set("actual_cost", Number(e.target.value))}
            />
          </div>
          <div className="sm:col-span-3">
            <Label className="text-xs">Reason / authorisation note</Label>
            <Textarea
              rows={2}
              value={String(form["reason"])}
              onChange={(e) => set("reason", e.target.value)}
              placeholder="Why is this being given at a special price?"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {`Value given away: ${money(complimentaryValue(form), symbol)} · cost absorbed: ${money(num(form["actual_cost"]) * num(form["quantity"], 1), symbol)}`}
          </p>
          <Button
            disabled={!formValid || save.isPending}
            onClick={() => save.mutate(form, { onSuccess: () => set("item_name", "") })}
          >
            Record entry
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Register"
        description="Complete history — entries are never deleted, only approved or rejected."
      >
        <QueryState
          isLoading={register.isLoading}
          error={register.error}
          isEmpty={rows.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">
              No complimentary or cost-price transactions in this period.
            </p>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2">Item</th>
                  <th>Type</th>
                  <th>Beneficiary</th>
                  <th className="text-right">Selling</th>
                  <th className="text-right">Charged</th>
                  {showCost ? <th className="text-right">Cost</th> : null}
                  <th className="text-right">Given away</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={String(r["id"])}>
                    <td className="py-2">
                      <p className="font-medium">{String(r["item_name"] ?? "Item")}</p>
                      <p className="text-xs text-muted-foreground">{`${titleCase(String(r["category"] ?? ""))} · ${formatDateTime(r["created_at"])}`}</p>
                    </td>
                    <td>{titleCase(String(r["pricing_type"] ?? ""))}</td>
                    <td>{`${String(r["beneficiary_name"] ?? "—")}`}</td>
                    <td className="text-right">{money(r["normal_selling_price"], symbol)}</td>
                    <td className="text-right">{money(r["amount_charged"], symbol)}</td>
                    {showCost ? (
                      <td className="text-right">
                        {money(num(r["actual_cost"]) * num(r["quantity"], 1), symbol)}
                      </td>
                    ) : null}
                    <td className="text-right font-medium">
                      {money(complimentaryValue(r), symbol)}
                    </td>
                    <td>
                      <StatusPill tone={lpoStatusTone(String(r["status"] ?? ""))}>
                        {titleCase(String(r["status"] ?? "pending"))}
                      </StatusPill>
                    </td>
                    <td className="text-right">
                      {canApprove && String(r["status"] ?? "pending") === "pending" ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={approve.isPending}
                            onClick={() => approve.mutate({ id: String(r["id"]), approve: true })}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={approve.isPending}
                            onClick={() => approve.mutate({ id: String(r["id"]), approve: false })}
                          >
                            Reject
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}

function exportCsv(rows: Row[], symbol: string) {
  const head = [
    "Date",
    "Item",
    "Category",
    "Pricing type",
    "Beneficiary",
    "Quantity",
    `Selling (${symbol})`,
    "Charged",
    "Actual cost",
    "Given away",
    "Status",
    "Reason",
  ];
  const body = rows.map((r) => [
    formatDateTime(r["created_at"]),
    r["item_name"] ?? "",
    r["category"] ?? "",
    r["pricing_type"] ?? "",
    r["beneficiary_name"] ?? "",
    num(r["quantity"], 1),
    num(r["normal_selling_price"]),
    num(r["amount_charged"]),
    num(r["actual_cost"]) * num(r["quantity"], 1),
    complimentaryValue(r),
    r["status"] ?? "pending",
    String(r["reason"] ?? "").replace(/"/g, "'"),
  ]);
  const csv = [head, ...body].map((line) => line.map((c) => `"${String(c)}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `complimentary-register-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Every Supply Chain screen writes to stock, money or supplier records, so the
// page itself asks for the capability its route declares — never the shell.
function GuardedPage() {
  return (
    <OpsGuard path="/complimentary">
      <Page />
    </OpsGuard>
  );
}
