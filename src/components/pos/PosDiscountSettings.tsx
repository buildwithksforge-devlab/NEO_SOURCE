import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { ORDER_TYPES, type OrderType } from "@/lib/pos";
import { supabase } from "@/integrations/supabase/client";

export function PosDiscountSettings() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"percentage" | "fixed">("percentage");
  const [value, setValue] = useState("");
  const [cap, setCap] = useState("");
  const [approval, setApproval] = useState(true);
  const [orderTypes, setOrderTypes] = useState<OrderType[]>([]);
  const policies = useQuery({
    queryKey: ["pos", "discount-settings", organizationId, branchId],
    enabled: Boolean(organizationId && branchId),
    queryFn: async () => {
      const { data, error } = await supabase.from("pos_discounts")
        .select("id,name,discount_type,value,max_value,requires_approval,active")
        .eq("organization_id", organizationId!).eq("branch_id", branchId!).order("name");
      if (error) throw error;
      return data;
    },
  });
  const amount = Number(value);
  const maximum = cap.trim() ? Number(cap) : null;
  const valid = Boolean(name.trim() && value.trim() && Number.isFinite(amount) && amount > 0 &&
    (mode !== "percentage" || amount <= 100) &&
    (maximum === null || (Number.isFinite(maximum) && maximum > 0)));
  const save = useMutation({
    mutationFn: async (change: { id: string; active: boolean } | null) => {
      if (!organizationId || !branchId) throw new Error("Select a property first.");
      const table = supabase.from("pos_discounts");
      if (!change && !valid) throw new Error("Enter a valid discount name, amount and optional cap.");
      const request = change
        ? table.update({ active: change.active }).eq("id", change.id)
          .eq("organization_id", organizationId).eq("branch_id", branchId)
        : table.insert({
          organization_id: organizationId, branch_id: branchId, name: name.trim(),
          scope: "bill", discount_type: mode, value: amount, max_value: maximum,
          requires_approval: approval, order_types: orderTypes, active: true,
        });
      const { error } = await request.select("id").single();
      if (error) throw error;
    },
    onSuccess: async (_, change) => {
      if (!change) { setName(""); setValue(""); setCap(""); setOrderTypes([]); }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pos", "discount-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["pos", "discount-policies"] }),
      ]);
    },
  });

  return (
    <SectionCard title="Bill discounts" description="Set which discounts this property offers at the till. Approval permissions govern who may apply them.">
      {!branchId ? <p>Select a property to manage its discounts.</p> : (
        <div key={branchId} className="space-y-4">
          {policies.isPending ? <p role="status">Loading discounts…</p> : null}
          {policies.isError ? <p role="alert">Discounts could not be loaded. <Button variant="link" onClick={() => void policies.refetch()}>Retry</Button></p> : null}
          {policies.isSuccess && policies.data.length === 0 ? <p>No property discounts configured.</p> : null}
          {policies.data?.map((policy) => (
            <div key={policy.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
              <span>{policy.name} · {policy.value}{policy.discount_type === "percentage" ? "%" : ""}{policy.requires_approval ? " · Approval required" : ""}</span>
              <Button variant="outline" size="sm" disabled={save.isPending}
                onClick={() => save.mutate({ id: policy.id, active: !policy.active })}>
                {policy.active ? "Deactivate" : "Activate"} {policy.name}
              </Button>
            </div>
          ))}
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => {
            event.preventDefault();
            if (valid && !save.isPending) save.mutate(null);
          }}>
            <label>Name<Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required /></label>
            <label>Type
              <select className="block h-9 w-full rounded-md border bg-background px-2" value={mode}
                onChange={(event) => setMode(event.target.value === "fixed" ? "fixed" : "percentage")}>
                <option value="percentage">Percentage</option><option value="fixed">Fixed amount</option>
              </select>
            </label>
            <label>Discount value<Input type="number" min="0.01" step="0.01" value={value}
              max={mode === "percentage" ? 100 : undefined} onChange={(event) => setValue(event.target.value)} required /></label>
            <label>Maximum discount amount (optional)<Input type="number" min="0.01" step="0.01"
              value={cap} onChange={(event) => setCap(event.target.value)} /></label>
            <fieldset className="space-y-2 sm:col-span-2">
              <legend>Order types (leave blank for all)</legend>
              <div className="flex flex-wrap gap-3">
                {ORDER_TYPES.map((type) => (
                  <label key={type} className="flex items-center gap-2">
                    <input type="checkbox" checked={orderTypes.includes(type)} onChange={(event) => {
                      const checked = event.target.checked;
                      setOrderTypes((current) => checked ? [...current, type] : current.filter((value) => value !== type));
                    }} />
                    {type.replaceAll("-", " ")}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex items-center gap-2"><input type="checkbox" checked={approval}
              onChange={(event) => setApproval(event.target.checked)} /> Require approval</label>
            <Button type="submit" disabled={!valid || save.isPending}>Add discount</Button>
          </form>
          {save.isError ? <p role="alert">{save.error.message}</p> : null}
        </div>
      )}
    </SectionCard>
  );
}
