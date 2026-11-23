import { FormDialog } from "@/components/finance/FinanceShared";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { useDeleteTaxConfiguration } from "@/lib/finance-data";

export function DeleteArchivedTaxConfiguration({
  table, id, name, onDeleted,
}: {
  table: "tax_codes" | "sales_tax_profiles";
  id: string;
  name: string;
  onDeleted?: () => void;
}) {
  const { isAdmin } = useAuth();
  const remove = useDeleteTaxConfiguration(table);
  if (!isAdmin) return null;

  return (
    <FormDialog
      trigger={<Button variant="ghost" size="sm">Delete</Button>}
      title={`Delete ${name}?`}
      description="This permanently removes the archived setup if it is unused. References in sales, accounts or invoices prevent deletion."
    >
      {(close) => (
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={remove.isPending} onClick={close}>Cancel</Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(id, {
            onSuccess: () => { onDeleted?.(); close(); },
          })}>
            {remove.isPending ? "Deleting…" : "Delete permanently"}
          </Button>
        </div>
      )}
    </FormDialog>
  );
}
