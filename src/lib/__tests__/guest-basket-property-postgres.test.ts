import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const org = "10000000-0000-4000-8000-000000000001";
const harbour = "10000000-0000-4000-8000-000000000002";
const garden = "10000000-0000-4000-8000-000000000003";
const foreign = "10000000-0000-4000-8000-000000000004";
const actor = "10000000-0000-4000-8000-000000000005";
const harbourDish = "10000000-0000-4000-8000-000000000006";
const gardenDish = "10000000-0000-4000-8000-000000000007";

describe("guest baskets across properties", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
      CREATE TABLE customers (id uuid PRIMARY KEY, organization_id uuid, auth_user_id uuid, merged_into_id uuid);
      CREATE TABLE branches (id uuid PRIMARY KEY, organization_id uuid, active boolean);
      CREATE TABLE menu_items (id uuid PRIMARY KEY, organization_id uuid, branch_id uuid, availability text);
      CREATE TABLE carts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid,
        customer_id uuid, status text DEFAULT 'active', fulfilment_type text, address_id uuid, zone_id uuid,
        promo_code text, scheduled_for timestamptz, tip_amount numeric DEFAULT 0, notes text);
      CREATE UNIQUE INDEX one_active_cart ON carts (customer_id) WHERE status = 'active';
      CREATE TABLE cart_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, cart_id uuid,
        menu_item_id uuid, quantity numeric, special_instructions text, allergy_note text);
      CREATE TABLE cart_item_modifiers (organization_id uuid, cart_item_id uuid, group_id uuid, option_id uuid,
        group_name text, option_name text, extra_charge numeric);
      CREATE TABLE modifier_options (id uuid, group_id uuid, name text, extra_charge numeric, active boolean, organization_id uuid);
      CREATE TABLE modifier_groups (id uuid, name text, active boolean);
      CREATE TABLE menu_item_modifier_groups (group_id uuid, menu_item_id uuid);
      INSERT INTO branches VALUES ('${harbour}','${org}',true), ('${garden}','${org}',true), ('${foreign}','${foreign}',true);
      INSERT INTO customers VALUES ('${actor}','${org}','${actor}',NULL);
      INSERT INTO menu_items VALUES ('${harbourDish}','${org}','${harbour}','available'), ('${gardenDish}','${org}','${garden}','available');
    `);
    await db.exec(readFileSync("supabase/migrations/20261120070000_scope_guest_basket_property.sql", "utf8"));
  }, 90_000);

  afterAll(async () => { await db?.close(); });

  const add = (dish: string, property: string) => db.query(
    "SELECT neo_guest_cart_add_item($1, 'pickup', $2, _branch => $3)", [org, dish, property],
  );

  it("keeps a populated basket at its original property and reuses it only when empty", async () => {
    await add(harbourDish, harbour);
    await expect(add(gardenDish, garden)).rejects.toThrow("Finish or clear the basket");
    expect((await db.query("SELECT branch_id FROM carts")).rows).toEqual([{ branch_id: harbour }]);
    expect((await db.query("SELECT menu_item_id FROM cart_items")).rows).toEqual([{ menu_item_id: harbourDish }]);

    await db.exec(`DELETE FROM cart_items; UPDATE carts SET address_id = '${actor}', zone_id = '${actor}', promo_code = 'OLD', tip_amount = 20, notes = 'Old property';`);
    await add(gardenDish, garden);
    expect((await db.query("SELECT branch_id, address_id, zone_id, promo_code, notes FROM carts")).rows)
      .toEqual([{ branch_id: garden, address_id: null, zone_id: null, promo_code: null, notes: null }]);
    expect((await db.query("SELECT menu_item_id FROM cart_items")).rows).toEqual([{ menu_item_id: gardenDish }]);
  });

  it("refuses branches from another tenant and items from another property", async () => {
    await expect(add(gardenDish, foreign)).rejects.toThrow("Property is not available");
    await expect(add(gardenDish, harbour)).rejects.toThrow("Item is not available at this property");
  });
});
