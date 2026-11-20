import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useMenuSalesTaxProfile, useSalesTaxProfiles } from "@/lib/finance-data";
import { guardedRpc } from "@/lib/rpc-guard";
import { useSaveRecord } from "@/lib/pos-data";
import { formatDocumentMoney } from "@/lib/document-identity";

type TaxPreview = {
  net: number;
  total: number;
  taxes: { code: string; name: string; amount: number; inclusive: boolean }[];
};

export function MenuSalesTaxCard({ itemId, currency, manage }: { itemId: string; currency: string; manage: boolean }) {
  const saved = useMenuSalesTaxProfile(itemId);
  const profiles = useSalesTaxProfiles();
  const save = useSaveRecord("menu_items");
  const [draft, setDraft] = useState<string | null>(null);
  const selected = draft ?? saved.data ?? "";
  const preview = useQuery({
    queryKey: ["pos", "sales-tax-preview", itemId, selected, profiles.dataUpdatedAt],
    enabled: saved.isSuccess && profiles.isSuccess,
    queryFn: async () => {
      const { data, error } = await guardedRpc<TaxPreview | null>(supabase, "neo_preview_menu_sales_tax", {
        _item: itemId, _profile: selected || null,
      });
      if (error) throw error;
      return data;
    },
  });
  const money = (value: number) => formatDocumentMoney(value, currency);
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <Label htmlFor="menu-tax-profile">Sales tax profile</Label>
      {saved.error || profiles.error ? (
        <p role="alert">Tax profiles could not be loaded for this menu item.</p>
      ) : <>
        <select id="menu-tax-profile" className="h-9 w-full rounded border bg-background px-2"
          disabled={!manage || saved.isLoading || profiles.isLoading} value={selected} onChange={(event) => setDraft(event.target.value)}>
          <option value="">Use category or workspace default</option>
          {(profiles.data ?? []).filter((profile) => profile.active || profile.id === saved.data).map((profile) =>
            <option key={profile.id} value={profile.id} disabled={!profile.active}>{profile.name}</option>
          )}
        </select>
        {preview.error && <p role="alert">This profile is unavailable for the item’s property and pricing date.</p>}
        {preview.data && <dl className="space-y-1 rounded-md bg-muted/50 p-2">
          <div className="flex justify-between"><dt>Net before tax</dt><dd>{money(preview.data.net)}</dd></div>
          {preview.data.taxes.map((tax) => <div key={tax.code} className="flex justify-between gap-2">
            <dt>{tax.name} · {tax.inclusive ? "Included" : "Added"}</dt><dd>{money(tax.amount)}</dd>
          </div>)}
          <div className="flex justify-between font-semibold"><dt>Selling total</dt><dd>{money(preview.data.total)}</dd></div>
        </dl>}
        {manage && draft !== null && draft !== saved.data && (
          <Button size="sm" disabled={save.isPending || preview.isPending || preview.isError} onClick={() =>
            save.mutate({ id: itemId, values: { sales_tax_profile_id: selected || null } }, {
              onSuccess: async () => { await saved.refetch(); setDraft(null); },
            })
          }>Save tax profile</Button>
        )}
      </>}
    </div>
  );
}
