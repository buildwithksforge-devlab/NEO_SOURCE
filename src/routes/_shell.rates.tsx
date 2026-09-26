import { useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { CalendarDayLegend } from "@/components/common/CalendarSurface";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { EmptyState, QueryState } from "@/components/pms/PmsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NeoDateRangePicker } from "@/components/common/DatePicker";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { money } from "@/lib/pms";
import { ISO_WEEKDAYS, normalizeWeekdays } from "@/lib/weekdays";
import { useMealPlans, useRatePlans, useRoomTypes } from "@/lib/pms-data";
import {
  useArchiveRatePlan,
  useSaveMealPlan,
  useSaveRatePlan,
  type MealPlanInput,
  type RatePlanInput,
} from "@/lib/rates-data";

export const Route = createFileRoute("/_shell/rates")({
  head: () => ({
    meta: [
      { title: "Rates & Meal Plans — NEØ" },
      {
        name: "description",
        content:
          "The authoritative rate plans, packages and meal plans every Front Office screen prices from.",
      },
      { property: "og:title", content: "Rates & Meal Plans — NEØ" },
      {
        property: "og:description",
        content:
          "The authoritative rate plans, packages and meal plans every Front Office screen prices from.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

const DAYS = ISO_WEEKDAYS;

const STANDARD_MEAL_PLANS: { code: string; name: string; includes: string[] }[] = [
  { code: "RO", name: "Room Only", includes: [] },
  { code: "BB", name: "Bed & Breakfast", includes: ["breakfast"] },
  { code: "HB", name: "Half Board", includes: ["breakfast", "dinner"] },
  { code: "FB", name: "Full Board", includes: ["breakfast", "lunch", "dinner"] },
  {
    code: "AI",
    name: "All Inclusive",
    includes: ["breakfast", "lunch", "dinner", "beverages", "snacks"],
  },
];

const emptyRatePlan: RatePlanInput = {
  name: "",
  code: "",
  description: "",
  room_type_id: null,
  meal_plan_id: null,
  base_rate: 0,
  currency: "KES",
  tax_treatment: "exclusive",
  tax_rate: 16,
  service_charge_rate: 0,
  included_occupancy: 2,
  extra_adult_charge: 0,
  child_per_night: 0,
  extra_bed_charge: 0,
  min_stay: null,
  max_stay: null,
  valid_from: null,
  valid_to: null,
  days_of_week: [],
  corporate_only: false,
  cancellation_policy: "",
  deposit_policy: "",
  status: "active",
};

const emptyMealPlan: MealPlanInput = {
  code: "",
  name: "",
  description: "",
  includes: [],
  status: "active",
};

function Page() {
  const { can, loading } = useAuth();
  const canView = can("front-office", "rates", "view") || can("front-office", "meal-plans", "view");
  const canManageRates = can("front-office", "rates", "manage");
  const canManageMeals = can("front-office", "meal-plans", "manage");

  const ratePlans = useRatePlans();
  const mealPlans = useMealPlans();
  const roomTypes = useRoomTypes();
  const saveRate = useSaveRatePlan();
  const saveMeal = useSaveMealPlan();
  const archive = useArchiveRatePlan();

  const [rateDraft, setRateDraft] = useState<RatePlanInput | null>(null);
  const [mealDraft, setMealDraft] = useState<MealPlanInput | null>(null);

  if (loading) return <LoadingState variant="cards" rows={3} />;
  if (!canView) {
    return (
      <AccessDeniedPanel
        subject="Rates & Meal Plans"
        detail="front-office.rates.view is required. Ask an administrator to grant it from Roles & Permissions."
      />
    );
  }

  const mealPlanRows = mealPlans.data ?? [];
  const existingCodes = new Set(mealPlanRows.map((m) => String(m.code).toUpperCase()));
  const missingStandards = STANDARD_MEAL_PLANS.filter((s) => !existingCodes.has(s.code));

  return (
    <div>
      <PageHeader
        eyebrow="Rooms & Guests"
        title="Rates & Meal Plans"
        description="One authoritative pricing source. Reservations, groups, folios and POS entitlements all read these records — nightly rates are never typed by hand when a plan applies."
      />

      <Tabs defaultValue="rates">
        <TabsList>
          <TabsTrigger value="rates">Rate plans</TabsTrigger>
          <TabsTrigger value="meals">Meal plans</TabsTrigger>
        </TabsList>

        <TabsContent value="rates" className="mt-4">
          <SectionCard
            title="Rate plans"
            description="Room-type, seasonal, weekday/weekend, corporate, promotional and long-stay pricing with tax, service charge and stay restrictions."
            actions={
              canManageRates ? (
                <Button size="sm" onClick={() => setRateDraft({ ...emptyRatePlan })}>
                  <Plus className="mr-2 size-4" />
                  New rate plan
                </Button>
              ) : null
            }
          >
            <QueryState
              isLoading={ratePlans.isLoading}
              error={ratePlans.error}
              isEmpty={(ratePlans.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No rate plans configured"
                  description={
                    canManageRates
                      ? "Create the first rate plan so receptionists never type a nightly rate manually."
                      : "Rate plans have not been configured for this property yet."
                  }
                />
              }
            >
              <CalendarDayLegend className="mb-3" states={["available", "unavailable"]} />
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Plan</TableHead>
                      <TableHead>Room type</TableHead>
                      <TableHead>Meal plan</TableHead>
                      <TableHead className="text-right">Base rate</TableHead>
                      <TableHead>Validity</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(ratePlans.data ?? []).map((rp) => {
                      const record = rp as unknown as Record<string, unknown>;
                      return (
                        <TableRow key={rp.id}>
                          <TableCell>
                            <div className="font-medium">{rp.name}</div>
                            <div className="text-xs text-muted-foreground">{rp.code}</div>
                          </TableCell>
                          <TableCell>
                            {(rp as never as { room_types?: { name: string } }).room_types?.name ??
                              "Any"}
                          </TableCell>
                          <TableCell>
                            {(rp as never as { meal_plans?: { code: string } }).meal_plans?.code ??
                              "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {money(Number(rp.base_rate), rp.currency)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {rp.valid_from ?? "—"} → {rp.valid_to ?? "open"}
                          </TableCell>
                          <TableCell>
                            <StatusPill>{String(rp.status ?? "active")}</StatusPill>
                          </TableCell>
                          <TableCell className="text-right">
                            {canManageRates ? (
                              <div className="flex justify-end gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    setRateDraft({
                                      id: rp.id,
                                      name: rp.name ?? "",
                                      code: rp.code ?? "",
                                      description: rp.description ?? "",
                                      room_type_id: rp.room_type_id ?? null,
                                      meal_plan_id: rp.meal_plan_id ?? null,
                                      base_rate: Number(rp.base_rate ?? 0),
                                      currency: rp.currency ?? "KES",
                                      tax_treatment: rp.tax_treatment ?? "exclusive",
                                      tax_rate: Number(rp.tax_rate ?? 0),
                                      service_charge_rate: Number(rp.service_charge_rate ?? 0),
                                      included_occupancy: Number(rp.included_occupancy ?? 2),
                                      extra_adult_charge: Number(rp.extra_adult_charge ?? 0),
                                      child_per_night: Number(
                                        (record["child_pricing"] as { per_child?: number } | null)
                                          ?.per_child ?? 0,
                                      ),
                                      extra_bed_charge: Number(rp.extra_bed_charge ?? 0),
                                      min_stay: rp.min_stay ?? null,
                                      max_stay: rp.max_stay ?? null,
                                      valid_from: rp.valid_from ?? null,
                                      valid_to: rp.valid_to ?? null,
                                      days_of_week: normalizeWeekdays(
                                        (rp.days_of_week as unknown as
                                          (string | number)[] | null) ?? [],
                                      ),
                                      corporate_only: Boolean(rp.corporate_only),
                                      cancellation_policy: rp.cancellation_policy ?? "",
                                      deposit_policy: rp.deposit_policy ?? "",
                                      status: rp.status ?? "active",
                                    })
                                  }
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    archive.mutate({
                                      id: rp.id,
                                      status: rp.status === "active" ? "inactive" : "active",
                                    })
                                  }
                                >
                                  {rp.status === "active" ? "Deactivate" : "Activate"}
                                </Button>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">View only</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="meals" className="mt-4">
          <SectionCard
            title="Meal plans"
            description="Real records used by reservations, group bookings, folios, guest stay details and POS entitlement validation — never free text."
            actions={
              canManageMeals ? (
                <Button size="sm" onClick={() => setMealDraft({ ...emptyMealPlan })}>
                  <Plus className="mr-2 size-4" />
                  New meal plan
                </Button>
              ) : null
            }
          >
            {canManageMeals && missingStandards.length > 0 ? (
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3 text-sm">
                <span className="text-muted-foreground">Standard plans not yet configured:</span>
                {missingStandards.map((s) => (
                  <Button
                    key={s.code}
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setMealDraft({
                        code: s.code,
                        name: s.name,
                        description: "",
                        includes: s.includes,
                        status: "active",
                      })
                    }
                  >
                    Add {s.code} — {s.name}
                  </Button>
                ))}
              </div>
            ) : null}
            <QueryState
              isLoading={mealPlans.isLoading}
              error={mealPlans.error}
              isEmpty={mealPlanRows.length === 0}
              empty={
                <EmptyState
                  title="No meal plans configured"
                  description={
                    canManageMeals
                      ? "Add Room Only, Bed & Breakfast, Half Board, Full Board, All Inclusive or your own organisation-defined plans."
                      : "Meal plans have not been configured for this property yet."
                  }
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Includes</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mealPlanRows.map((mp) => (
                      <TableRow key={mp.id}>
                        <TableCell className="font-mono text-xs">{mp.code}</TableCell>
                        <TableCell className="font-medium">{mp.name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {((mp.includes as unknown as string[] | null) ?? []).join(", ") ||
                            "Room only"}
                        </TableCell>
                        <TableCell>
                          <StatusPill>{String(mp.status ?? "active")}</StatusPill>
                        </TableCell>
                        <TableCell className="text-right">
                          {canManageMeals ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setMealDraft({
                                  id: mp.id,
                                  code: mp.code ?? "",
                                  name: mp.name ?? "",
                                  description: mp.description ?? "",
                                  includes: (mp.includes as unknown as string[] | null) ?? [],
                                  status: mp.status ?? "active",
                                })
                              }
                            >
                              Edit
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">View only</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>
      </Tabs>

      {/* ---------------- Rate plan editor ---------------- */}
      <Dialog open={Boolean(rateDraft)} onOpenChange={(o) => !o && setRateDraft(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{rateDraft?.id ? "Edit rate plan" : "New rate plan"}</DialogTitle>
          </DialogHeader>
          {rateDraft ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={rateDraft.name}
                  onChange={(e) => setRateDraft({ ...rateDraft, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Code</Label>
                <Input
                  value={rateDraft.code}
                  onChange={(e) => setRateDraft({ ...rateDraft, code: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Room type</Label>
                <Select
                  value={rateDraft.room_type_id ?? "any"}
                  onValueChange={(v) =>
                    setRateDraft({ ...rateDraft, room_type_id: v === "any" ? null : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any room type</SelectItem>
                    {(roomTypes.data ?? []).map((rt) => (
                      <SelectItem key={rt.id} value={rt.id}>
                        {rt.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Meal plan</Label>
                <Select
                  value={rateDraft.meal_plan_id ?? "none"}
                  onValueChange={(v) =>
                    setRateDraft({ ...rateDraft, meal_plan_id: v === "none" ? null : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No meal plan</SelectItem>
                    {mealPlanRows.map((mp) => (
                      <SelectItem key={mp.id} value={mp.id}>
                        {mp.code} — {mp.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Base rate (per night, included occupancy)</Label>
                <Input
                  type="number"
                  min={0}
                  value={rateDraft.base_rate}
                  onChange={(e) =>
                    setRateDraft({ ...rateDraft, base_rate: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Currency</Label>
                <Input
                  value={rateDraft.currency}
                  onChange={(e) =>
                    setRateDraft({ ...rateDraft, currency: e.target.value.toUpperCase() })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Included occupancy (adults)</Label>
                <Input
                  type="number"
                  min={1}
                  value={rateDraft.included_occupancy}
                  onChange={(e) =>
                    setRateDraft({ ...rateDraft, included_occupancy: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Extra adult, per night</Label>
                <Input
                  type="number"
                  min={0}
                  value={rateDraft.extra_adult_charge}
                  onChange={(e) =>
                    setRateDraft({ ...rateDraft, extra_adult_charge: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Child, per child per night</Label>
                <Input
                  type="number"
                  min={0}
                  value={rateDraft.child_per_night}
                  onChange={(e) =>
                    setRateDraft({ ...rateDraft, child_per_night: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Extra bed</Label>
                <Input
                  type="number"
                  min={0}
                  value={rateDraft.extra_bed_charge}
                  onChange={(e) =>
                    setRateDraft({ ...rateDraft, extra_bed_charge: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Tax treatment</Label>
                <Select
                  value={rateDraft.tax_treatment}
                  onValueChange={(v) => setRateDraft({ ...rateDraft, tax_treatment: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="exclusive">Tax exclusive</SelectItem>
                    <SelectItem value="inclusive">Tax inclusive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label>Tax %</Label>
                  <Input
                    type="number"
                    min={0}
                    value={rateDraft.tax_rate}
                    onChange={(e) =>
                      setRateDraft({ ...rateDraft, tax_rate: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Service charge %</Label>
                  <Input
                    type="number"
                    min={0}
                    value={rateDraft.service_charge_rate}
                    onChange={(e) =>
                      setRateDraft({ ...rateDraft, service_charge_rate: Number(e.target.value) })
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Valid period</Label>
                <NeoDateRangePicker
                  from={rateDraft.valid_from ?? ""}
                  to={rateDraft.valid_to ?? ""}
                  onChange={({ from, to }) =>
                    setRateDraft({ ...rateDraft, valid_from: from || null, valid_to: to || null })
                  }
                  fromLabel="Valid from"
                  toLabel="Valid to"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label>Minimum stay</Label>
                  <Input
                    type="number"
                    min={0}
                    value={rateDraft.min_stay ?? ""}
                    onChange={(e) =>
                      setRateDraft({
                        ...rateDraft,
                        min_stay: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Maximum stay</Label>
                  <Input
                    type="number"
                    min={0}
                    value={rateDraft.max_stay ?? ""}
                    onChange={(e) =>
                      setRateDraft({
                        ...rateDraft,
                        max_stay: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Applies on (leave empty for every day)</Label>
                <div className="flex flex-wrap gap-2">
                  {DAYS.map((d) => {
                    const on = rateDraft.days_of_week.includes(d.value);
                    return (
                      <Button
                        key={d.value}
                        type="button"
                        size="sm"
                        title={d.label}
                        variant={on ? "default" : "outline"}
                        onClick={() =>
                          setRateDraft({
                            ...rateDraft,
                            days_of_week: on
                              ? rateDraft.days_of_week.filter((x) => x !== d.value)
                              : [...rateDraft.days_of_week, d.value].sort((a, b) => a - b),
                          })
                        }
                      >
                        {d.short}
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Cancellation policy</Label>
                <Textarea
                  rows={2}
                  value={rateDraft.cancellation_policy}
                  onChange={(e) =>
                    setRateDraft({ ...rateDraft, cancellation_policy: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Deposit policy</Label>
                <Textarea
                  rows={2}
                  value={rateDraft.deposit_policy}
                  onChange={(e) => setRateDraft({ ...rateDraft, deposit_policy: e.target.value })}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border p-3 md:col-span-2">
                <div>
                  <p className="text-sm font-medium">Corporate / negotiated only</p>
                  <p className="text-xs text-muted-foreground">
                    Hidden from ordinary walk-in and direct bookings.
                  </p>
                </div>
                <Switch
                  checked={rateDraft.corporate_only}
                  onCheckedChange={(v) => setRateDraft({ ...rateDraft, corporate_only: v })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRateDraft(null)}>
              Cancel
            </Button>
            <Button
              disabled={!rateDraft?.name.trim() || !rateDraft?.code.trim() || saveRate.isPending}
              onClick={async () => {
                if (!rateDraft) return;
                await saveRate.mutateAsync(rateDraft);
                setRateDraft(null);
              }}
            >
              {saveRate.isPending ? "Saving…" : "Save rate plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Meal plan editor ---------------- */}
      <Dialog open={Boolean(mealDraft)} onOpenChange={(o) => !o && setMealDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mealDraft?.id ? "Edit meal plan" : "New meal plan"}</DialogTitle>
          </DialogHeader>
          {mealDraft ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Code</Label>
                  <Input
                    value={mealDraft.code}
                    onChange={(e) => setMealDraft({ ...mealDraft, code: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input
                    value={mealDraft.name}
                    onChange={(e) => setMealDraft({ ...mealDraft, name: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Includes</Label>
                <div className="flex flex-wrap gap-2">
                  {["breakfast", "lunch", "dinner", "beverages", "snacks"].map((m) => {
                    const on = mealDraft.includes.includes(m);
                    return (
                      <Button
                        key={m}
                        type="button"
                        size="sm"
                        variant={on ? "default" : "outline"}
                        onClick={() =>
                          setMealDraft({
                            ...mealDraft,
                            includes: on
                              ? mealDraft.includes.filter((x) => x !== m)
                              : [...mealDraft.includes, m],
                          })
                        }
                      >
                        {m}
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  rows={2}
                  value={mealDraft.description}
                  onChange={(e) => setMealDraft({ ...mealDraft, description: e.target.value })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMealDraft(null)}>
              Cancel
            </Button>
            <Button
              disabled={!mealDraft?.code.trim() || !mealDraft?.name.trim() || saveMeal.isPending}
              onClick={async () => {
                if (!mealDraft) return;
                await saveMeal.mutateAsync(mealDraft);
                setMealDraft(null);
              }}
            >
              {saveMeal.isPending ? "Saving…" : "Save meal plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/rates">
      <Page />
    </OpsGuard>
  );
}
