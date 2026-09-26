/**
 * NEØ System Test — isolated QA environment (server only).
 *
 * A test environment is a real, separate workspace created through the same
 * provisioning routine a genuine customer signs up with, holding its own
 * property, departments, roles, stations and temporary staff accounts. No test
 * ever reaches into a live workspace: every identifier a test touches is
 * resolved from the environment it was handed.
 *
 * Every seeded record is named TEST-*, and removing the environment removes the
 * workspace row, which cascades to everything that belongs to it.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type TestAccount = {
  key: string;
  roleName: string;
  fullName: string;
  email: string;
  userId: string;
  departmentName: string | null;
};

/** A password only ever exists in memory, for the length of one operation. */
export type TestCredential = { account: TestAccount; password: string };


export type TestEnvironment = {
  id: string;
  label: string;
  kind: string;
  orgId: string;
  branchId: string;
  ownerUserId: string;
  accounts: TestAccount[];
  seed: Record<string, string>;
};

type Admin = SupabaseClient;

export const TEST_EMAIL_DOMAIN = "neo-simulation.example.com";

/** The staff accounts every environment gets, mapped to real catalogue roles. */
export const TEST_ROLES: { key: string; roleName: string; department: string | null; name: string }[] = [
  { key: "owner", roleName: "Owner", department: "Administration", name: "TEST Owner" },
  { key: "operations_manager", roleName: "Operations Manager", department: "Administration", name: "TEST Operations Manager" },
  { key: "accountant", roleName: "Accountant", department: "Finance", name: "TEST Accountant" },
  { key: "cashier", roleName: "Cashier", department: "Finance", name: "TEST Cashier" },

  { key: "receptionist", roleName: "Receptionist", department: "Front Office", name: "TEST Receptionist" },
  { key: "waiter", roleName: "Waiter / Waitress", department: "Restaurant", name: "TEST Waitress" },
  { key: "chef", roleName: "Chef", department: "Kitchen", name: "TEST Chef" },
  { key: "housekeeper", roleName: "Housekeeper", department: "Housekeeping", name: "TEST Housekeeper" },
  { key: "procurement", roleName: "Procurement Officer", department: "Procurement", name: "TEST Procurement Officer" },
  { key: "storekeeper", roleName: "Storekeeper", department: "Inventory & Stores", name: "TEST Storekeeper" },
  { key: "events", roleName: "Events Manager", department: "Events", name: "TEST Events Manager" },
  { key: "maintenance", roleName: "Maintenance Officer", department: "Maintenance", name: "TEST Maintenance Officer" },
  { key: "marketing", roleName: "Marketing Manager", department: "Marketing", name: "TEST Marketing Manager" },
  { key: "hr", roleName: "Human Resources", department: "Human Resources", name: "TEST HR Officer" },
  { key: "rider", roleName: "Rider", department: "Delivery", name: "TEST Rider" },
];

function password() {
  return `Test-${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}!9`;
}

/**
 * A signed-in client for a test account. The password is handed in for the
 * length of the call and is never written anywhere: not to the environment
 * record, not to evidence, not to an error message.
 */
export async function signInAs(account: TestAccount, pass: string): Promise<SupabaseClient> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) throw new Error("The backend connection details are not available on the server.");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
  const { error } = await client.auth.signInWithPassword({ email: account.email, password: pass });
  if (error) throw new Error(`Could not sign in the ${account.key} test account: ${error.message}`);
  return client;
}

/**
 * Issues a fresh one-off password for each test account and signs it in. The
 * password lives only in this process, so nothing durable ever holds a
 * credential for a test account.
 */
export async function issueSessions(
  admin: Admin,
  accounts: TestAccount[],
): Promise<Map<string, SupabaseClient>> {
  const map = new Map<string, SupabaseClient>();
  for (const account of accounts) {
    try {
      const pass = password();
      const { error } = await admin.auth.admin.updateUserById(account.userId, { password: pass });
      if (error) continue;
      map.set(account.key, await signInAs(account, pass));
    } catch {
      // A missing account is reported by the suites that need it.
    }
  }
  return map;
}

async function createAccount(
  admin: Admin,
  tag: string,
  spec: (typeof TEST_ROLES)[number],
): Promise<TestCredential> {
  const email = `neo-qa+${tag}-${spec.key}@${TEST_EMAIL_DOMAIN}`;
  const pass = password();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
    user_metadata: { full_name: spec.name, neo_test_account: true },
  });
  if (error || !data.user) throw new Error(`Could not create the ${spec.key} test account: ${error?.message}`);
  return {
    password: pass,
    account: {
      key: spec.key,
      roleName: spec.roleName,
      fullName: spec.name,
      email,
      userId: data.user.id,
      departmentName: spec.department,
    },
  };
}


/** Builds one isolated QA workspace with staff accounts and TEST-* master data. */
export async function provisionEnvironment(
  admin: Admin,
  input: { label: string; kind: string; tag: string },
): Promise<Omit<TestEnvironment, "id">> {
  const ownerSpec = TEST_ROLES[0]!;
  const ownerCredential = await createAccount(admin, input.tag, ownerSpec);
  const owner = ownerCredential.account;

  const { data: orgId, error: bootError } = await admin.rpc("bootstrap_tenant_for" as never, {
    _uid: owner.userId,
    _org_name: input.label,
    _full_name: owner.fullName,
  } as never);
  if (bootError || !orgId) throw new Error(`Could not create the test workspace: ${bootError?.message}`);
  const org = orgId as unknown as string;

  const { data: branch } = await admin
    .from("branches")
    .select("id")
    .eq("organization_id", org)
    .limit(1)
    .maybeSingle();
  const branchId = (branch as { id: string } | null)?.id;
  if (!branchId) throw new Error("The test workspace has no property.");

  const { data: deptRows } = await admin
    .from("departments")
    .select("id, name")
    .eq("organization_id", org);
  const departments = new Map((deptRows ?? []).map((d) => [(d as { name: string }).name, (d as { id: string }).id]));

  // Make sure the workspace carries the full standard role list (and its
  // permission templates) before staff are attached to it.
  await admin.rpc("provision_catalogue_roles" as never, { _org: org } as never);
  await admin.rpc("neo_apply_role_templates" as never, { _org: org, _reset: false } as never);
  await admin.rpc("neo_apply_feature_templates" as never, { _org: org } as never);

  const { data: roleRows } = await admin.from("roles").select("id, name").eq("organization_id", org);
  const roles = new Map((roleRows ?? []).map((r) => [(r as { name: string }).name, (r as { id: string }).id]));


  const accounts: TestAccount[] = [owner];
  for (const spec of TEST_ROLES.slice(1)) {
    const account = (await createAccount(admin, input.tag, spec)).account;
    const deptId = spec.department ? (departments.get(spec.department) ?? null) : null;
    const roleId = roles.get(spec.roleName) ?? null;
    if (!roleId) throw new Error(`The test workspace has no "${spec.roleName}" role.`);

    await admin.from("profiles").insert({
      id: account.userId,
      organization_id: org,
      account_type: "staff",
      full_name: account.fullName,
      email: account.email,
      branch_id: branchId,
      department_id: deptId,
      job_title: spec.roleName,
      invitation_status: "active",
      account_status: "active",
      created_by: owner.userId,
    } as never);
    // A real HR employee record: housekeeping assignment and station scope both
    // require one, exactly as they do for live staff.
    await admin.from("employees").insert({
      organization_id: org,
      profile_id: account.userId,
      employee_number: `TEST-${input.tag}-${spec.key.toUpperCase().slice(0, 6)}`,
      full_name: account.fullName,
      work_email: account.email,
      branch_id: branchId,
      department_id: deptId,
      job_title: spec.roleName,
      employment_type: "full-time",
      employment_status: "active",
      employment_date: new Date().toISOString().slice(0, 10),
      created_by: owner.userId,
    } as never);
    await admin.from("user_roles").insert({ organization_id: org, user_id: account.userId, role_id: roleId } as never);
    await admin.from("user_branches").insert({ organization_id: org, user_id: account.userId, branch_id: branchId } as never);
    if (deptId)
      await admin
        .from("user_departments")
        .insert({ organization_id: org, user_id: account.userId, department_id: deptId } as never);
    accounts.push(account);
  }

  // Grant each role the permissions the product itself recommends for it, using
  // the workspace owner — the same path an administrator uses in Settings.
  const ownerClient = await signInAs(owner, ownerCredential.password);

  // Set the workspace's books up the way an owner does on first run. Without a
  // chart of accounts nothing can be posted, and the books tests would have no
  // real journal to check.
  const { error: chartError } = await ownerClient.rpc("fin_seed_finance_defaults" as never);
  if (chartError) throw new Error(`The test workspace books could not be set up: ${chartError.message}`);

  for (const spec of TEST_ROLES.slice(1)) {
    const roleId = roles.get(spec.roleName);
    if (roleId) await ownerClient.rpc("apply_recommended_permissions" as never, { _role_id: roleId, _reset: true } as never);
  }

  // Link each role to its department, the way an administrator does in Settings;
  // department-scoped assignment rules require it.
  for (const spec of TEST_ROLES) {
    const roleId = roles.get(spec.roleName);
    const deptId = spec.department ? (departments.get(spec.department) ?? null) : null;
    if (roleId && deptId) await admin.from("roles").update({ department_id: deptId } as never).eq("id", roleId);
  }

  // Compile the role feature templates, exactly as an administrator does when a
  // workspace is set up; without it the seeded roles hold no working grants.
  await (admin as unknown as { rpc: (n: string, a: Record<string, unknown>) => Promise<unknown> }).rpc(
    "neo_apply_feature_templates",
    { _org: org },
  );

  const seed = await seedMasterData(admin, org, branchId, owner.userId);

  // Kitchen and service staff work a station, exactly as they are set up in the
  // product; without it the chef's queue is empty and tickets cannot be worked.
  const stationFor: Record<string, string | undefined> = {
    chef: seed["hotKitchenStationId"],
    waiter: seed["restaurantStationId"],
  };
  for (const account of accounts) {
    const stationId = stationFor[account.key];
    if (!stationId) continue;
    await admin.from("user_stations").insert({
      organization_id: org,
      branch_id: branchId,
      user_id: account.userId,
      station_id: stationId,
      is_primary: true,
      created_by: owner.userId,
    } as never);
    await admin.from("employees").update({ station_id: stationId } as never).eq("profile_id", account.userId);
  }

  return { label: input.label, kind: input.kind, orgId: org, branchId, ownerUserId: owner.userId, accounts, seed };

}

/** TEST-* master data: a room, a rate, a dish with a recipe, a store with stock and a supplier. */
async function seedMasterData(
  admin: Admin,
  org: string,
  branch: string,
  createdBy: string,
): Promise<Record<string, string>> {
  const one = async <T>(table: string, row: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.from(table).insert(row as never).select("*").single();
    if (error) throw new Error(`Seeding ${table} failed: ${error.message}`);
    return data as T;
  };

  const { data: deptRows } = await admin.from("departments").select("id, name").eq("organization_id", org);
  const dept = (name: string) =>
    ((deptRows ?? []).find((d) => (d as { name: string }).name === name) as { id: string } | undefined)?.id ?? null;

  const { data: stationRows } = await admin
    .from("operational_stations")
    .select("id, code")
    .eq("organization_id", org);
  const station = (code: string) =>
    ((stationRows ?? []).find((s) => (s as { code: string }).code === code) as { id: string } | undefined)?.id ?? null;
  const hotKitchen = station("hot-kitchen");
  const restaurantFloor = station("restaurant-floor");

  const roomType = await one<{ id: string }>("room_types", {
    organization_id: org,
    branch_id: branch,
    name: "TEST Standard Room",
    code: "TSTD",
    max_adults: 2,
    max_children: 1,
    max_occupancy: 3,
    base_occupancy: 2,
    bed_count: 1,
    status: "active",
    created_by: createdBy,
  });

  const room = await one<{ id: string }>("rooms", {
    organization_id: org,
    branch_id: branch,
    room_number: "TEST-101",
    room_type_id: roomType.id,
    floor: "1",
    housekeeping_status: "clean",
    maintenance_status: "operational",
    occupancy_status: "vacant",
    sellable: true,
    status: "active",
    created_by: createdBy,
  });

  const room2 = await one<{ id: string }>("rooms", {
    organization_id: org,
    branch_id: branch,
    room_number: "TEST-102",
    room_type_id: roomType.id,
    floor: "1",
    housekeeping_status: "clean",
    maintenance_status: "operational",
    occupancy_status: "vacant",
    sellable: true,
    status: "active",
    created_by: createdBy,
  });

  const ratePlan = await one<{ id: string }>("rate_plans", {
    organization_id: org,
    branch_id: branch,
    name: "TEST Standard Rate",
    code: "TRATE",
    room_type_id: roomType.id,
    base_rate: 10000,
    currency: "KES",
    tax_treatment: "exclusive",
    tax_rate: 16,
    service_charge_rate: 0,
    included_occupancy: 2,
    days_of_week: [1, 2, 3, 4, 5, 6, 7],
    status: "active",
    created_by: createdBy,
  });

  const menu = await one<{ id: string }>("menus", {
    organization_id: org,
    branch_id: branch,
    name: "TEST Restaurant Menu",
    service_type: "all-day",
    status: "published",
    created_by: createdBy,
  });

  const menuCategory = await one<{ id: string }>("menu_categories", {
    organization_id: org,
    menu_id: menu.id,
    name: "TEST Mains",
    station_id: hotKitchen,
    active: true,
  });

  const menuItem = await one<{ id: string }>("menu_items", {
    organization_id: org,
    branch_id: branch,
    category_id: menuCategory.id,
    name: "TEST Grilled Chicken",
    sku: "TEST-DISH-1",
    base_price: 1200,
    currency: "KES",
    tax_rate: 16,
    station_id: hotKitchen,
    prep_minutes: 15,
    availability: "available",
    available_dine_in: true,
    publish_status: "published",
    created_by: createdBy,
  });

  if (hotKitchen)
    await admin.from("station_routing_rules").insert({
      organization_id: org,
      branch_id: branch,
      menu_item_id: menuItem.id,
      station_id: hotKitchen,
      priority: 1,
      active: true,
      created_by: createdBy,
    } as never);

  // The stores hierarchy is Item Group → Category → Stock item, so the test
  // workspace is seeded the same way the real one is structured.
  const stockGroup = await one<{ id: string }>("stock_item_groups", {
    organization_id: org,
    name: "TEST Food",
    kind: "food",
    active: true,
  });

  const stockCategory = await one<{ id: string }>("stock_categories", {
    organization_id: org,
    group_id: stockGroup.id,
    name: "TEST Food Ingredients",
    code: "TESTFOOD",
    kind: "food",
    active: true,
  });


  const storeLocation = await one<{ id: string }>("stock_locations", {
    organization_id: org,
    branch_id: branch,
    department_id: dept("Kitchen"),
    name: "TEST Kitchen Store",
    code: "TESTKS",
    location_type: "store",
    is_main: true,
    active: true,
    station_id: hotKitchen,
  });

  const stockItem = await one<{ id: string }>("stock_items", {
    organization_id: org,
    branch_id: branch,
    category_id: stockCategory.id,
    name: "TEST Chicken Fillet",
    sku: "TEST-STK-1",
    base_unit: "kg",
    purchase_unit: "kg",
    purchase_to_base: 1,
    min_level: 5,
    reorder_point: 5,
    reorder_quantity: 20,
    average_cost: 550,
    last_cost: 550,
    default_location_id: storeLocation.id,
    active: true,
    created_by: createdBy,
  });

  await admin.from("stock_levels").insert({
    organization_id: org,
    stock_item_id: stockItem.id,
    location_id: storeLocation.id,
    quantity_on_hand: 40,
    opening_balance: 40,
  } as never);

  const recipe = await one<{ id: string }>("recipes", {
    organization_id: org,
    branch_id: branch,
    menu_item_id: menuItem.id,
    name: "TEST Grilled Chicken recipe",
    version: 1,
    yield_quantity: 1,
    yield_unit: "portion",
    station_id: hotKitchen,
    status: "active",
    recipe_type: "menu_item",
    created_by: createdBy,
  });

  await admin.from("recipe_ingredients").insert({
    organization_id: org,
    recipe_id: recipe.id,
    stock_item_id: stockItem.id,
    ingredient_name: "TEST Chicken Fillet",
    quantity: 0.25,
    unit: "kg",
    unit_cost: 550,
    component_type: "stock_item",
  } as never);

  const supplier = await one<{ id: string }>("suppliers", {
    organization_id: org,
    branch_id: branch,
    name: "TEST Supplier Ltd",
    code: "TESTSUP",
    contact_person: "TEST Contact",
    phone: "+254700000000",
    email: `neo-qa+supplier@${TEST_EMAIL_DOMAIN}`,
    currency: "KES",
    credit_terms_days: 30,
    active: true,
    created_by: createdBy,
  });

  const customer = await one<{ id: string }>("customers", {
    organization_id: org,
    primary_branch_id: branch,
    customer_type: "individual-guest",
    customer_number: `TEST-CUS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: "TEST Guest Simulation",
    phone: "+254711000000",
    email: `neo-qa+guest@${TEST_EMAIL_DOMAIN}`,
    account_status: "active",
    source: "system-test",
    created_by: createdBy,
  });

  const drawer = await one<{ id: string }>("cash_drawers", {
    organization_id: org,
    branch_id: branch,
    name: "TEST Front Desk Drawer",
    location: "TEST Reception",
    active: true,
  });

  return {
    cashDrawerId: drawer.id,

    roomTypeId: roomType.id,
    roomId: room.id,
    roomId2: room2.id,
    ratePlanId: ratePlan.id,
    menuId: menu.id,
    menuItemId: menuItem.id,
    stockItemId: stockItem.id,
    stockCategoryId: stockCategory.id,
    storeLocationId: storeLocation.id,
    recipeId: recipe.id,
    supplierId: supplier.id,
    customerId: customer.id,
    ...(hotKitchen ? { hotKitchenStationId: hotKitchen } : {}),
    ...(restaurantFloor ? { restaurantStationId: restaurantFloor } : {}),
    ...(dept("Kitchen") ? { kitchenDepartmentId: dept("Kitchen")! } : {}),
    ...(dept("Housekeeping") ? { housekeepingDepartmentId: dept("Housekeeping")! } : {}),
    ...(dept("Maintenance") ? { maintenanceDepartmentId: dept("Maintenance")! } : {}),
  };
}

/**
 * Removes a QA workspace, everything inside it and its temporary accounts, then
 * proves it is gone. Live workspaces are untouched, and the routine is safe to
 * run again on a workspace that is already partly removed.
 */
export async function purgeEnvironment(
  admin: Admin,
  env: { orgId: string | null; accounts: TestAccount[] },
): Promise<{
  organisationRemoved: boolean;
  accountsRemoved: number;
  leftovers: { table: string; rows: number }[];
  problems: string[];
}> {
  const problems: string[] = [];
  let organisationRemoved = env.orgId === null;
  const leftovers: { table: string; rows: number }[] = [];

  if (env.orgId) {
    const { data, error } = await (admin as unknown as {
      rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
    }).rpc("neo_test_purge_org", { _org: env.orgId });
    if (error) problems.push(`Workspace removal failed: ${error.message}`);
    else {
      const result = (data ?? {}) as { removed?: boolean; errors?: { table: string; error: string }[] };
      organisationRemoved = result.removed === true;
      for (const e of result.errors ?? []) problems.push(`${e.table}: ${e.error}`);
    }

    // Verification, not assumption: ask the database what is still there.
    const { data: check, error: checkError } = await (admin as unknown as {
      rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
    }).rpc("neo_test_purge_verify", { _org: env.orgId });
    if (checkError) problems.push(`Cleanup could not be verified: ${checkError.message}`);
    else {
      const result = (check ?? {}) as { clean?: boolean; remaining?: Record<string, number> };
      for (const [table, rows] of Object.entries(result.remaining ?? {})) {
        if (Number(rows) > 0) leftovers.push({ table, rows: Number(rows) });
      }
      if (leftovers.length > 0)
        problems.push(`Records remain in ${leftovers.map((l) => `${l.table} (${l.rows})`).join(", ")}`);
      if (result.clean !== true && leftovers.length === 0)
        problems.push("The workspace record itself could not be removed.");
    }
  }

  let accountsRemoved = 0;
  for (const account of env.accounts ?? []) {
    const { error } = await admin.auth.admin.deleteUser(account.userId);
    const missing = (error?.message ?? "").toLowerCase().includes("not found");
    if (error && !missing) problems.push(`Account ${account.email} could not be removed: ${error.message}`);
    else accountsRemoved += 1;
  }

  return { organisationRemoved, accountsRemoved, leftovers, problems };
}

