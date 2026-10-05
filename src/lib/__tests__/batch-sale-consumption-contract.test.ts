import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function migration(name: string) {
  return fs.readFileSync(path.join(ROOT, "supabase", "migrations", name), "utf8");
}

describe("prepared batch sale inventory contract", () => {
  const originalProduction = migration(
    "20260914061757_5b51bd95-a94e-47ff-923c-89b1abdc2319.sql",
  );

  const consumption = migration(
    "20260914142842_5565ae88-fbca-4377-b18c-ed272b397bec.sql",
  );

  it("documents that the old production posting deducts raw ingredients too early", () => {
    expect(originalProduction).toContain("'batchuse:' || _batch::text");
    expect(originalProduction).toContain(
      "v_recipe.output_stock_item_id, v_loc, v_b.actual_quantity",
    );
  });

  it("documents that the old batch sale path only consumes the prepared stock item", () => {
    expect(consumption).toContain("IF v_mode IN ('direct_stock','batch') THEN");
    expect(consumption).toContain(
      "'item_id', v_direct_item, 'qty', v_direct_qty",
    );
  });

  it("requires the replacement architecture to separate operational batch usage from canonical recipe consumption", () => {
    const files = fs
      .readdirSync(path.join(ROOT, "supabase", "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    const all = files
      .map((name) =>
        fs.readFileSync(path.join(ROOT, "supabase", "migrations", name), "utf8"),
      )
      .join("\n");

    expect(all).toContain("batch_component_log_only");
    expect(all).toContain("batch_operational_consumption");
    expect(all).toContain("batch_canonical_recipe_consumption");
  });
});