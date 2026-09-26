import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  FormDialog,
  RecordForm,
  financeHead,
  type FieldSpec,
} from "@/components/finance/FinanceShared";
import {
  COMPONENT_TYPES,
  DISCOUNT_RULES,
  GUEST_CATEGORIES,
  OCCUPANCY_TYPES,
  PACKAGE_TYPES,
  componentAmount,
  componentLabel,
  isMealComponent,
  money,
  num,
  packageTypeLabel,
  reconcileByCharge,
  ruleBalance,
  titleCase,
  type Row,
} from "@/lib/packages";
import {
  useAllocateCharge,
  useAllocationReport,
  useAllocationRules,
  useAllocations,
  useBranchOptions,
  useDeleteComponent,
  useDepartmentOptions,
  useMealEntitlements,
  useRecalculateAllocations,
  useReverseAllocations,
  useSaveComponent,
  useSaveRule,
  useSetRuleStatus,
  useUpdateEntitlement,
} from "@/lib/packages-data";
import { useAccounts, useCorporateAccounts } from "@/lib/finance-data";
import { useMealPlans, useRatePlans, useRoomTypes } from "@/lib/pms-data";
import { NeoDatePicker } from "@/components/common/DatePicker";

export const Route = createFileRoute("/_shell/finance/packages")({
  head: financeHead(
    "Package Revenue Allocation",
    "Split accommodation package prices between Rooms and Food & Beverage revenue centres without charging the guest twice.",
  ),
  component: () => (
    <FinanceGuard feature="packages" action="view">
      <PackagesPage />
    </FinanceGuard>
  ),
});

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function PackagesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Package Revenue Allocation"
        description="A guest pays one package price. Internally the same amount is split across Rooms, Breakfast, Lunch, Dinner and any other configured component. Allocations must always equal the package selling price and never create an extra guest charge."
      />
      <Tabs defaultValue="configuration">
        <TabsList>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="postings">Postings &amp; Reversals</TabsTrigger>
          <TabsTrigger value="entitlements">Meal Entitlements</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>
        <TabsContent value="configuration" className="mt-6">
          <ConfigurationTab />
        </TabsContent>
        <TabsContent value="postings" className="mt-6">
          <PostingsTab />
        </TabsContent>
        <TabsContent value="entitlements" className="mt-6">
          <EntitlementsTab />
        </TabsContent>
        <TabsContent value="reports" className="mt-6">
          <ReportsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ----------------------------- configuration ----------------------------- */

function ConfigurationTab() {
  const rules = useAllocationRules();
  const roomTypes = useRoomTypes();
  const ratePlans = useRatePlans();
  const mealPlans = useMealPlans();
  const corporates = useCorporateAccounts();
  const branches = useBranchOptions();
  const saveRule = useSaveRule();
  const setStatus = useSetRuleStatus();
  const [expanded, setExpanded] = useState<string | null>(null);

  const options = (list: Row[] | undefined, labelKey: string) =>
    (list ?? []).map((r) => ({ value: String(r["id"]), label: String(r[labelKey] ?? "—") }));

  const fields: FieldSpec[] = [
    {
      name: "name",
      label: "Rule name",
      required: true,
      placeholder: "Bed & Breakfast — Deluxe, high season",
    },
    {
      name: "package_type",
      label: "Package type",
      type: "select",
      required: true,
      options: PACKAGE_TYPES.map((p) => ({ value: p.value, label: p.label })),
    },
    { name: "package_price", label: "Package selling price", type: "number", required: true },
    {
      name: "allocation_method",
      label: "Allocation method",
      type: "select",
      options: [
        { value: "fixed", label: "Fixed amounts" },
        { value: "percentage", label: "Percentage of package price" },
      ],
    },
    {
      name: "branch_id",
      label: "Branch / property (optional)",
      type: "select",
      options: options(branches.data, "name"),
    },
    {
      name: "room_type_id",
      label: "Room type (optional)",
      type: "select",
      options: options(roomTypes.data, "name"),
    },
    {
      name: "rate_plan_id",
      label: "Rate plan (optional)",
      type: "select",
      options: options(ratePlans.data, "name"),
    },
    {
      name: "meal_plan_id",
      label: "Meal plan (optional)",
      type: "select",
      options: options(mealPlans.data, "name"),
    },
    {
      name: "corporate_account_id",
      label: "Corporate contract (optional)",
      type: "select",
      options: options(corporates.data, "legal_name"),
    },
    {
      name: "occupancy_type",
      label: "Occupancy",
      type: "select",
      options: OCCUPANCY_TYPES.map((o) => ({ value: o, label: titleCase(o) })),
    },
    {
      name: "guest_category",
      label: "Guest category",
      type: "select",
      options: GUEST_CATEGORIES.map((g) => ({ value: g, label: titleCase(g) })),
    },
    { name: "season_label", label: "Season label", placeholder: "High season" },
    { name: "valid_from", label: "Valid from", type: "date" },
    { name: "valid_to", label: "Valid to", type: "date" },
    {
      name: "discount_rule",
      label: "Discount treatment",
      type: "select",
      options: DISCOUNT_RULES.map((d) => ({ value: d.value, label: d.label })),
    },
    { name: "priority", label: "Priority (lower wins)", type: "number" },
    { name: "notes", label: "Notes", type: "textarea", span: true },
  ];

  return (
    <div className="space-y-6">
      <SectionCard
        title={`${(rules.data ?? []).length} allocation rule(s)`}
        description="Configure the internal split for each room type, occupancy, meal plan, rate plan, corporate contract, branch and season. Every hotel sets its own amounts."
        actions={
          <FormDialog
            title="New allocation rule"
            description="Define the package and the scope it applies to. Add components next, then activate the rule."
          >
            {(close) => (
              <RecordForm
                fields={fields}
                initial={{
                  package_type: "bed-breakfast",
                  allocation_method: "fixed",
                  occupancy_type: "any",
                  guest_category: "any",
                  discount_rule: "proportional",
                  priority: 100,
                }}
                submitLabel="Create rule"
                busy={saveRule.isPending}
                onSubmit={(values) => {
                  const payload: Row = { ...values, status: "draft" };
                  for (const key of [
                    "branch_id",
                    "room_type_id",
                    "rate_plan_id",
                    "meal_plan_id",
                    "corporate_account_id",
                    "valid_from",
                    "valid_to",
                  ]) {
                    if (!payload[key]) payload[key] = null;
                  }
                  saveRule.mutate({ values: payload }, { onSuccess: close });
                }}
              />
            )}
          </FormDialog>
        }
      >
        <FinanceQueryState
          isLoading={rules.isLoading}
          error={rules.error}
          isEmpty={(rules.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title="No allocation rules yet"
              description="Create a rule for each package you sell — Room Only, Bed and Breakfast, Half Board, Full Board or a custom package."
            />
          }
        >
          <div className="space-y-3">
            {(rules.data ?? []).map((rule) => {
              const id = String(rule["id"]);
              const components = ((rule["package_allocation_components"] as Row[]) ?? [])
                .slice()
                .sort((a, b) => num(a["sort_order"]) - num(b["sort_order"]));
              const balance = ruleBalance(rule, components);
              return (
                <div key={id} className="rounded-xl border border-border">
                  <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="font-medium">{String(rule["name"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {packageTypeLabel(String(rule["package_type"]))} ·{" "}
                        {money(rule["package_price"], String(rule["currency"] ?? "KES"))} ·{" "}
                        {titleCase(String(rule["allocation_method"]))} ·{" "}
                        {titleCase(String(rule["occupancy_type"]))}
                        {rule["season_label"] ? ` · ${String(rule["season_label"])}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={balance.balanced ? "success" : "warning"}>
                        {balance.balanced
                          ? "Balanced"
                          : `Variance ${money(balance.variance, String(rule["currency"] ?? "KES"))}`}
                      </StatusPill>
                      <StatusPill tone={rule["status"] === "active" ? "success" : "default"}>
                        {titleCase(String(rule["status"]))}
                      </StatusPill>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExpanded(expanded === id ? null : id)}
                      >
                        {expanded === id ? "Hide components" : "Components"}
                      </Button>
                      <Button
                        size="sm"
                        variant={rule["status"] === "active" ? "outline" : "default"}
                        disabled={
                          setStatus.isPending || (rule["status"] !== "active" && !balance.balanced)
                        }
                        onClick={() =>
                          setStatus.mutate({
                            id,
                            status: rule["status"] === "active" ? "inactive" : "active",
                          })
                        }
                      >
                        {rule["status"] === "active" ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  </div>
                  {expanded === id ? <ComponentEditor rule={rule} components={components} /> : null}
                </div>
              );
            })}
          </div>
        </FinanceQueryState>
      </SectionCard>
    </div>
  );
}

function ComponentEditor({ rule, components }: { rule: Row; components: Row[] }) {
  const departments = useDepartmentOptions();
  const accounts = useAccounts();
  const save = useSaveComponent();
  const remove = useDeleteComponent();
  const price = num(rule["package_price"]);
  const currency = String(rule["currency"] ?? "KES");
  const balance = ruleBalance(rule, components);

  const fields: FieldSpec[] = [
    {
      name: "component_type",
      label: "Component",
      type: "select",
      required: true,
      options: COMPONENT_TYPES.map((c) => ({ value: c.value, label: c.label })),
    },
    {
      name: "label",
      label: "Label on internal reports",
      required: true,
      placeholder: "Breakfast revenue",
    },
    {
      name: "department_id",
      label: "Department",
      type: "select",
      options: (departments.data ?? []).map((d) => ({
        value: String(d["id"]),
        label: String(d["name"]),
      })),
    },
    { name: "revenue_centre", label: "Revenue centre", placeholder: "Main restaurant" },
    {
      name: "gl_account_id",
      label: "Revenue account",
      type: "select",
      options: (accounts.data ?? [])
        .filter((a) => a["category"] === "revenue")
        .map((a) => ({
          value: String(a["id"]),
          label: `${String(a["code"])} — ${String(a["name"])}`,
        })),
    },
    {
      name: "method",
      label: "Method",
      type: "select",
      options: [
        { value: "fixed", label: "Fixed amount" },
        { value: "percentage", label: "Percentage of package price" },
      ],
    },
    { name: "amount", label: "Fixed amount", type: "number" },
    { name: "percentage", label: "Percentage", type: "number" },
    {
      name: "tax_treatment",
      label: "Tax treatment",
      type: "select",
      options: [
        { value: "inclusive", label: "Tax inclusive" },
        { value: "exclusive", label: "Tax exclusive" },
        { value: "exempt", label: "Exempt" },
      ],
    },
    { name: "meal_period", label: "Meal period (entitlements)", placeholder: "breakfast" },
    { name: "creates_entitlement", label: "Create a meal entitlement", type: "checkbox" },
    { name: "sort_order", label: "Sort order", type: "number" },
  ];

  return (
    <div className="space-y-4 border-t border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Allocated {money(balance.allocated, currency)} of {money(price, currency)}
          {balance.balanced
            ? " — allocations tie back exactly."
            : " — the rule cannot be activated until this balances."}
        </p>
        <FormDialog
          title="Add component"
          description="Each component names the department, revenue centre and general ledger account that earns its share."
        >
          {(close) => (
            <RecordForm
              fields={fields}
              initial={{
                method: String(rule["allocation_method"] ?? "fixed"),
                tax_treatment: String(rule["tax_treatment"] ?? "inclusive"),
                sort_order: components.length,
              }}
              submitLabel="Add component"
              busy={save.isPending}
              onSubmit={(values) => {
                const payload: Row = { ...values, rule_id: rule["id"] };
                if (!payload["department_id"]) payload["department_id"] = null;
                if (!payload["gl_account_id"]) payload["gl_account_id"] = null;
                if (!payload["meal_period"])
                  payload["meal_period"] = isMealComponent(String(values["component_type"]))
                    ? String(values["component_type"])
                    : null;
                save.mutate({ values: payload }, { onSuccess: close });
              }}
            />
          )}
        </FormDialog>
      </div>
      {components.length === 0 ? (
        <FinanceEmpty
          title="No components configured"
          description="Add the room portion and each meal portion. Their total must equal the package selling price."
        />
      ) : (
        <DataTable
          head={[
            "Component",
            "Department",
            "Revenue centre",
            "Account",
            "Method",
            "Amount",
            "Entitlement",
            "",
          ]}
        >
          {components.map((c) => (
            <tr key={String(c["id"])}>
              <td className="py-2 pr-4 font-medium">
                {String(c["label"] ?? componentLabel(String(c["component_type"])))}
              </td>
              <td className="py-2 pr-4 text-muted-foreground">
                {String(c["department_id"] ? "Assigned" : "—")}
              </td>
              <td className="py-2 pr-4 text-muted-foreground">
                {String(c["revenue_centre"] ?? "—")}
              </td>
              <td className="py-2 pr-4 text-muted-foreground">
                {c["gl_account_id"] ? "Mapped" : "—"}
              </td>
              <td className="py-2 pr-4">
                {c["method"] === "percentage" ? `${num(c["percentage"])}%` : "Fixed"}
              </td>
              <td className="py-2 pr-4 font-mono text-xs">
                {money(componentAmount(c, price), currency)}
              </td>
              <td className="py-2 pr-4">
                {c["creates_entitlement"] ? String(c["meal_period"] ?? "yes") : "—"}
              </td>
              <td className="py-2 pr-4 text-right">
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(String(c["id"]))}>
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}

/* -------------------------------- postings ------------------------------- */

function PostingsTab() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const allocations = useAllocations({ from, to });
  const reverse = useReverseAllocations();
  const recalc = useRecalculateAllocations();
  const allocate = useAllocateCharge();
  const [reason, setReason] = useState("");
  const [chargeId, setChargeId] = useState("");

  const charges = useMemo(() => reconcileByCharge(allocations.data ?? []), [allocations.data]);
  const unbalanced = charges.filter((c) => !c.balanced);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Package charges allocated" value={String(charges.length)} />
        <StatCard
          label="Total allocated"
          value={money(charges.reduce((s, c) => s + c.allocated, 0))}
        />
        <StatCard label="Unbalanced allocations" value={String(unbalanced.length)} />
      </div>

      <SectionCard
        title="Posted allocations by stay date"
        description="Each guest-facing package charge keeps one folio line. The rows below are the internal departmental split of that same amount."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <NeoDatePicker
              value={from}
              onChange={setFrom}
              className="w-40"
              ariaLabel="From date"
              quick={["today", "this-week", "next-7", "this-month"]}
            />
            <NeoDatePicker
              value={to}
              onChange={setTo}
              className="w-40"
              ariaLabel="To date"
              quick={["today", "this-week", "next-7", "this-month"]}
            />
          </div>
        }
      >
        <FinanceQueryState
          isLoading={allocations.isLoading}
          error={allocations.error}
          isEmpty={charges.length === 0}
          empty={
            <FinanceEmpty
              title="No allocations in this period"
              description="Allocations are created automatically when night audit posts a package charge against an active allocation rule."
            />
          }
        >
          <div className="space-y-4">
            {charges.map((charge) => (
              <div key={charge.line} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">
                      Package charge {money(charge.price)} ·{" "}
                      {String(charge.components[0]?.["stay_date"] ?? "")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {String(
                        (charge.components[0]?.["customers"] as Row | null)?.["full_name"] ??
                          "Guest",
                      )}{" "}
                      ·{" "}
                      {packageTypeLabel(String(charge.components[0]?.["package_type"] ?? "custom"))}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill tone={charge.balanced ? "success" : "warning"}>
                      {charge.balanced ? "Reconciles" : `Variance ${money(charge.variance)}`}
                    </StatusPill>
                    <Button size="sm" variant="ghost" onClick={() => setChargeId(charge.line)}>
                      Adjust
                    </Button>
                  </div>
                </div>
                <div className="mt-3">
                  <DataTable
                    head={["Component", "Department", "Account", "Stay date", "Amount", "Status"]}
                  >
                    {charge.components.map((a) => (
                      <tr key={String(a["id"])}>
                        <td className="py-2 pr-4">
                          {String(
                            a["component_label"] ?? componentLabel(String(a["component_type"])),
                          )}
                        </td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {String((a["departments"] as Row | null)?.["name"] ?? "—")}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                          {String((a["chart_of_accounts"] as Row | null)?.["code"] ?? "—")}
                        </td>
                        <td className="py-2 pr-4">{String(a["stay_date"])}</td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {money(a["allocated_amount"])}
                        </td>
                        <td className="py-2 pr-4">
                          <StatusPill tone={a["status"] === "posted" ? "success" : "default"}>
                            {titleCase(String(a["status"]))}
                          </StatusPill>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                </div>
              </div>
            ))}
          </div>
        </FinanceQueryState>
      </SectionCard>

      <SectionCard
        title="Adjust, reverse or re-allocate a package charge"
        description="Original postings are never deleted. A reversal is recorded and, where applicable, a corrected allocation is posted against the same folio line."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="charge-id" className="text-xs text-muted-foreground">
              Folio line reference
            </Label>
            <Input
              id="charge-id"
              value={chargeId}
              onChange={(e) => setChargeId(e.target.value)}
              placeholder="Folio line id"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="reason" className="text-xs text-muted-foreground">
              Authorised reason (recorded in the audit trail)
            </Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Meal plan changed from Bed & Breakfast to Half Board"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!chargeId || allocate.isPending}
            onClick={() => allocate.mutate(chargeId)}
          >
            Allocate charge
          </Button>
          <Button
            variant="outline"
            disabled={!chargeId || !reason.trim() || recalc.isPending}
            onClick={() => recalc.mutate({ folioLineId: chargeId, reason })}
          >
            Recalculate
          </Button>
          <Button
            variant="destructive"
            disabled={!chargeId || !reason.trim() || reverse.isPending}
            onClick={() => reverse.mutate({ folioLineId: chargeId, reason })}
          >
            Reverse allocations
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}

/* ------------------------------ entitlements ----------------------------- */

function EntitlementsTab() {
  const [date, setDate] = useState(today());
  const [period, setPeriod] = useState("all");
  const entitlements = useMealEntitlements(date, period);
  const update = useUpdateEntitlement();

  const counts = useMemo(() => {
    const rows = entitlements.data ?? [];
    return {
      expected: rows
        .filter((r) => r["status"] !== "cancelled")
        .reduce((s, r) => s + num(r["guest_count"]), 0),
      consumed: rows.filter((r) => r["status"] === "consumed").length,
      pending: rows.filter((r) => r["status"] === "pending").length,
    };
  }, [entitlements.data]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Expected covers" value={String(counts.expected)} />
        <StatCard label="Recorded as consumed" value={String(counts.consumed)} />
        <StatCard label="Awaiting service" value={String(counts.pending)} />
      </div>
      <SectionCard
        title="Included meal entitlements"
        description="Created automatically when a package meal component is allocated. Recording consumption never changes the internal revenue allocation."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <NeoDatePicker
              value={date}
              onChange={setDate}
              className="w-40"
              ariaLabel="Service date"
            />
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="h-9 w-40" aria-label="Meal period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All meals</SelectItem>
                <SelectItem value="breakfast">Breakfast</SelectItem>
                <SelectItem value="lunch">Lunch</SelectItem>
                <SelectItem value="dinner">Dinner</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <FinanceQueryState
          isLoading={entitlements.isLoading}
          error={entitlements.error}
          isEmpty={(entitlements.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title="No entitlements for this date"
              description="Entitlements appear once package charges including meals are posted for the business date."
            />
          }
        >
          <DataTable head={["Guest", "Room", "Meal", "Covers", "Status", "Record"]}>
            {(entitlements.data ?? []).map((e) => (
              <tr key={String(e["id"])}>
                <td className="py-2 pr-4 font-medium">
                  {String((e["customers"] as Row | null)?.["full_name"] ?? "Guest")}
                </td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {String((e["rooms"] as Row | null)?.["room_number"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{titleCase(String(e["meal_period"]))}</td>
                <td className="py-2 pr-4">{num(e["guest_count"])}</td>
                <td className="py-2 pr-4">
                  <StatusPill
                    tone={
                      e["status"] === "consumed"
                        ? "success"
                        : e["status"] === "missed"
                          ? "warning"
                          : "default"
                    }
                  >
                    {titleCase(String(e["status"]))}
                  </StatusPill>
                </td>
                <td className="py-2 pr-4">
                  <div className="flex flex-wrap gap-1">
                    {["consumed", "missed", "packed", "replaced"].map((s) => (
                      <Button
                        key={s}
                        size="sm"
                        variant="ghost"
                        disabled={update.isPending || e["status"] === s}
                        onClick={() => update.mutate({ id: String(e["id"]), status: s })}
                      >
                        {titleCase(s)}
                      </Button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>
    </div>
  );
}

/* --------------------------------- reports -------------------------------- */

function ReportsTab() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const report = useAllocationReport(from, to, null);
  const data = (report.data ?? {}) as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(data[key]) ? (data[key] as Row[]) : []);
  const unbalanced = list("unbalanced");

  const groups: { key: string; title: string }[] = [
    { key: "by_component", title: "Revenue by package component" },
    { key: "by_department", title: "Revenue by department" },
    { key: "by_room_type", title: "Revenue by room type" },
    { key: "by_rate_plan", title: "Revenue by rate plan" },
    { key: "by_branch", title: "Revenue by branch" },
    { key: "by_stay_date", title: "Revenue by stay date" },
  ];

  return (
    <div className="space-y-6">
      <SectionCard
        title="Allocations versus package totals"
        description="Verified from posted allocations only. Reversed postings are excluded but never deleted."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <NeoDatePicker
              value={from}
              onChange={setFrom}
              className="w-40"
              ariaLabel="From date"
              quick={["today", "this-week", "next-7", "this-month"]}
            />
            <NeoDatePicker
              value={to}
              onChange={setTo}
              className="w-40"
              ariaLabel="To date"
              quick={["today", "this-week", "next-7", "this-month"]}
            />
          </div>
        }
      >
        <FinanceQueryState
          isLoading={report.isLoading}
          error={report.error}
          isEmpty={false}
          empty={null}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Total package sales" value={money(data["package_sales"])} />
            <StatCard label="Total allocated" value={money(data["total_allocated"])} />
            <StatCard label="Unbalanced charges" value={String(unbalanced.length)} />
          </div>
        </FinanceQueryState>
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        {groups.map((g) => (
          <SectionCard
            key={g.key}
            title={g.title}
            description="Amounts derive from posted allocations."
          >
            {list(g.key).length === 0 ? (
              <FinanceEmpty
                title="Nothing posted yet"
                description="No allocations found for the selected period."
              />
            ) : (
              <DataTable head={["Label", "Amount"]}>
                {list(g.key).map((row, i) => (
                  <tr key={`${g.key}-${i}`}>
                    <td className="py-2 pr-4">{titleCase(String(row["label"]))}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{money(row["amount"])}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </SectionCard>
        ))}
      </div>

      <SectionCard
        title="Unbalanced or failed allocations"
        description="Any package charge whose internal allocations do not equal the guest-facing price is listed here for correction."
      >
        {unbalanced.length === 0 ? (
          <FinanceEmpty
            title="Everything reconciles"
            description="Every package charge in this period equals the sum of its internal allocations."
          />
        ) : (
          <DataTable head={["Folio line", "Package price", "Allocated", "Variance"]}>
            {unbalanced.map((row, i) => (
              <tr key={i}>
                <td className="py-2 pr-4 font-mono text-xs">{String(row["folio_line_id"])}</td>
                <td className="py-2 pr-4">{money(row["package_price"])}</td>
                <td className="py-2 pr-4">{money(row["allocated"])}</td>
                <td className="py-2 pr-4 font-medium text-destructive">{money(row["variance"])}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}
