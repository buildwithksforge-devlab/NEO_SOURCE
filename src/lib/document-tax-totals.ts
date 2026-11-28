type TaxTotal = { label: string; amount?: number | string | null; emphasis?: boolean; section?: "tax" };

const aggregateLabel = /^(?:tax|taxes|tax total|total taxes?|recorded tax(?: total)?)$/i;
const componentLabel = /(?:·\s*(?:Included|Added)$|\bVAT\b|\bGST\b|\blevy\b|\bexcise\b|\bwithholding tax\b)/i;

/** Keeps named saved components together and distinguishes them from the saved tax total. */
export function documentTaxTotals<T extends TaxTotal>(totals: T[]) {
  const valid = (row: T) => row.amount != null && row.amount !== "" && Number.isFinite(Number(row.amount));
  const isTax = (row: T) => row.section === "tax" || aggregateLabel.test(row.label.trim()) || componentLabel.test(row.label.trim());
  const taxRows = totals.filter((row) => valid(row) && isTax(row));
  if (!taxRows.length) return totals.map((row) => ({ row, tax: false }));

  const components = taxRows.filter((row) => !aggregateLabel.test(row.label.trim()));
  const aggregate = taxRows.find((row) => aggregateLabel.test(row.label.trim()));
  const detail = components.map((row) => ({ row, tax: true }));
  if (aggregate) {
    detail.push({ row: { ...aggregate, label: components.length ? "Recorded tax total" : "Recorded tax" }, tax: true });
  } else if (components.length > 1) {
    const cents = components.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
    detail.push({ row: { ...components[0]!, label: "Total tax", amount: cents / 100, emphasis: false }, tax: true });
  }

  const firstTax = totals.indexOf(taxRows[0]!);
  return totals.flatMap((row, index) => index === firstTax ? detail : isTax(row) ? [] : [{ row, tax: false }]);
}
