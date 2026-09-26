import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MoreHorizontal, Pencil, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { AccessDeniedInline } from "@/components/common/AccessState";
import { ConfirmAction } from "@/components/common/ConfirmAction";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { logAudit } from "@/lib/audit";

/**
 * One configuration editor for the whole Configuration Centre.
 *
 * Every canonical configuration collection — meal plans, suppliers, delivery
 * zones, accounting periods and anything added later — renders through this
 * component so the behaviour is identical everywhere:
 *
 *   • the active property scopes the list AND stamps `branch_id` on creation,
 *     so a record can never be written into a property the user is not viewing;
 *   • the query key carries `filterKey`, so switching property refetches;
 *   • create/edit controls are permission-aware and simply absent when the
 *     account may only read;
 *   • every write is audited with the actor, the record and before/after values;
 *   • the three states operators must be able to tell apart — no permission,
 *     configured-but-empty, and has-records — each read differently.
 *
 * Nothing here is hotel-specific: the caller supplies the table, the fields and
 * the labels, so a brand-new organisation configures itself through the same
 * surface as an established one.
 */

export type ConfigFieldType = "text" | "textarea" | "number" | "money" | "time" | "date" | "switch" | "select" | "list";

export type ConfigField = {
  name: string;
  label: string;
  type: ConfigFieldType;
  /** Required fields block the save button until they hold a value. */
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  /**
   * Resolves the options of a `select` from another canonical table instead of
   * a hardcoded list, so a stock item points at the real category, supplier and
   * store records rather than a copy of their names.
   */
  lookup?: {
    table: string;
    labelColumn?: string;
    propertyScoped?: boolean;
    /** Column holding the parent record, used to narrow this list. */
    parentColumn?: string;
  };
  /**
   * Names the field that chooses the parent. The options of this select are
   * then limited to the children of that parent — item group → category.
   */
  dependsOn?: string;
  /** Shown in the form but not written to the table (a chooser, not a column). */
  virtual?: boolean;
  /** Default applied to a new record. */
  defaultValue?: unknown;
  /** Hide from the create/edit form but keep for display. */
  readOnly?: boolean;
  /**
   * Conditional field. The field is only shown — and only required, and only
   * written with the operator's value — while this returns true for the form
   * in hand. A store that no longer issues to a department must not keep a
   * stale department on the record, so a hidden field is cleared on save.
   */
  showWhen?: (form: Record<string, unknown>) => boolean;
  /**
   * Number field that genuinely has "not applicable" as an answer — a container
   * volume on a sack of onions, a pour size on a dry good. Left blank it is
   * stored as null rather than a misleading zero, which is also what the
   * positive-value check constraints expect.
   */
  nullable?: boolean;
};

export type ConfigRow = Record<string, unknown> & { id: string };

export type ConfigCollectionProps = {
  /** Canonical table this surface owns. There must be exactly one per concept. */
  table: string;
  title: string;
  description: string;
  /** Singular noun used in buttons, dialogs and empty states. */
  singular: string;
  /** Columns selected from the table. */
  select: string;
  fields: ConfigField[];
  /** Column ordering applied to the list. */
  orderBy?: string;
  /** Capability that unlocks create/edit. When false the surface is read-only. */
  canEdit: boolean;
  /** Audit module for the change log. */
  auditModule: string;
  /** Renders the summary line under each record's title. */
  renderSummary?: (row: ConfigRow) => ReactNode;
  /** Column holding the record's display name. */
  labelField?: string;
  /** Column holding an active/status flag rendered as a pill. */
  statusField?: string;
  /**
   * Vocabulary the status column actually accepts. Some tables use a boolean,
   * most text columns use active/inactive, and the financial calendar uses
   * open/closed — writing the wrong word is rejected by a check constraint.
   */
  activeValue?: string;
  inactiveValue?: string;
  activeLabel?: string;
  inactiveLabel?: string;
  /**
   * False for organisation-level configuration (financial years, accounting
   * periods) that no single property owns — the record is not stamped with a
   * branch and the property selector does not narrow the list.
   */
  propertyScoped?: boolean;
  /** Extra content rendered above the list (counts, warnings, related setup). */
  children?: ReactNode;
};

const emptyFor = (field: ConfigField): unknown => {
  if (field.defaultValue !== undefined) return field.defaultValue;
  switch (field.type) {
    case "switch":
      return true;
    case "number":
    case "money":
      return field.nullable ? "" : 0;
    case "list":
      return "";
    default:
      return "";
  }
};

const toStored = (field: ConfigField, value: unknown): unknown => {
  if (field.type === "number" || field.type === "money") {
    if (field.nullable) {
      const text = String(value ?? "").trim();
      if (text === "") return null;
      const parsed = Number(text);
      // Zero on a not-applicable measure means "none", not a real measurement.
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return Number(value ?? 0);
  }
  if (field.type === "switch") return Boolean(value);
  if (field.type === "list") {
    return String(value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (value === "") return null;
  return value;
};

const toForm = (field: ConfigField, value: unknown): unknown => {
  if (field.type === "list") return Array.isArray(value) ? value.join(", ") : (value ?? "");
  if (field.type === "switch") return Boolean(value);
  return value ?? "";
};

export function ConfigCollection({
  table,
  title,
  description,
  singular,
  select,
  fields,
  orderBy,
  canEdit,
  auditModule,
  renderSummary,
  labelField = "name",
  statusField,
  activeValue = "active",
  inactiveValue = "inactive",
  activeLabel = "Active",
  inactiveLabel = "Inactive",
  propertyScoped = true,
  children,
}: ConfigCollectionProps) {
  const { organizationId, user, profile, isAdmin } = useAuth();
  const { activeBranchId, branches } = useBranchScope();
  const { branchId, applyTo, filterKey } = useActivePropertyFilter();
  // Viewing "All properties" is only ambiguous when there is more than one to
  // choose from. With a single property in scope the owner of a new record is
  // never in doubt, so the form stays usable instead of silently refusing.
  const soleBranchId = branches.length === 1 ? branches[0]!.id : null;
  const targetBranchId = branchId ?? soleBranchId;
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ConfigRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Record<string, unknown>>({});

  const queryKey = ["config-collection", table, organizationId, filterKey];

  const rows = useQuery({
    queryKey,
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase.from(table as never).select(select);
      if (propertyScoped) q = applyTo(q, table);
      const { data, error } = await q.order(orderBy ?? labelField, { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as ConfigRow[];
    },
  });

  const lookupFields = useMemo(() => fields.filter((field) => field.lookup), [fields]);

  const lookups = useQuery({
    queryKey: ["config-collection-lookups", table, organizationId, filterKey, lookupFields.map((f) => f.name).join("|")],
    enabled: Boolean(organizationId) && lookupFields.length > 0,
    queryFn: async () => {
      const resolved: Record<string, { value: string; label: string; parent?: string | null }[]> = {};
      for (const field of lookupFields) {
        const lookup = field.lookup!;
        const label = lookup.labelColumn ?? "name";
        const columns = ["id", label, lookup.parentColumn].filter(Boolean).join(", ");
        let q = supabase.from(lookup.table as never).select(columns);
        if (lookup.propertyScoped !== false) q = applyTo(q, lookup.table);
        const { data, error } = await q.order(label, { ascending: true });
        if (error) throw error;
        resolved[field.name] = ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
          value: String(row["id"]),
          label: String(row[label] ?? "Unnamed"),
          parent: lookup.parentColumn ? ((row[lookup.parentColumn] as string | null) ?? null) : null,
        }));

      }
      return resolved;
    },
  });



  const save = useMutation({
    mutationFn: async ({ row, values }: { row: ConfigRow | null; values: Record<string, unknown> }) => {
      const patch: Record<string, unknown> = {};
      for (const field of fields) {
        if (field.readOnly || field.virtual) continue;
        // A conditional field that no longer applies is written empty, so a
        // relationship the operator has just switched off cannot linger.
        if (field.showWhen && !field.showWhen(values)) {
          patch[field.name] = field.type === "switch" ? false : null;
          continue;
        }
        patch[field.name] = toStored(field, values[field.name]);
      }
      if (row) {
        const { error } = await supabase
          .from(table as never)
          .update(patch as never)
          .eq("id", row.id);
        if (error) throw error;
        await logAudit({
          organizationId,
          userId: user?.id ?? null,
          userName: profile?.full_name,
          action: `${auditModule}.${table}.updated`,
          module: auditModule,
          recordId: row.id,
          previousValue: row,
          newValue: patch,
          branchId: (row["branch_id"] as string | null) ?? branchId,
        });
        return;
      }
      // A new configuration record always belongs to the property in view. When
      // the account is viewing all properties it must pick one first, so the
      // record can never land without an owner.
      const insert: Record<string, unknown> = { ...patch, organization_id: organizationId };
      if (propertyScoped && fields.every((f) => f.name !== "branch_id") && targetBranchId) {
        insert["branch_id"] = targetBranchId;
      }
      const { data, error } = await supabase
        .from(table as never)
        .insert(insert as never)
        .select("id")
        .single();
      if (error) throw error;
      await logAudit({
        organizationId,
        userId: user?.id ?? null,
        userName: profile?.full_name,
        action: `${auditModule}.${table}.created`,
        module: auditModule,
        recordId: (data as { id: string }).id,
        newValue: insert,
        branchId,
      });
    },
    onSuccess: () => {
      toast.success(`${singular} saved`);
      setEditing(null);
      setCreating(false);
      void qc.invalidateQueries({ queryKey: ["config-collection", table] });
      void qc.invalidateQueries({ queryKey: ["settings-status"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  /**
   * Retiring and removing a configuration record.
   *
   * A record that is still referenced by history — a supplier on an old
   * purchase order, a store on a posted goods receipt — must never be erased,
   * so the safe act is always offered first: when the collection carries a
   * status flag, the record is deactivated and simply stops being offered on
   * new transactions while every past document still resolves.
   *
   * Permanent removal is only offered once a record is already inactive, and
   * the database still has the last word: a foreign-key refusal is reported as
   * what it is — the record is in use — rather than as a failure.
   */
  const [removing, setRemoving] = useState<ConfigRow | null>(null);
  const [retiring, setRetiring] = useState<ConfigRow | null>(null);

  const isActive = (row: ConfigRow) =>
    statusField ? row[statusField] === true || row[statusField] === activeValue : true;

  const setStatus = useMutation({
    mutationFn: async ({ row, active }: { row: ConfigRow; active: boolean }) => {
      if (!statusField) return;
      const next =
        typeof row[statusField] === "string" ? (active ? activeValue : inactiveValue) : active;
      const { data, error } = await supabase
        .from(table as never)
        .update({ [statusField]: next } as never)
        .eq("id", row.id)
        .select("id");
      if (error) throw error;
      if (!data || (data as unknown[]).length === 0) {
        throw new Error(
          `Nothing changed — your account is not allowed to ${active ? "reactivate" : "deactivate"} this ${singular.toLowerCase()}.`,
        );
      }
      await logAudit({
        organizationId,
        userId: user?.id ?? null,
        userName: profile?.full_name,
        action: `${auditModule}.${table}.${active ? "reactivated" : "deactivated"}`,
        module: auditModule,
        recordId: row.id,
        previousValue: row,
        newValue: { [statusField]: next },
        branchId: (row["branch_id"] as string | null) ?? branchId,
      });
    },
    onSuccess: (_data, variables) => {
      toast.success(`${singular} ${variables.active ? "reactivated" : "deactivated"}`);
      setRetiring(null);
      void qc.invalidateQueries({ queryKey: ["config-collection", table] });
      void qc.invalidateQueries({ queryKey: ["settings-status"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async (row: ConfigRow) => {
      // The delete is confirmed by what came back, not by the absence of an
      // error: when access rules refuse the row, Postgres removes nothing and
      // reports no error, so a silent no-op would otherwise read as success.
      const { data, error } = await supabase
        .from(table as never)
        .delete()
        .eq("id", row.id)
        .select("id");
      if (error) throw error;
      if (!data || (data as unknown[]).length === 0) {
        throw new Error(
          `Nothing was deleted — your account is not allowed to remove a ${singular.toLowerCase()} here. It stays deactivated and out of new transactions.`,
        );
      }
      await logAudit({
        organizationId,
        userId: user?.id ?? null,
        userName: profile?.full_name,
        action: `${auditModule}.${table}.deleted`,
        module: auditModule,
        recordId: row.id,
        previousValue: row,
        branchId: (row["branch_id"] as string | null) ?? branchId,
      });
    },
    onSuccess: () => {
      toast.success(`${singular} deleted`);
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ["config-collection", table] });
      void qc.invalidateQueries({ queryKey: ["settings-status"] });
    },
    onError: (error: Error) => {
      const inUse = /foreign key|violates|referenced|23503/i.test(error.message);
      toast.error(
        inUse
          ? `This ${singular.toLowerCase()} is still used by existing records, so it cannot be deleted. It stays deactivated and out of new transactions.`
          : error.message,
      );
    },
  });

  const openCreate = () => {
    const next: Record<string, unknown> = {};
    for (const field of fields) next[field.name] = emptyFor(field);
    setForm(next);
    setCreating(true);
  };

  const openEdit = (row: ConfigRow) => {
    const next: Record<string, unknown> = {};
    for (const field of fields) next[field.name] = toForm(field, row[field.name]);
    // A chooser such as "Item group" is not stored on the record: it is read
    // back from the parent of whatever the record already points at.
    for (const field of fields) {
      if (!field.dependsOn) continue;
      const chosen = (lookups.data?.[field.name] ?? []).find((o) => o.value === String(row[field.name] ?? ""));
      if (chosen?.parent) next[field.dependsOn] = chosen.parent;
    }
    setForm(next);
    setEditing(row);
  };


  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows.data ?? [];
    return (rows.data ?? []).filter((row) =>
      Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(term)),
    );
  }, [rows.data, search]);

  const missingRequired = fields.some(
    (field) =>
      field.required &&
      !field.readOnly &&
      (field.showWhen ? field.showWhen(form) : true) &&
      String(form[field.name] ?? "").trim() === "",
  );
  const needsProperty = propertyScoped && !targetBranchId && activeBranchId === "all";
  const dialogOpen = creating || editing !== null;

  return (
    <SectionCard
      title={title}
      description={description}
      actions={
        canEdit ? (
          <Button size="sm" onClick={openCreate} disabled={needsProperty}>
            <Plus className="mr-1.5 size-4" />
            Add {singular.toLowerCase()}
          </Button>
        ) : undefined
      }
    >
      {children}

      {needsProperty && canEdit ? (
        <p className="mb-4 rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          Select a single property in the header to add a {singular.toLowerCase()} — configuration records always
          belong to one property.
        </p>
      ) : null}

      {(rows.data?.length ?? 0) > 6 ? (
        <div className="relative mb-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={`Search ${title.toLowerCase()}`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      ) : null}

      {rows.isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading {title.toLowerCase()}…
        </div>
      ) : rows.error ? (
        <AccessDeniedInline reason="denied" subject={title.toLowerCase()} />
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
          <p className="text-sm font-medium text-foreground">No {title.toLowerCase()} yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {canEdit
              ? `Add the first ${singular.toLowerCase()} to make this part of the workspace operational.`
              : `An administrator has not configured ${title.toLowerCase()} for this property yet.`}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {visible.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {String(row[labelField] ?? "Untitled")}
                </p>
                {renderSummary ? (
                  <div className="mt-0.5 text-xs text-muted-foreground">{renderSummary(row)}</div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {statusField ? (
                  <StatusPill tone={isActive(row) ? "success" : "default"}>
                    {isActive(row) ? activeLabel : inactiveLabel}
                  </StatusPill>
                ) : null}
                {canEdit ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(row)}>
                      <Pencil className="mr-1.5 size-3.5" />
                      Edit
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`More actions for ${String(row[labelField] ?? "this record")}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {statusField ? (
                          isActive(row) ? (
                            <DropdownMenuItem onSelect={() => setRetiring(row)}>
                              Deactivate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onSelect={() => setStatus.mutate({ row, active: true })}
                            >
                              Reactivate
                            </DropdownMenuItem>
                          )
                        ) : null}
                        {/* Permanent removal is an administrator act in the
                            database, so the control is simply absent for
                            everyone else rather than failing on use. */}
                        {isAdmin ? (
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={Boolean(statusField) && isActive(row)}
                            onSelect={() => setRemoving(row)}
                          >
                            Delete permanently
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (open) return;
          setEditing(null);
          setCreating(false);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${singular.toLowerCase()}` : `New ${singular.toLowerCase()}`}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields
              .filter((field) => !field.readOnly && (field.showWhen ? field.showWhen(form) : true))
              .map((field) => (
                <div
                  key={field.name}
                  className={field.type === "textarea" || field.type === "list" ? "sm:col-span-2 space-y-2" : "space-y-2"}
                >
                  <Label htmlFor={`config-${field.name}`}>
                    {field.label}
                    {field.required ? <span className="ml-1 text-destructive">*</span> : null}
                  </Label>
                  {field.type === "textarea" ? (
                    <Textarea
                      id={`config-${field.name}`}
                      value={String(form[field.name] ?? "")}
                      placeholder={field.placeholder}
                      onChange={(event) => setForm((f) => ({ ...f, [field.name]: event.target.value }))}
                    />
                  ) : field.type === "switch" ? (
                    <div className="flex h-10 items-center">
                      <Switch
                        id={`config-${field.name}`}
                        checked={Boolean(form[field.name])}
                        onCheckedChange={(checked) => setForm((f) => ({ ...f, [field.name]: checked }))}
                      />
                    </div>
                  ) : field.type === "select" ? (
                    <Select
                      value={String(form[field.name] ?? "")}
                      onValueChange={(value) =>
                        setForm((f) => {
                          const next = { ...f, [field.name]: value };
                          // Changing the parent clears any child that belongs to
                          // a different parent. A child with no parent of its own
                          // (an ungrouped category) is never cleared — it stays
                          // selectable whatever the parent says.
                          for (const child of fields) {
                            if (child.dependsOn !== field.name) continue;
                            const kept = (lookups.data?.[child.name] ?? []).find(
                              (o) => o.value === String(f[child.name] ?? ""),
                            );
                            if (kept && kept.parent && kept.parent !== value) next[child.name] = "";
                          }
                          return next;
                        })
                      }
                    >
                      <SelectTrigger id={`config-${field.name}`}>
                        <SelectValue placeholder={field.placeholder ?? "Select"} />
                      </SelectTrigger>
                      <SelectContent>
                        {(field.lookup ? (lookups.data?.[field.name] ?? []) : (field.options ?? []))
                          .filter((option) => {
                            if (!field.dependsOn) return true;
                            const parent = (option as { parent?: string | null }).parent ?? null;
                            const chosen = form[field.dependsOn];
                            // No parent chosen yet: every option is offered.
                            // A parent chosen: its own options, plus options that
                            // belong to no parent, so an ungrouped category such
                            // as Whiskey or Single Malt can still be selected.
                            if (!chosen) return true;
                            return parent === null || parent === chosen;
                          })
                          .map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}

                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={`config-${field.name}`}
                      type={
                        field.type === "number" || field.type === "money"
                          ? "number"
                          : field.type === "time"
                            ? "time"
                            : field.type === "date"
                              ? "date"
                              : "text"
                      }
                      value={String(form[field.name] ?? "")}
                      placeholder={field.placeholder}
                      onChange={(event) => setForm((f) => ({ ...f, [field.name]: event.target.value }))}
                    />
                  )}
                  {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
                </div>
              ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null);
                setCreating(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={missingRequired || save.isPending}
              onClick={() => save.mutate({ row: editing, values: form })}
            >
              {save.isPending ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Save {singular.toLowerCase()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmAction
        open={retiring !== null}
        onOpenChange={(open) => (open ? undefined : setRetiring(null))}
        title={`Deactivate ${singular.toLowerCase()}`}
        recordName={retiring ? String(retiring[labelField] ?? "Untitled") : undefined}
        description={`It stops being offered on new transactions from now on. Every existing record that already refers to it — documents, history and reports — is left exactly as it is.`}
        impact="You can reactivate it at any time."
        confirmLabel="Deactivate"
        pending={setStatus.isPending}
        onConfirm={() => {
          if (retiring) setStatus.mutate({ row: retiring, active: false });
        }}
      />

      <ConfirmAction
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={`Delete ${singular.toLowerCase()}`}
        recordName={removing ? String(removing[labelField] ?? "Untitled") : undefined}
        description="This removes the record for good and cannot be undone."
        impact="If anything already refers to it, the deletion is refused and the record simply stays deactivated."
        confirmLabel="Delete permanently"
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing);
        }}
      />
    </SectionCard>
  );
}
