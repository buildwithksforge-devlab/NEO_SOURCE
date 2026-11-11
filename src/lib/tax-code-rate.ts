/** Finance tax_codes.rate is a fraction (seeded VAT16 = 0.16). Menu tax_rate uses separate units. */
export function taxCodeFractionFromPercent(value: unknown): number {
  if(value === null || value === undefined || String(value).trim() === '') throw new Error('Enter the tax rate as a percentage.');
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>100) throw new Error('Tax rate must be between 0% and 100%.');
  const fraction=n/100;
  if(Math.abs(fraction*10000-Math.round(fraction*10000))>0.000001) throw new Error('Enter the percentage to at most two decimal places.');
  return fraction;
}
export function formatTaxCodeRate(value: unknown): string {
  if(value === null || value === undefined || String(value).trim() === '') return 'Not recorded';
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>1) return 'Review stored rate';
  return new Intl.NumberFormat('en-KE',{style:'percent',maximumFractionDigits:2}).format(n);
}
