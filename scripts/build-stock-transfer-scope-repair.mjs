import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const source = readFileSync("supabase/migrations/20260919051525_feb17559-e7b1-43aa-87ff-c5a20b5ee274.sql", "utf8").replaceAll("\r\n", "\n");
const names = ["neo_stores_transfer_create", "neo_stores_transfer_receive", "neo_stores_transfer_cancel"];
const signatures = ["uuid,uuid,uuid,jsonb,text,uuid", "uuid", "uuid,text"];
const original = names.map((name) => source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?END \\$function\\$;`))?.[0]);
if (original.some((body) => !body)) throw new Error("Reviewed transfer definitions missing");
const replace = (sql, from, to) => {
  if (sql.split(from).length !== 2) throw new Error(`Missing/ambiguous transfer repair: ${from}`);
  return sql.replace(from, to);
};
const repaired = original.map((body, index) => {
  let sql = replace(body, "IF v_org IS NULL THEN", "IF auth.uid() IS NULL OR v_org IS NULL THEN");
  sql = replace(sql, "IF NOT public.neo_can_transfer_stock() THEN", "IF NOT coalesce(public.neo_can_transfer_stock(),false) THEN");
  if (index === 0) {
    sql = replace(sql, "IF _branch IS NULL OR NOT (_branch = ANY (public.current_branch_ids())) THEN", "IF _branch IS NULL OR NOT coalesce(public.neo_branch_in_scope(_branch),false) THEN");
    sql = replace(sql, "  -- replay: the same submission never posts twice", `  IF _attempt IS NULL THEN RAISE EXCEPTION 'A durable transfer attempt key is required'; END IF;
  IF nullif(btrim(_reason),'') IS NULL THEN RAISE EXCEPTION 'Give a reason for transferring stock'; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one item to transfer';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':transfer:' || _attempt::text,0));
  -- replay: the same submission never posts twice`);
    sql = replace(sql, "    IF v_existing.id IS NOT NULL THEN", `    IF v_existing.id IS NOT NULL THEN
      IF v_existing.branch_id IS DISTINCT FROM _branch OR v_existing.from_location_id IS DISTINCT FROM _from
        OR v_existing.to_location_id IS DISTINCT FROM _to OR v_existing.reason IS DISTINCT FROM btrim(_reason)
        OR (SELECT jsonb_agg(jsonb_build_array(l.stock_item_id,l.quantity,l.unit) ORDER BY l.stock_item_id,l.quantity,l.unit)
            FROM public.stock_transfer_lines l WHERE l.transfer_id=v_existing.id)
          IS DISTINCT FROM
           (SELECT jsonb_agg(jsonb_build_array((j->>'stock_item_id')::uuid,(j->>'quantity')::numeric,
             coalesce(nullif(j->>'unit',''),si.base_unit)) ORDER BY (j->>'stock_item_id')::uuid,(j->>'quantity')::numeric,coalesce(nullif(j->>'unit',''),si.base_unit))
            FROM jsonb_array_elements(_lines) j LEFT JOIN public.stock_items si ON si.id=(j->>'stock_item_id')::uuid) THEN
        RAISE EXCEPTION 'Transfer attempt belongs to different work; refresh the original transfer before retrying';
      END IF;`);
    sql = sql.replaceAll("branch_id IS NOT DISTINCT FROM _branch;", "branch_id IS NOT DISTINCT FROM _branch AND active IS TRUE;");
    sql = replace(sql, "IF v_qty <= 0 THEN", "IF v_qty::text IN ('NaN','Infinity','-Infinity') OR v_qty <= 0 THEN");
    sql = replace(sql, "AND (branch_id IS NULL OR branch_id = _branch);", "AND (branch_id IS NULL OR branch_id = _branch) AND active IS TRUE;");
    sql = replace(sql, "FROM public.stock_levels WHERE stock_item_id = v_item AND location_id = _from;", "FROM public.stock_levels WHERE stock_item_id = v_item AND location_id = _from FOR UPDATE;");
  } else {
    sql = replace(sql, "  IF t.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;", `  IF t.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF NOT coalesce(public.neo_branch_in_scope(t.branch_id),false) THEN
    RAISE EXCEPTION 'Transfer is outside your property scope' USING ERRCODE='42501';
  END IF;`);
    const boundary = index === 1
      ? "  IF t.status = 'cancelled' THEN RAISE EXCEPTION 'This transfer was cancelled'; END IF;"
      : "  PERFORM set_config('neo.system_posting', '1', true);";
    sql = replace(sql, boundary, `${boundary}
  IF t.status IS DISTINCT FROM 'in-transit' THEN RAISE EXCEPTION 'Only an in-transit transfer can be ${index === 1 ? "received" : "cancelled"}'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_transfer_lines WHERE transfer_id=_transfer) THEN
    RAISE EXCEPTION 'Transfer has no saved stock lines';
  END IF;`);
    sql = sql.replaceAll("'ok', true, 'replayed'", "'ok', true, 'transfer_id', _transfer, 'replayed'");
  }
  return sql;
});
const hash = (sql) => createHash("md5").update(sql.split("$function$")[1].replace(/--[^\n]*/g, "").replace(/\s/g, "")).digest("hex");
writeFileSync("supabase/migrations/20261116235000_store_transfer_scope_and_replay.sql", `-- STAGED ONLY: protect future transfer actions and replay; no historical stock rows changed.
BEGIN;
${names.map((name, i) => `DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.${name}(${signatures[i]})') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('${hash(original[i])}','${hash(repaired[i])}')) THEN
 RAISE EXCEPTION '${name} differs from reviewed source; nothing replaced'; END IF;
END $guard$;`).join("\n")}
CREATE TEMP TABLE neo_transfer_repair_acl ON COMMIT DROP AS
 SELECT oid,proowner,coalesce(proacl::text,'') acl FROM pg_proc
 WHERE oid IN (${names.map((name, i) => `'public.${name}(${signatures[i]})'::regprocedure`).join(",")});
${repaired.join("\n\n")}
DO $verify$ BEGIN
 IF EXISTS(SELECT 1 FROM neo_transfer_repair_acl old LEFT JOIN pg_proc p ON p.oid=old.oid
 WHERE p.oid IS NULL OR p.proowner<>old.proowner OR coalesce(p.proacl::text,'')<>old.acl) THEN
 RAISE EXCEPTION 'Transfer owner or grants changed'; END IF;
END $verify$;
COMMIT;
`);
console.log("Generated guarded transfer property, replay and stock validation repair.");
