import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261105163000_department_store_consumption_hardening.sql",
  "utf8",
);

describe("authoritative departmental-store consumption", () => {
  it("uses only the explicit station consumption mapping", () => {
    expect(migration).toContain(
      "public.neo_station_consumption_location",
    );
    expect(migration).toContain(
      "v_line_location := v_location;",
    );

    expect(migration).not.toContain(
      "v_menu.issuing_location_id",
    );
    expect(migration).not.toContain(
      "public.neo_item_group_store(",
    );
  });

  it("maps the exact Nairobi production stations to departmental stores", () => {
    expect(migration).toContain(
      "ac11408c-fc97-52e2-a2e3-23f4669d1f82",
    );
    expect(migration).toContain(
      "86b07744-d9f5-5a25-ac26-47155a1c7346",
    );
    expect(migration).toContain(
      "4089c5bd-d136-569a-88ad-ff07df20794a",
    );
    expect(migration).toContain(
      "732adf15-c3a4-5f61-8686-15c9ab5cece3",
    );
    expect(migration).toContain(
      "Operational POS consumption resolved to Main Store",
    );
  });

  it("targets only the three inspected Nairobi ingredient rows", () => {
    expect(migration).toContain(
      "71ccafb0-81c9-4c57-bf92-f0d566d55c2c",
    );
    expect(migration).toContain(
      "692a01d7-a7f0-4c0d-bcba-b87158522b55",
    );
    expect(migration).toContain(
      "cb562c84-b7fa-4348-b2c0-cac1c375d7ba",
    );

    expect(migration).toContain("FI-FRUIT-002");
    expect(migration).toContain("SCN-BEEFM");
    expect(migration).toContain("SCN-COOKIN");
  });

  it("aligns exactly the five inspected Nairobi recipes", () => {
    for (const recipeId of [
      "d7ba1a7b-1096-55e2-b773-0708798b27df",
      "68181b00-2bba-5e8c-af62-d89cc6c94318",
      "bae1b65b-dd5f-57c5-814e-a9d079729e4a",
      "9e95e403-9583-5cfd-8289-dda01a271a70",
      "c7bd8599-803e-5050-9ecb-1d38093cbe51",
    ]) {
      expect(migration).toContain(recipeId);
    }

    expect(migration).toContain(
      "Expected five exact Nairobi recipe station alignments",
    );
  });

  it("does not scope repairs to Mombasa or Taveta branches", () => {
    expect(migration).toContain(
      "2addbd01-c643-406a-bd7d-fac1aa76b23c",
    );
    expect(migration).not.toContain(
      "059ac4e7-36b6-542f-b09a-2923a0ce4688",
    );
    expect(migration).not.toContain(
      "6ba41f3d-f0da-5e1a-b180-bf421f29dd89",
    );
  });
});
