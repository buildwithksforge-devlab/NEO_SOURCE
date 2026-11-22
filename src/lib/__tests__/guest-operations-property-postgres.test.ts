import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const org = id(1), west = id(2), east = id(3), user = id(4), westRoom = id(5), eastRoom = id(6);
const westStay = id(7), eastStay = id(8), westFolio = id(9), eastFolio = id(10), cart = id(11), shuttle = id(12), quoteRejectedCart = id(13), sharedProduct = id(14);
const westDept = id(21), eastDept = id(22), westWorker = id(23), eastWorker = id(24);

const setup = `
  CREATE SCHEMA auth;
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${user}'::uuid $$;
  CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${org}'::uuid $$;
  CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1 IN ('${west}'::uuid,'${east}'::uuid) $$;
  CREATE FUNCTION in_my_branch_scope(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $2 = '${west}'::uuid $$;
  CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
  CREATE FUNCTION has_permission(VARIADIC text[]) RETURNS boolean LANGUAGE sql AS
    $$ SELECT coalesce(current_setting('test.transport_staff',true) = 'on',false) AND $1 = ARRAY['front-office','requests','edit'] $$;
  CREATE FUNCTION neo_department_catalogue_key(text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT lower($1) $$;
  CREATE TABLE branches(id uuid PRIMARY KEY,organization_id uuid,active boolean,currency text,name text);
  CREATE TABLE neo_public_experience(organization_id uuid,branch_id uuid,discoverable boolean,doors jsonb);
  CREATE TABLE customers(id uuid PRIMARY KEY,organization_id uuid,auth_user_id uuid,merged_into_id uuid,primary_branch_id uuid,full_name text,phone text,email text,last_guest_app_activity_at timestamptz);
  CREATE TABLE reservations(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,customer_id uuid,room_id uuid,
    status text,arrival_date date,departure_date date,confirmation_number text,nights int,adults int,children int,total_amount numeric,balance numeric,payment_status text);
  CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,room_number text);
  CREATE TABLE stays(id uuid PRIMARY KEY,reservation_id uuid,status text,created_at timestamptz DEFAULT now());
  CREATE TABLE neo_stay_verifications(organization_id uuid,branch_id uuid,reservation_id uuid,customer_id uuid,auth_user_id uuid,method text,
    revoked_at timestamptz,verified_at timestamptz DEFAULT now(),UNIQUE(reservation_id,auth_user_id));
  CREATE TABLE folios(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,customer_id uuid,reservation_id uuid,
    status text,currency text,balance numeric,folio_number text,created_at timestamptz DEFAULT now(),opened_at timestamptz DEFAULT now(),closed_at timestamptz);
  CREATE TABLE folio_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,folio_id uuid,
    description text,category text,quantity numeric,unit_price numeric,tax_amount numeric,discount_amount numeric,net_amount numeric,
    posting_date date DEFAULT current_date,status text DEFAULT 'posted',line_type text DEFAULT 'charge');
  CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,customer_id uuid,folio_id uuid,
    receipt_number text,amount numeric,currency text,method text,paid_at timestamptz DEFAULT now(),status text DEFAULT 'completed');
  CREATE TABLE guest_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,reservation_id uuid,
    stay_id uuid,customer_id uuid,room_id uuid,category text,description text,priority text,status text,request_type text,created_by uuid);
  CREATE TABLE transport_products(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,active boolean,category text,max_passengers int,base_price numeric,currency text);
  CREATE TABLE transport_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,customer_id uuid,reservation_id uuid,
    product_id uuid,request_number text,category text,pickup_at timestamptz,pickup_point text,destination text,passengers int,luggage_count int,
    travel_reference text,notes text,quoted_amount numeric,currency text,status text,created_by uuid,
    assigned_rider_id uuid,assignment_note text,handled_by uuid,updated_at timestamptz);
  CREATE TABLE rider_profiles(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,active boolean,availability_status text,
    rider_code text,display_name text,vehicle_type text);
  CREATE TABLE audit_logs(organization_id uuid,user_id uuid,user_name text,action text,module text,record_id text,previous_value jsonb,new_value jsonb);
  CREATE TABLE carts(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,customer_id uuid,status text,fulfilment_type text,notes text);
  CREATE TABLE pos_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,order_number text,order_type text,
    order_source text,customer_id uuid,stay_id uuid,room_id uuid,folio_id uuid,guest_count int,guest_name text,contact_phone text,status text,
    payment_status text,subtotal numeric,discount_total numeric,tax_total numeric,service_charge_total numeric DEFAULT 0,grand_total numeric,
    currency text,notes text,updated_at timestamptz,folio_post_status text);
  CREATE TABLE pos_order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,order_id uuid,menu_item_id uuid,station_id uuid,
    item_name text,quantity numeric,selection_modifiers jsonb,unit_price numeric,tax_rate numeric,tax_amount numeric,line_total numeric,
    status text,special_instructions text,allergy_note text);
  CREATE TABLE delivery_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_cart_id uuid UNIQUE,currency text,organization_id uuid,branch_id uuid,
    pos_order_id uuid,customer_id uuid,auth_user_id uuid,order_number text,fulfilment_type text,contact_name text,contact_phone text,subtotal numeric,
    tax_total numeric,discount_total numeric,service_charge_total numeric,delivery_fee numeric,tip_amount numeric,grand_total numeric,payment_method text,
    payment_status text,estimated_prep_minutes int,estimated_delivery_at timestamptz,order_status text,kitchen_status text,notes text,
    created_at timestamptz DEFAULT now(),rider_id uuid,dispatch_status text);
  CREATE TABLE delivery_order_status_history(organization_id uuid,delivery_order_id uuid,status_kind text,new_status text,source text);
  CREATE TABLE production_routes(order_id uuid, organization_id uuid);
  CREATE TABLE departments(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,name text,catalogue_key text,active boolean,department_status text);
  CREATE TABLE profiles(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,department_id uuid,full_name text,staff_id text,job_title text,account_status text,employment_status text);
  CREATE TABLE employees(profile_id uuid,organization_id uuid,branch_id uuid,department_id uuid,job_title text,employment_status text,system_access_status text);
  CREATE TABLE roles(id uuid PRIMARY KEY,organization_id uuid,department_id uuid,active boolean,role_status text);
  CREATE TABLE user_roles(user_id uuid,role_id uuid,organization_id uuid);
  CREATE FUNCTION neo_guest_record_event(uuid,text,text,text,jsonb,text,text) RETURNS void LANGUAGE sql AS $$ SELECT pg_sleep(0) $$;
  CREATE FUNCTION neo_guest_lock_cart_pricing(uuid) RETURNS void LANGUAGE sql AS $$ SELECT pg_sleep(0) $$;
  CREATE FUNCTION delivery_quote_cart(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object(
    'can_checkout',true,'currency','KES','subtotal',950,'tax_total',50,'discount_total',0,'service_charge',0,'grand_total',950,'tip_amount',0,
    'lines',jsonb_build_array(jsonb_build_object('name','Room service lunch','quantity',1,'unit_price',950,'tax_rate',5))) $$;
  CREATE FUNCTION next_document_number(text,uuid,uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'QA-GUEST-0001' $$;
  CREATE FUNCTION neo_pos_route_tickets_internal(uuid,uuid) RETURNS void LANGUAGE sql AS $$ INSERT INTO production_routes VALUES ($1,$2) $$;
  CREATE FUNCTION neo_folio_financial_components(uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
  CREATE FUNCTION folio_post_charge(uuid,text,text,numeric,numeric,numeric,numeric,numeric,text,uuid,text,text,date) RETURNS uuid LANGUAGE sql AS $$
    INSERT INTO folio_lines(organization_id,branch_id,folio_id,description,quantity,unit_price,tax_amount,net_amount)
    SELECT organization_id,branch_id,id,$3,$4,$5,$6,$4*$5+$6+$7-$8 FROM folios WHERE folios.id=$1 RETURNING id $$;

  INSERT INTO branches VALUES ('${west}','${org}',true,'KES','West'),('${east}','${org}',true,'USD','East');
  INSERT INTO neo_public_experience SELECT '${org}',id,true,'{"stay_dine":true}' FROM branches;
  INSERT INTO customers (id,organization_id,auth_user_id,primary_branch_id,full_name) VALUES ('${user}','${org}','${user}','${east}','Ama Example');
  INSERT INTO rooms VALUES ('${westRoom}','${org}','${west}','W12'),('${eastRoom}','${org}','${east}','E34');
  INSERT INTO reservations (id,organization_id,branch_id,customer_id,room_id,status,arrival_date,departure_date,confirmation_number)
  VALUES ('${westStay}','${org}','${west}','${user}','${westRoom}','in-house',current_date-3,current_date+2,'WEST-BOOKING'),
         ('${eastStay}','${org}','${east}','${user}','${eastRoom}','checked_in',current_date-1,current_date+3,'EAST-BOOKING');
  INSERT INTO folios (id,organization_id,branch_id,customer_id,reservation_id,status,currency,balance,folio_number)
  VALUES ('${westFolio}','${org}','${west}','${user}','${westStay}','open','KES',950,'WEST-FOLIO'),
         ('${eastFolio}','${org}','${east}','${user}','${eastStay}','open','USD',90,'EAST-FOLIO');
  INSERT INTO payments(organization_id,branch_id,customer_id,folio_id,receipt_number,amount,currency)
  VALUES ('${org}',NULL,'${user}','${westFolio}','WEST-LEGACY',200,'KES'),
         ('${org}','${east}','${user}','${eastFolio}','EAST-RECEIPT',25,'USD'),
         ('${org}','${west}','${user}','${eastFolio}','BAD-BRANCH',30,'USD');
  INSERT INTO payments(organization_id,branch_id,customer_id,folio_id,receipt_number,amount,currency,status)
  VALUES ('${org}','${west}','${user}','${westFolio}','WAITING',400,'KES','pending');
  INSERT INTO transport_products VALUES ('${shuttle}','${org}','${east}',true,'airport',4,25,'USD'),
    ('${sharedProduct}','${org}',NULL,true,'airport',4,3000,'KES');
  INSERT INTO carts VALUES ('${cart}','${org}','${west}','${user}','active','room-service',NULL),
    ('${quoteRejectedCart}','${org}','${east}','${user}','active','room-service',NULL);
  INSERT INTO departments VALUES ('${westDept}','${org}','${west}','Kitchen','kitchen',true,'active'),
                                  ('${eastDept}','${org}','${east}','Kitchen','kitchen',true,'active');
  INSERT INTO profiles VALUES ('${westWorker}','${org}','${west}','${westDept}','West Cook','W1',NULL,'active','active'),
                              ('${eastWorker}','${org}','${east}','${eastDept}','East Cook','E1',NULL,'active','active');
  INSERT INTO employees SELECT id,organization_id,branch_id,department_id,'Cook','active','active' FROM profiles;
  INSERT INTO roles SELECT id,organization_id,id,true,'custom' FROM departments;
  INSERT INTO user_roles SELECT id,department_id,organization_id FROM profiles;
`;

describe("guest operations and worker choices follow the selected property", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(setup);
    await db.exec(readFileSync("supabase/migrations/20261120080000_scope_guest_operations_property.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20261122160000_guest_transport_request_retry.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20261122161000_transport_staff_action_evidence.sql", "utf8"));
  }, 90_000);
  afterAll(async () => { await db?.close(); });

  it("charges the cart property even when the guest has a newer in-house booking elsewhere", async () => {
    const stay = await db.query("SELECT neo_guest_active_stay($1,$2) AS stay", [org, west]);
    expect(stay.rows).toEqual([{ stay: expect.objectContaining({ reservation_id: westStay, folio_id: westFolio, room_number: "W12" }) }]);
    await db.query("SELECT neo_guest_place_room_service($1,'room-charge')", [cart]);
    await db.query("SELECT neo_guest_place_room_service($1,'room-charge')", [cart]);
    expect((await db.query("SELECT branch_id,folio_id,room_id FROM pos_orders")).rows)
      .toEqual([{ branch_id: west, folio_id: westFolio, room_id: westRoom }]);
    expect((await db.query("SELECT branch_id,folio_id,net_amount::int AS amount FROM folio_lines")).rows)
      .toEqual([{ branch_id: west, folio_id: westFolio, amount: 950 }]);
    expect((await db.query("SELECT count(*)::int AS tickets FROM production_routes")).rows).toEqual([{ tickets: 1 }]);
  });

  it("leaves the basket intact when the selected property's folio currency disagrees with the quote", async () => {
    await expect(db.query("SELECT neo_guest_place_room_service($1,'room-charge')", [quoteRejectedCart]))
      .rejects.toThrow("No matching open room bill");
    expect((await db.query("SELECT status FROM carts WHERE id=$1", [quoteRejectedCart])).rows).toEqual([{ status: "active" }]);
  });

  it("writes concierge and shared-product transfer requests to the property viewed", async () => {
    await db.query("SELECT neo_guest_create_request($1,$2,'concierge','Please bring towels','normal')", [org, west]);
    await db.query("SELECT neo_guest_request_transport($1,$2,$3,now()+interval '2 hours','Lobby','Airport',2,1,NULL,NULL)", [org, west, sharedProduct]);
    expect((await db.query("SELECT branch_id,reservation_id,room_id FROM guest_requests")).rows)
      .toEqual([{ branch_id: west, reservation_id: westStay, room_id: westRoom }]);
    expect((await db.query("SELECT branch_id,reservation_id,product_id FROM transport_requests")).rows)
      .toEqual([{ branch_id: west, reservation_id: westStay, product_id: sharedProduct }]);
    await expect(db.query("SELECT neo_guest_request_transport($1,$2,$3,now()+interval '2 hours','Lobby','Airport',2,1,NULL,NULL)",
      [org, west, shuttle])).rejects.toThrow("Transfer option is not available");
    await expect(db.query("SELECT neo_guest_create_request($1,$2,'concierge','Please bring towels','normal')", [org, id(999)]))
      .rejects.toThrow("Select an active property");
  });

  it("recovers a saved transfer after a lost reply and keeps the same request key scoped by property", async () => {
    const requestKey = id(998);
    const grants = await db.query(`
      SELECT has_function_privilege('anon', signature, 'EXECUTE') AS anon_allowed,
             has_function_privilege('authenticated', signature, 'EXECUTE') AS guest_allowed
      FROM (VALUES ('neo_guest_request_transport(uuid,uuid,uuid,timestamptz,text,text,integer,integer,text,text,uuid)')) AS rpc(signature)
    `);
    expect(grants.rows).toEqual([{ anon_allowed: false, guest_allowed: true }]);
    const submit = (branch: string, product: string) => db.query(`
      SELECT neo_guest_request_transport($1,$2,$3,now()+interval '2 hours','Lobby','Airport',2,1,NULL,NULL,$4) AS saved
    `, [org, branch, product, requestKey]);
    await expect(submit(west, shuttle)).rejects.toThrow("Transfer option is not available");
    const first = await submit(west, sharedProduct);
    expect(first.rows).toEqual([{ saved: expect.objectContaining({ status: "quoted", quoted_amount: 3000 }) }]);
    expect((await submit(west, sharedProduct)).rows).toEqual(first.rows);
    expect((await submit(east, shuttle)).rows).toEqual([{ saved: expect.objectContaining({ status: "quoted", quoted_amount: 25 }) }]);
    const saved = await db.query("SELECT branch_id, count(*)::int AS requests FROM transport_requests WHERE guest_request_key=$1 GROUP BY branch_id", [requestKey]);
    expect(saved.rows).toHaveLength(2);
    expect(saved.rows).toEqual(expect.arrayContaining([{ branch_id: west, requests: 1 }, { branch_id: east, requests: 1 }]));
  });

  it("saves authorized transfer changes once and refuses an out-of-scope driver or re-opening a closed transfer", async () => {
    const request = id(991), otherPropertyRequest = id(992), westRider = id(993), eastRider = id(994);
    await db.query(`INSERT INTO transport_requests (id,organization_id,branch_id,status) VALUES
      ($1,$3,$4,'requested'),($2,$3,$5,'requested')`, [request, otherPropertyRequest, org, west, east]);
    await db.query(`INSERT INTO rider_profiles (id,organization_id,branch_id,active,availability_status) VALUES
      ($1,$3,$4,true,'available'),($2,$3,$5,true,'available')`,
      [westRider, eastRider, org, west, east]);
    const update = (requestId: string, status: string, rider: string | null = null, amount: number | null = null) =>
      db.query("SELECT neo_transport_set_status($1,$2,$3,$4,NULL) AS saved", [requestId, status, rider, amount]);
    await expect(update(request, "quoted", null, 2500)).rejects.toThrow(/Not permitted/);
    await expect(db.query("SELECT * FROM neo_transport_rider_candidates($1)", [request])).rejects.toThrow(/Not permitted/);
    await db.exec("SET test.transport_staff='on'");
    expect((await db.query("SELECT rider_id,eligible FROM neo_transport_rider_candidates($1)", [request])).rows)
      .toEqual([{ rider_id: westRider, eligible: true }]);
    await expect(update(otherPropertyRequest, "quoted", null, 2500)).rejects.toThrow(/outside your property/);
    await expect(update(request, "quoted")).rejects.toThrow(/quote amount/);
    expect((await update(request, "quoted", null, 2500)).rows).toMatchObject([{ saved: { id: request, status: "quoted", quoted_amount: 2500 } }]);
    await update(request, "confirmed");
    await expect(update(request, "quoted", null, 2500)).rejects.toThrow(/transfer has moved on/);
    await expect(update(request, "driver-assigned", eastRider)).rejects.toThrow(/eligible driver/);
    expect((await update(request, "driver-assigned", westRider)).rows).toMatchObject([{ saved: { assigned_rider_id: westRider } }]);
    expect((await update(request, "driver-assigned", westRider)).rows).toMatchObject([{ saved: { already_saved: true } }]);
    await update(request, "completed");
    await expect(update(request, "confirmed")).rejects.toThrow(/already closed/);
    expect((await db.query("SELECT count(*)::int AS changes FROM audit_logs WHERE record_id=$1", [request])).rows)
      .toEqual([{ changes: 4 }]);
    expect((await db.query("SELECT status, assigned_rider_id FROM transport_requests WHERE id=$1", [request])).rows)
      .toEqual([{ status: "completed", assigned_rider_id: westRider }]);
    await db.exec("RESET test.transport_staff");
  });

  it("keeps folios, receipts and booking links on their own property", async () => {
    const bill = await db.query("SELECT neo_guest_folio_projection($1,$2) AS bill", [org, west]);
    expect(bill.rows).toEqual([{ bill: { folios: [expect.objectContaining({ id: westFolio })], payments: [expect.objectContaining({ receipt_number: "WEST-LEGACY" })] } }]);
    const stays = await db.query("SELECT neo_guest_my_stays($1,$2) AS stays", [org, west]);
    expect(stays.rows).toEqual([{ stays: [expect.objectContaining({ id: westStay })] }]);
    const link = await db.query("SELECT neo_guest_verify_stay($1,$2,'EAST-BOOKING','Example') AS result", [org, west]);
    expect(link.rows).toEqual([{ result: { verified: false, reason: "no_match" } }]);
  });

  it("preserves custom roles and refuses to broaden an invalid department choice", async () => {
    const workers = await db.query("SELECT id FROM neo_scoped_workers(NULL,$1,NULL)", [westDept]);
    expect(workers.rows).toEqual([{ id: westWorker }]);
    expect((await db.query("SELECT id FROM neo_scoped_workers($1,$2,NULL)", [west, eastDept])).rows).toEqual([]);
    expect((await db.query("SELECT id FROM neo_scoped_workers($1,$2,'kitchen')", [west, id(999)])).rows).toEqual([]);
  });
});
