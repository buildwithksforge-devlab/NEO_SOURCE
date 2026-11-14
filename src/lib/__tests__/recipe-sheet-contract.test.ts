import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { prepareRecipeSheet } from "@/lib/recipe-engine";
import {
  emptyIngredientRow,
  isRowComplete,
  rowsAreValid,
} from "@/components/kitchen/IngredientRows";

const recipeMaster = readFileSync("src/lib/recipe-master.ts", "utf8");
const kitchenData = readFileSync("src/lib/kitchen-data.ts", "utf8");
const recipesRoute = readFileSync("src/routes/_shell.kitchen.recipes.tsx", "utf8");

describe("recipe ingredient embed", () => {
  it("disambiguates recipe_ingredients, which has two foreign keys to recipes", () => {
    for (const source of [recipeMaster, kitchenData]) {
      expect(source).toContain("recipe_ingredients!recipe_ingredients_recipe_id_fkey");
      expect(source).not.toMatch(/[^!]recipe_ingredients\(/);
    }
  });
});

describe("grouped recipe spreadsheet review", () => {
  const masters = {
    menuItems: [
      { id: "m1", name: "Rice dish" },
      { id: "m2", name: "Soup" },
    ],
    stockItems: [
      { id: "s1", sku: "RICE", name: "Rice" },
      { id: "s2", sku: "SALT", name: "Salt" },
    ],
    subRecipes: [],
    stations: [],
  };
  const row = (extra: Record<string, string> = {}) => ({
    recipe_code: "R1",
    recipe_name: "Rice dish",
    menu_item: "Rice dish",
    yield_quantity: "2",
    yield_unit: "portion",
    ingredient: "RICE",
    quantity: "200",
    unit: "g",
    ...extra,
  });
  it("groups differing ingredient counts into complete dishes", () => {
    const groups = prepareRecipeSheet(
      [
        row(),
        row({ ingredient: "SALT", quantity: "2" }),
        row({ recipe_code: "R2", recipe_name: "Soup", menu_item: "Soup" }),
      ],
      masters,
    );
    expect(groups.map((g) => g.recipe.components.length)).toEqual([2, 1]);
    expect(groups.every((g) => !g.errors.length)).toBe(true);
  });
  it("keeps name-only continuation rows with their explicitly coded dish", () => {
    const groups = prepareRecipeSheet(
      [row(), row({ recipe_code: "", ingredient: "SALT", quantity: "2" })],
      masters,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.recipe.components).toHaveLength(2);
    expect(groups[0]!.errors).toEqual([]);
  });
  it("blocks the whole dish when any ingredient is unknown or a header conflicts", () => {
    const groups = prepareRecipeSheet(
      [row(), row({ ingredient: "UNKNOWN", yield_quantity: "3" })],
      masters,
    );
    expect(groups[0]!.errors.join(" ")).toMatch(/conflicting yield/);
    expect(groups[0]!.errors.join(" ")).toMatch(/does not match/);
  });
  it("does not silently choose between ambiguous stock names", () => {
    const groups = prepareRecipeSheet([row({ ingredient: "Rice" })], {
      ...masters,
      stockItems: [...masters.stockItems, { id: "s3", sku: "RICE-OTHER", name: "Rice" }],
    });
    expect(groups[0]!.errors.join(" ")).toContain("ambiguous");
  });
  it("does not import partial dishes when ingredient rows have no dish identity", () => {
    const groups = prepareRecipeSheet(
      [row(), row({ recipe_code: "", recipe_name: "", menu_item: "", ingredient: "SALT" })],
      masters,
    );
    expect(groups.every((g) => g.errors.some((e) => e.includes("unassigned")))).toBe(true);
  });
  it("requires explicit correction of duplicated or fractional whole-item ingredients", () => {
    const group = prepareRecipeSheet([row(), row({ quantity: "0.5", unit: "piece" })], masters)[0]!;
    expect(group.errors.join(" ")).toMatch(/duplicate component/);
    expect(group.errors.length).toBeGreaterThan(1);
  });
});

describe("atomic recipe sheets and canonical approval", () => {
  let db: PGlite;
  const org = "00000000-0000-4000-8000-000000000001",
    branch = "00000000-0000-4000-8000-000000000002",
    actor = "00000000-0000-4000-8000-000000000003";
  const menu = "00000000-0000-4000-8000-000000000010",
    category = "00000000-0000-4000-8000-000000000011",
    stock = "00000000-0000-4000-8000-000000000012",
    foreign = "00000000-0000-4000-8000-000000000013";
  const migration = readFileSync(
    "supabase/migrations/20261113100000_atomic_recipe_sheets.sql",
    "utf8",
  );
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT CASE WHEN $2='recipes.approve' THEN coalesce(current_setting('test.recipe_approve',true),'yes')='yes' ELSE true END $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid AND coalesce(current_setting('test.recipe_scope',true),'yes')='yes' $$;
      CREATE TABLE menu_categories(id uuid PRIMARY KEY,organization_id uuid);
      CREATE TABLE operational_stations(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid);
      CREATE TABLE stock_items(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,name text,sku text,base_unit text,created_at timestamptz DEFAULT now());
      CREATE TABLE menu_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,category_id uuid,name text,base_price numeric,station_id uuid,
        consumption_mode text DEFAULT 'none',stock_item_id uuid,publish_status text DEFAULT 'draft',created_by uuid);
      CREATE TABLE recipes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,name text,recipe_code text,recipe_type text,menu_item_id uuid REFERENCES menu_items(id),
        station_id uuid,output_stock_item_id uuid,yield_quantity numeric,yield_unit text,prep_target_minutes integer,preparation_steps text,status text DEFAULT 'draft',version integer DEFAULT 1,
        created_by uuid,approved_by uuid,approved_at timestamptz,effective_to timestamptz,updated_at timestamptz,supersedes_id uuid);
      CREATE UNIQUE INDEX recipes_org_code_uidx ON recipes(organization_id,lower(recipe_code)) WHERE recipe_code IS NOT NULL;
      CREATE TABLE recipe_ingredients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,recipe_id uuid REFERENCES recipes(id),component_type text,
        stock_item_id uuid,sub_recipe_id uuid,ingredient_name text,quantity numeric,unit text,waste_allowance numeric,inventory_item_ref text);
      CREATE FUNCTION inventory_convert_strict(numeric,text,text) RETURNS numeric LANGUAGE plpgsql AS $$ BEGIN
        IF lower($2)=lower($3) THEN RETURN $1; END IF;
        IF lower($2)='g' AND lower($3)='kg' THEN RETURN $1/1000; END IF;
        IF lower($2)='kg' AND lower($3)='g' THEN RETURN $1*1000; END IF;
        RAISE EXCEPTION 'Incompatible ingredient units'; END $$;
      CREATE FUNCTION inventory_convert_for_item(numeric,text,text,uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT inventory_convert_strict($1,$2,$3) $$;
      CREATE FUNCTION inventory_round_for_item(numeric,text,uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT $1 $$;
      GRANT SELECT,INSERT,UPDATE,DELETE ON menu_items,recipes,recipe_ingredients TO authenticated;
      GRANT SELECT ON menu_categories,stock_items,operational_stations TO authenticated;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
      CREATE POLICY recipes_scope ON recipes TO authenticated USING(organization_id=current_org_id() AND (branch_id IS NULL OR neo_branch_in_scope(branch_id)))
        WITH CHECK(organization_id=current_org_id() AND (branch_id IS NULL OR neo_branch_in_scope(branch_id)));
    `);
    const canonicalSource = readFileSync(
      "supabase/migrations/" +
        readdirSync("supabase/migrations").find((f) => f.startsWith("20260914142842")),
      "utf8",
    );
    const canonical = canonicalSource.match(
      /CREATE OR REPLACE FUNCTION public\.recipe_expand_to_stock_kinds\([\s\S]*?\n\$\$;/,
    )?.[0];
    if (!canonical) throw Error("Canonical expansion source missing");
    await db.exec(canonical);
    await db.exec(migration);
    await db.exec(`CREATE FUNCTION test_menu_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('test.recipe_binding_fail',true)='yes' AND NEW.consumption_mode='recipe' THEN RAISE EXCEPTION 'Menu binding failed'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER test_menu_binding BEFORE UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION test_menu_failure();`);
  }, 30000);
  beforeEach(async () => {
    await db.exec(`TRUNCATE neo_recipe_sheet_attempts,recipe_ingredients,recipes,menu_items,menu_categories,stock_items,operational_stations;
      SELECT set_config('test.recipe_approve','yes',false),set_config('test.recipe_scope','yes',false),set_config('test.recipe_binding_fail','no',false);
      INSERT INTO menu_categories VALUES('${category}','${org}');
      INSERT INTO menu_items(id,organization_id,branch_id,category_id,name,base_price,consumption_mode) VALUES('${menu}','${org}','${branch}','${category}','Rice dish',100,'none');
      INSERT INTO stock_items VALUES('${stock}','${org}','${branch}','Rice','RICE','kg'),('${foreign}','${actor}','${actor}','Foreign','FOREIGN','kg');`);
  });
  afterAll(async () => {
    await db.close();
  });
  const header = (extra: Record<string, unknown> = {}) => ({
    name: "Rice recipe",
    branch_id: branch,
    recipe_type: "menu_item",
    menu_item_id: menu,
    yield_quantity: 2,
    yield_unit: "portion",
    ...extra,
  });
  const ingredient = (extra: Record<string, unknown> = {}) => ({
    component_type: "stock_item",
    stock_item_id: stock,
    ingredient_name: "Rice",
    quantity: 200,
    unit: "g",
    waste_allowance: 0,
    ...extra,
  });
  const save = async (
    h = header(),
    components: Record<string, unknown>[] | null = [ingredient()],
    attempt: string | null = crypto.randomUUID(),
  ) => {
    const r = await db.query<{ r: { recipe_id: string; replayed: boolean } }>(
      "SELECT neo_recipe_sheet_save($1::jsonb,$2::jsonb,$3) r",
      [JSON.stringify(h), components === null ? null : JSON.stringify(components), attempt],
    );
    return r.rows[0]!.r;
  };
  const activate = (id: string) => db.query("SELECT neo_recipe_activate($1,NULL)", [id]);
  it("saves header and complete components once, with a real authenticated caller and RLS", async () => {
    await db.exec("SET ROLE authenticated");
    try {
      const attempt = crypto.randomUUID();
      const first = await save(header(), [ingredient()], attempt);
      expect((await save(header(), [ingredient()], attempt)).recipe_id).toBe(first.recipe_id);
      expect((await db.query("SELECT count(*)::int n FROM recipe_ingredients")).rows[0]).toEqual({
        n: 1,
      });
      await expect(save(header({ name: "Changed" }), [ingredient()], attempt)).rejects.toThrow(
        "different input",
      );
    } finally {
      await db.exec("RESET ROLE");
    }
  });
  it("reuses a repeated imported dish even when ingredient order changes", async () => {
    const first = await save(header(), [ingredient()], null);
    const second = await save(header(), [ingredient()], null);
    expect(second.recipe_id).toBe(first.recipe_id);
    expect(second.replayed).toBe(true);
  });
  it("rolls back a newly created menu, header and earlier components if a later ingredient is invalid", async () => {
    await expect(
      save(header({ menu_item_id: null, new_menu_item: { category_id: category, price: 100 } }), [
        ingredient(),
        ingredient({ stock_item_id: foreign }),
      ]),
    ).rejects.toThrow("in-scope stock");
    expect((await db.query("SELECT count(*)::int n FROM recipes")).rows[0]).toEqual({ n: 0 });
    expect((await db.query("SELECT count(*)::int n FROM recipe_ingredients")).rows[0]).toEqual({
      n: 0,
    });
    expect((await db.query("SELECT count(*)::int n FROM menu_items")).rows[0]).toEqual({ n: 1 });
  });
  it("rejects conflicting properties and duplicate component rows before any lasting recipe exists", async () => {
    await expect(save(header({ branch_id: actor }))).rejects.toThrow("outside your access");
    await expect(save(header(), [ingredient(), ingredient()])).rejects.toThrow(
      "Duplicate ingredient",
    );
    expect((await db.query("SELECT count(*)::int n FROM recipes")).rows[0]).toEqual({ n: 0 });
  });
  it("keeps the previous version active when canonical ingredient-unit validation fails", async () => {
    const old = await save();
    await activate(old.recipe_id);
    const next = await save(header(), [ingredient({ unit: "ml" })]);
    await expect(activate(next.recipe_id)).rejects.toThrow("Incompatible ingredient units");
    const statuses = (
      await db.query<{ id: string; status: string }>(
        "SELECT id,status FROM recipes ORDER BY version",
      )
    ).rows;
    expect(statuses.map((r) => r.status)).toEqual(["active", "draft"]);
    expect((await db.query("SELECT consumption_mode FROM menu_items")).rows[0]).toEqual({
      consumption_mode: "recipe",
    });
  });
  it("rolls back version switching when menu binding fails", async () => {
    const old = await save();
    await activate(old.recipe_id);
    const next = await save();
    await db.exec("SELECT set_config('test.recipe_binding_fail','yes',false)");
    await expect(activate(next.recipe_id)).rejects.toThrow("Menu binding failed");
    expect((await db.query("SELECT status FROM recipes ORDER BY version")).rows).toEqual([
      { status: "active" },
      { status: "draft" },
    ]);
  });
  it("activates exactly one version and expands the actual canonical recipe without moving stock", async () => {
    const old = await save();
    await activate(old.recipe_id);
    const next = await save();
    await activate(next.recipe_id);
    await activate(next.recipe_id);
    expect((await db.query("SELECT status FROM recipes ORDER BY version")).rows).toEqual([
      { status: "superseded" },
      { status: "active" },
    ]);
    const expanded = await db.query<{ quantity: string }>(
      "SELECT quantity FROM recipe_expand_to_stock_kinds($1,1,$2,'{}'::uuid[])",
      [next.recipe_id, branch],
    );
    expect(Number(expanded.rows[0]!.quantity)).toBeCloseTo(0.2);
  });
  it("denies approval without its permission, and denies an empty ingredient sheet", async () => {
    const draft = await save();
    await db.exec("SELECT set_config('test.recipe_approve','no',false)");
    await expect(activate(draft.recipe_id)).rejects.toThrow("Not permitted");
    await db.exec("SELECT set_config('test.recipe_approve','yes',false)");
    const empty = await save(header(), []);
    await expect(activate(empty.recipe_id)).rejects.toThrow("complete ingredient sheet");
  });
  it("preserves approved header and ingredient history against direct edits", async () => {
    const draft = await save();
    await activate(draft.recipe_id);
    await expect(
      db.query("UPDATE recipes SET yield_quantity=3 WHERE id=$1", [draft.recipe_id]),
    ).rejects.toThrow("new draft version");
    await expect(
      db.query("DELETE FROM recipe_ingredients WHERE recipe_id=$1", [draft.recipe_id]),
    ).rejects.toThrow("draft version");
    await expect(
      db.query("UPDATE recipes SET status='draft' WHERE id=$1", [draft.recipe_id]),
    ).rejects.toThrow("new draft version");
  });
  it("prevents bypassing atomic approval through a direct status update", async () => {
    const draft = await save();
    await expect(
      db.query("UPDATE recipes SET status='active' WHERE id=$1", [draft.recipe_id]),
    ).rejects.toThrow("atomic recipe approval");
  });
});

describe("repeatable ingredient sheet", () => {
  it("adds an independent row each time", () => {
    const rows = [emptyIngredientRow(), emptyIngredientRow(), emptyIngredientRow()];
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("requires a component, a positive quantity and a unit per row", () => {
    const row = emptyIngredientRow();
    expect(isRowComplete(row)).toBe(false);
    expect(isRowComplete({ ...row, stockItemId: "s1", quantity: "0" })).toBe(false);
    expect(isRowComplete({ ...row, stockItemId: "s1", quantity: "200", unit: "g" })).toBe(true);
    expect(
      isRowComplete({
        ...row,
        componentType: "sub_recipe",
        subRecipeId: "r1",
        quantity: "20",
        unit: "ml",
      }),
    ).toBe(true);
  });

  it("rejects a partially completed sheet", () => {
    const good = { ...emptyIngredientRow(), stockItemId: "s1", quantity: "200", unit: "g" };
    const bad = { ...emptyIngredientRow(), quantity: "30" };
    expect(rowsAreValid([good])).toBe(true);
    expect(rowsAreValid([good, bad])).toBe(false);
    expect(rowsAreValid([])).toBe(false);
  });

  it("writes the whole sheet in one insert from the recipe form", () => {
    expect(recipeMaster).toContain("useSaveRecipeComponents");
    expect(recipesRoute).toContain("<IngredientRows");
    expect(recipesRoute).toContain("saveComponents.mutateAsync");
  });
});
