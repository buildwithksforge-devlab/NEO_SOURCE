/** Display the configured garment rate; the intake RPC remains authoritative. */
export function laundryCatalogueRate(
  item: Record<string, unknown> | null | undefined,
  express: boolean,
): number {
  if (!item) return 0;
  const normal = Number(item["normal_price"] ?? 0);
  const priority = Number(item["express_price"] ?? 0);
  const rate = express && priority > 0 ? priority : normal;
  return Number.isFinite(rate) && rate >= 0 ? rate : 0;
}
