import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/common/FormDialog";
import { FieldGrid } from "@/components/common/FormFields";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useDepartmentsLookup, useHrWrite } from "@/lib/hr-data";
import { ACCRUAL_METHODS, APPROVAL_ROUTES, LEAVE_CATEGORIES } from "@/lib/hr-leave";
import { LEAVE_GENDER_SCOPES } from "@/lib/hr-terms";
import { EMPLOYMENT_TYPES, HR_MODULES, type Row } from "@/lib/hr";

type Draft = {
  name: string;
  code: string;
  category: string;
  paid: boolean;
  annual_entitlement_days: string;
  accrual_method: string;
  eligibility_months: string;
  carry_forward: boolean;
  max_carry_forward_days: string;
  carry_forward_expiry_months: string;
  counts_weekends: boolean;
  counts_public_holidays: boolean;
  minimum_notice_days: string;
  max_consecutive_days: string;
  requires_document: boolean;
  approval_route: string;
  gender_scope: string;
  employment_types: string[];
  department_ids: string[];
  minimum_service_days: string;
  max_requests_per_year: string;
  effective_from: string;
  effective_to: string;
  active: boolean;
};

function draftFrom(policy: Row | null): Draft {
  return {
    name: String(policy?.["name"] ?? ""),
    code: String(policy?.["code"] ?? ""),
    category: String(policy?.["category"] ?? "annual"),
    paid: policy?.["paid"] !== false,
    annual_entitlement_days: String(policy?.["annual_entitlement_days"] ?? ""),
    accrual_method: String(policy?.["accrual_method"] ?? "annual"),
    eligibility_months: String(policy?.["eligibility_months"] ?? "0"),
    carry_forward: Boolean(policy?.["carry_forward"]),
    max_carry_forward_days: String(policy?.["max_carry_forward_days"] ?? ""),
    carry_forward_expiry_months: String(policy?.["carry_forward_expiry_months"] ?? ""),
    counts_weekends: policy?.["counts_weekends"] !== false,
    counts_public_holidays: policy?.["counts_public_holidays"] !== false,
    minimum_notice_days: String(policy?.["minimum_notice_days"] ?? "0"),
    max_consecutive_days: String(policy?.["max_consecutive_days"] ?? ""),
    requires_document: Boolean(policy?.["requires_document"]),
    approval_route: String(policy?.["approval_route"] ?? "supervisor_then_hr"),
    gender_scope: String(policy?.["gender_scope"] ?? "any"),
    employment_types: Array.isArray(policy?.["employment_types"])
      ? (policy!["employment_types"] as unknown[]).map((v) => String(v))
      : [],
    department_ids: Array.isArray(policy?.["department_ids"])
      ? (policy!["department_ids"] as unknown[]).map((v) => String(v))
      : [],
    minimum_service_days: String(policy?.["minimum_service_days"] ?? "0"),
    max_requests_per_year: String(policy?.["max_requests_per_year"] ?? ""),
    effective_from: String(policy?.["effective_from"] ?? ""),
    effective_to: String(policy?.["effective_to"] ?? ""),
    active: policy?.["active"] !== false,
  };
}

function numberOrNull(value: string): number | null {
  const v = Number(value);
  return value.trim() === "" || !Number.isFinite(v) ? null : v;
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/** Create or edit one company leave policy. Entitlement is then calculated from it. */
export function LeavePolicyDialog({
  open,
  onOpenChange,
  policy,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  policy: Row | null;
}) {
  const save = useHrWrite("leave_types", { module: HR_MODULES.leave, action: "types.manage" });
  const departments = useDepartmentsLookup();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(policy));

  useEffect(() => {
    if (open) setDraft(draftFrom(policy));
  }, [open, policy]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function submit() {
    if (!draft.name.trim()) return;
    save.mutate(
      {
        ...(policy ? { id: String(policy["id"]) } : {}),
        values: {
          name: draft.name.trim(),
          code: draft.code.trim() || draft.name.trim().slice(0, 12).toUpperCase(),
          category: draft.category,
          paid: draft.paid,
          annual_entitlement_days: numberOrNull(draft.annual_entitlement_days) ?? 0,
          accrual_method: draft.accrual_method,
          eligibility_months: numberOrNull(draft.eligibility_months) ?? 0,
          carry_forward: draft.carry_forward,
          max_carry_forward_days: numberOrNull(draft.max_carry_forward_days) ?? 0,
          carry_forward_expiry_months: numberOrNull(draft.carry_forward_expiry_months) ?? 0,
          counts_weekends: draft.counts_weekends,
          counts_public_holidays: draft.counts_public_holidays,
          minimum_notice_days: numberOrNull(draft.minimum_notice_days) ?? 0,
          max_consecutive_days: numberOrNull(draft.max_consecutive_days),
          requires_document: draft.requires_document,
          approval_route: draft.approval_route,
          gender_scope: draft.gender_scope,
          employment_types: draft.employment_types,
          department_ids: draft.department_ids,
          minimum_service_days: numberOrNull(draft.minimum_service_days) ?? 0,
          max_requests_per_year: numberOrNull(draft.max_requests_per_year),
          effective_from: draft.effective_from.trim() || null,
          effective_to: draft.effective_to.trim() || null,
          active: draft.active,
        },
        reason: policy ? "Leave policy updated" : "Leave policy created",
      },
      {
        onSuccess: () => {
          toast.success(policy ? "Leave policy updated" : "Leave policy created");
          onOpenChange(false);
        },
        onError: (error: unknown) =>
          toast.error(error instanceof Error ? error.message : "Could not save the policy"),
      },
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={policy ? `Edit ${String(policy["name"])}` : "New leave policy"}
      description="NEØ calculates every employee's entitlement from these rules. Balances are never typed in by hand."
      submitLabel={policy ? "Save policy" : "Create policy"}
      canSubmit={Boolean(draft.name.trim())}
      busy={save.isPending}
      onSubmit={submit}
    >
      <FieldGrid>
        <div className="space-y-1.5">
          <Label htmlFor="policy-name">Leave type name</Label>
          <Input
            id="policy-name"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Annual Leave"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-code">Short code</Label>
          <Input
            id="policy-code"
            value={draft.code}
            onChange={(e) => set("code", e.target.value)}
            placeholder="ANNUAL"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-category">Category</Label>
          <Select value={draft.category} onValueChange={(v) => set("category", v)}>
            <SelectTrigger id="policy-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEAVE_CATEGORIES.map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-days">Days allowed each leave year</Label>
          <Input
            id="policy-days"
            inputMode="numeric"
            value={draft.annual_entitlement_days}
            onChange={(e) => set("annual_entitlement_days", e.target.value)}
            placeholder="21"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-accrual">How entitlement is granted</Label>
          <Select value={draft.accrual_method} onValueChange={(v) => set("accrual_method", v)}>
            <SelectTrigger id="policy-accrual">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCRUAL_METHODS.map((a) => (
                <SelectItem key={a.key} value={a.key}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-eligibility">Eligible after (months of service)</Label>
          <Input
            id="policy-eligibility"
            inputMode="numeric"
            value={draft.eligibility_months}
            onChange={(e) => set("eligibility_months", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-notice">Minimum notice (days)</Label>
          <Input
            id="policy-notice"
            inputMode="numeric"
            value={draft.minimum_notice_days}
            onChange={(e) => set("minimum_notice_days", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-max">Longest single absence (days, optional)</Label>
          <Input
            id="policy-max"
            inputMode="numeric"
            value={draft.max_consecutive_days}
            onChange={(e) => set("max_consecutive_days", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-carry-max">Maximum days carried forward</Label>
          <Input
            id="policy-carry-max"
            inputMode="numeric"
            disabled={!draft.carry_forward}
            value={draft.max_carry_forward_days}
            onChange={(e) => set("max_carry_forward_days", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-carry-expiry">Carried days expire after (months)</Label>
          <Input
            id="policy-carry-expiry"
            inputMode="numeric"
            disabled={!draft.carry_forward}
            value={draft.carry_forward_expiry_months}
            onChange={(e) => set("carry_forward_expiry_months", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-gender">Who this policy applies to</Label>
          <Select value={draft.gender_scope} onValueChange={(v) => set("gender_scope", v)}>
            <SelectTrigger id="policy-gender">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEAVE_GENDER_SCOPES.map((g) => (
                <SelectItem key={g.key} value={g.key}>
                  {g.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            A restricted policy is only offered to staff whose recorded gender matches, and the
            database refuses an application from anyone else.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="policy-route">Approval route</Label>
          <Select value={draft.approval_route} onValueChange={(v) => set("approval_route", v)}>
            <SelectTrigger id="policy-route">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {APPROVAL_ROUTES.map((r) => (
                <SelectItem key={r.key} value={r.key}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </FieldGrid>

      <div className="space-y-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-medium">Who this policy applies to</p>
          <p className="text-xs text-muted-foreground">
            Leave every box unticked to apply the policy to all staff. Anything selected narrows it,
            and a member of staff who does not qualify is neither given a balance nor allowed to
            apply.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Employment types</Label>
          <div className="flex flex-wrap gap-2">
            {EMPLOYMENT_TYPES.map((t) => {
              const on = draft.employment_types.includes(t.key);
              return (
                <Button
                  key={t.key}
                  type="button"
                  size="sm"
                  variant={on ? "default" : "outline"}
                  onClick={() =>
                    set(
                      "employment_types",
                      on
                        ? draft.employment_types.filter((v) => v !== t.key)
                        : [...draft.employment_types, t.key],
                    )
                  }
                >
                  {t.label}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Departments</Label>
          <div className="flex flex-wrap gap-2">
            {(departments.data ?? []).map((d) => {
              const id = String(d["id"]);
              const on = draft.department_ids.includes(id);
              return (
                <Button
                  key={id}
                  type="button"
                  size="sm"
                  variant={on ? "default" : "outline"}
                  onClick={() =>
                    set(
                      "department_ids",
                      on
                        ? draft.department_ids.filter((v) => v !== id)
                        : [...draft.department_ids, id],
                    )
                  }
                >
                  {String(d["name"])}
                </Button>
              );
            })}
            {(departments.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No departments configured yet.</p>
            ) : null}
          </div>
        </div>

        <FieldGrid>
          <div className="space-y-1.5">
            <Label htmlFor="policy-service-days">Eligible after (days of service)</Label>
            <Input
              id="policy-service-days"
              inputMode="numeric"
              value={draft.minimum_service_days}
              onChange={(e) => set("minimum_service_days", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Use this for short waiting periods; the months field above suits longer ones.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="policy-max-requests">Separate requests allowed each year</Label>
            <Input
              id="policy-max-requests"
              inputMode="numeric"
              value={draft.max_requests_per_year}
              onChange={(e) => set("max_requests_per_year", e.target.value)}
              placeholder="No limit"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="policy-effective-from">In force from</Label>
            <NeoDatePicker
              id="policy-effective-from"
              value={draft.effective_from}
              onChange={(v) => set("effective_from", v)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="policy-effective-to">In force until</Label>
            <NeoDatePicker
              id="policy-effective-to"
              value={draft.effective_to}
              placeholder="No end date"
              min={draft.effective_from || undefined}
              onChange={(v) => set("effective_to", v)}
            />
          </div>
        </FieldGrid>
      </div>



      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle
          id="policy-paid"
          label="Paid leave"
          hint="Unpaid leave may exceed the balance; paid leave may not."
          checked={draft.paid}
          onChange={(v) => set("paid", v)}
        />
        <Toggle
          id="policy-carry"
          label="Unused days carry forward"
          checked={draft.carry_forward}
          onChange={(v) => set("carry_forward", v)}
        />
        <Toggle
          id="policy-weekends"
          label="Weekends count as leave days"
          checked={draft.counts_weekends}
          onChange={(v) => set("counts_weekends", v)}
        />
        <Toggle
          id="policy-holidays"
          label="Public holidays count as leave days"
          hint="Excluding them only takes effect once real holiday dates are recorded."
          checked={draft.counts_public_holidays}
          onChange={(v) => set("counts_public_holidays", v)}
        />
        <Toggle
          id="policy-document"
          label="Supporting document required"
          checked={draft.requires_document}
          onChange={(v) => set("requires_document", v)}
        />
        <Toggle
          id="policy-active"
          label="Available to staff"
          checked={draft.active}
          onChange={(v) => set("active", v)}
        />
      </div>
    </FormDialog>
  );
}
