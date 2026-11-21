import { useState } from "react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFinanceInsert, useFinanceUpdate, useSalesTaxProfiles, useTaxCodes } from "@/lib/finance-data";
import { useMenuCategories, useSaveRecord } from "@/lib/pos-data";

export function SalesTaxProfiles() {
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [treatment, setTreatment] = useState<"standard" | "exempt" | "none">("standard");
  const [rules, setRules] = useState<{ code: string; compound_on_prior: boolean }[]>([]);
  const [selectedCode, setSelectedCode] = useState("");
  const [workspaceDefault, setWorkspaceDefault] = useState(false);
  const profiles = useSalesTaxProfiles();
  const codes = useTaxCodes();
  const categories = useMenuCategories();
  const saveCategory = useSaveRecord("menu_categories");
  const [categoryId, setCategoryId] = useState("");
  const [categoryDraft, setCategoryDraft] = useState<string | null>(null);
  const category = categories.data?.find((entry) => entry.id === categoryId) as
    { sales_tax_profile_id?: string | null } | undefined;
  const categoryProfile = categoryDraft ?? category?.sales_tax_profile_id ?? "";
  const create = useFinanceInsert("sales_tax_profiles", "finance.sales_tax_profile.created", { branchScoped: false });
  const update = useFinanceUpdate("sales_tax_profiles", "finance.sales_tax_profile.updated");
  const options = [...new Map((codes.data ?? [])
    .filter((code) => ["standard", "zero_rated", "exempt"].includes(String(code["treatment"])))
    .map((code) => [String(code["code"]), String(code["name"])] as const))];
  const reset = () => {
    setEditing(""); setName(""); setTreatment("standard"); setRules([]); setSelectedCode(""); setWorkspaceDefault(false);
  };
  const save = async () => {
    const values = { name: name.trim(), treatment, workspace_default: workspaceDefault, rules: treatment === "standard" ? rules : [] };
    if (editing) await update.mutateAsync({ id: editing, values });
    else await create.mutateAsync(values);
    await profiles.refetch();
    reset();
  };
  return (
    <SectionCard title="Sales tax profiles" description="Group effective-dated tax codes for menu items. The rule order determines which taxes a compound rule includes in its base.">
      {profiles.error && <p role="alert">{profiles.error.message}</p>}
      {profiles.isSuccess && !profiles.data.some((profile) => profile.active) ? (
        <p role="status" className="mb-4 rounded-md border p-3 text-sm">
          No active sales tax profiles. Create a profile with the approved tax codes and assign it to menu items,
          a category, or the workspace default to save a named tax breakdown on new sales.
        </p>
      ) : null}
      <ul className="mb-4 divide-y">
        {(profiles.data ?? []).map((profile) => (
          <li key={profile.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <b>{profile.name}</b>
              <p className="text-sm text-muted-foreground">
                {profile.rules.map((rule) => rule.code).join(" → ") || (profile.treatment === "exempt" ? "Exempt" : "No tax")}
                {profile.active ? "" : " · Archived"}
                {profile.workspace_default ? " · Workspace default" : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                setEditing(profile.id); setName(profile.name); setTreatment(profile.treatment); setRules(profile.rules);
                setWorkspaceDefault(profile.workspace_default);
              }}>Edit</Button>
              <Button variant="outline" size="sm" disabled={update.isPending} onClick={() =>
                update.mutate({ id: profile.id, values: { active: !profile.active, workspace_default: false } }, { onSuccess: () => void profiles.refetch() })
              }>{profile.active ? "Archive" : "Activate"}</Button>
            </div>
          </li>
        ))}
      </ul>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save().catch(() => {}); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label htmlFor="tax-profile-name">Profile name</Label>
            <Input id="tax-profile-name" value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} />
          </div>
          <div><Label htmlFor="tax-profile-treatment">Treatment</Label>
            <select id="tax-profile-treatment" className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={treatment} onChange={(event) => {
                const value = event.target.value;
                if (value === "standard" || value === "exempt" || value === "none") setTreatment(value);
              }}>
              <option value="standard">Apply selected taxes</option><option value="exempt">Exempt</option><option value="none">No applicable tax</option>
            </select>
          </div>
        </div>
        <label className="flex gap-2 text-sm">
          <input type="checkbox" checked={workspaceDefault} onChange={(event) => setWorkspaceDefault(event.target.checked)} />
          Use as the workspace default for menu items without a category or item profile
        </label>
        {treatment === "standard" && <>
          <ol className="space-y-2">
            {rules.map((rule, index) => (
              <li key={rule.code} className="flex flex-wrap items-center gap-3 rounded-md border p-2 text-sm">
                <b>{index + 1}. {rule.code}</b>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={rule.compound_on_prior} disabled={index === 0} onChange={(event) =>
                    setRules(rules.map((entry) => entry.code === rule.code ? { ...entry, compound_on_prior: event.target.checked } : entry))
                  } /> Compound on earlier taxes
                </label>
                <Button size="sm" variant="ghost" type="button" onClick={() => setRules(rules.filter((entry) => entry.code !== rule.code))}>Remove</Button>
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <select aria-label="Tax code" className="min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
              value={selectedCode} onChange={(event) => setSelectedCode(event.target.value)}>
              <option value="">Choose a tax code</option>
              {options.filter(([code]) => !rules.some((rule) => rule.code === code)).map(([code, label]) =>
                <option key={code} value={code}>{code} · {label}</option>
              )}
            </select>
            <Button type="button" variant="outline" disabled={!selectedCode} onClick={() => {
              setRules([...rules, { code: selectedCode, compound_on_prior: false }]); setSelectedCode("");
            }}>Add tax</Button>
          </div>
        </>}
        <div className="flex gap-2">
          <Button type="submit" disabled={!name.trim() || (treatment === "standard" && !rules.length) || create.isPending || update.isPending}>
            {editing ? "Save profile" : "Create profile"}
          </Button>
          {editing && <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>}
        </div>
      </form>
      <div className="mt-6 space-y-3 border-t pt-4">
        <h3 className="font-semibold">Category assignment</h3>
        <p className="text-sm text-muted-foreground">Apply a profile to all items in a category that inherit their tax settings.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <select aria-label="Menu category" className="h-9 rounded-md border bg-background px-2 text-sm" value={categoryId}
            onChange={(event) => { setCategoryId(event.target.value); setCategoryDraft(null); }}>
            <option value="">Choose a menu category</option>
            {categories.data?.map((entry) => <option key={entry.id} value={entry.id}>{entry.menus?.name} · {entry.name}</option>)}
          </select>
          <select aria-label="Category tax profile" className="h-9 rounded-md border bg-background px-2 text-sm" value={categoryProfile}
            disabled={!categoryId} onChange={(event) => setCategoryDraft(event.target.value)}>
            <option value="">Use workspace default</option>
            {profiles.data?.filter((entry) => entry.active).map((entry) =>
              <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </div>
        <Button type="button" variant="outline" disabled={!categoryId || categoryDraft === null || saveCategory.isPending} onClick={() =>
          saveCategory.mutate({ id: categoryId, values: { sales_tax_profile_id: categoryProfile || null } },
            { onSuccess: async () => { await categories.refetch(); setCategoryDraft(null); } })
        }>Save category profile</Button>
      </div>
    </SectionCard>
  );
}
