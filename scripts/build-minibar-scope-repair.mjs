import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const source = readFileSync(
  "supabase/migrations/20260924153000_front_office_connected_guards.sql",
  "utf8",
).replaceAll("\r\n", "\n");
const original = source.match(
  /CREATE OR REPLACE FUNCTION public\.neo_minibar_post\([\s\S]*?\$function\$;/,
)?.[0];
if (!original) throw new Error("Reviewed minibar routine missing");
let repaired = original;
function replace(before, after) {
  if (!repaired.includes(before)) throw new Error(`Reviewed minibar fragment missing: ${before}`);
  repaired = repaired.replace(before, after);
}
replace("WHERE id = _folio;", "WHERE id = _folio FOR UPDATE;");
replace("IF NOT public.has_permission('front-office', 'folios', 'create') THEN", "IF auth.uid() IS NULL OR public.has_permission('front-office', 'folios', 'create') IS NOT TRUE THEN");
replace(
  "  IF v_folio.status <> 'open' THEN",
  `  IF v_folio.branch_id IS NULL OR public.neo_branch_in_scope(v_folio.branch_id) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF v_folio.status IS DISTINCT FROM 'open' THEN`,
);
replace(
  "IF v_loc IS NULL OR v_loc.organization_id IS DISTINCT FROM v_folio.organization_id THEN",
  `IF v_loc IS NULL OR v_loc.organization_id IS DISTINCT FROM v_folio.organization_id
     OR v_loc.branch_id IS DISTINCT FROM v_folio.branch_id OR v_loc.active IS NOT TRUE THEN`,
);
replace(
  "  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN",
  `  IF _lines IS NULL OR jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_lines');
  END IF;
  IF jsonb_array_length(_lines) = 0 THEN`,
);
replace(
  "    IF v_qty <= 0 THEN",
  "    IF v_qty::text IN ('NaN','Infinity','-Infinity') OR v_qty <= 0 THEN",
);
replace(
  "      SELECT * INTO v_recipe FROM public.recipes",
  `      IF (v_menu.branch_id IS NOT NULL AND v_menu.branch_id IS DISTINCT FROM v_folio.branch_id)
         OR (coalesce(array_length(v_menu.consumption_channels, 1), 0) > 0
             AND ('minibar' = ANY(v_menu.consumption_channels)) IS NOT TRUE) THEN
        RAISE EXCEPTION 'Minibar line % is not available for this property and channel', v_idx USING ERRCODE = '23514';
      END IF;
      SELECT * INTO v_recipe FROM public.recipes`,
);
replace(
  "    IF v_price IS NULL THEN",
  "    IF v_price IS NULL OR v_price::text IN ('NaN','Infinity','-Infinity') OR v_price < 0 THEN",
);
replace(
  "    -- Which consumption model applies:",
  `    IF v_menu.id IS NOT NULL AND (v_menu.base_price IS NULL OR v_price IS DISTINCT FROM v_menu.base_price) THEN
      RAISE EXCEPTION 'Minibar menu price changed; refresh the item before posting' USING ERRCODE = '23514';
    END IF;

    -- Which consumption model applies:`,
);
replace(
  `      v_line_location := COALESCE(
        v_menu.issuing_location_id,
        public.neo_item_group_store(v_folio.organization_id, v_comp.item_id, v_folio.branch_id),
        _location);`,
  `      -- A minibar posting consumes from the explicitly selected property store.
      -- Bar menu defaults and catalogue group fallbacks must not override it.
      v_line_location := _location;`,
);
const bodyHash = (sql) =>
  createHash("md5")
    .update(
      sql
        .split("$function$")[1]
        .replace(/--[^\n]*/g, "")
        .replace(/\s/g, ""),
    )
    .digest("hex");
// 19 Nov installed definition supplied by user: same reviewed core except the
// newer location resolver. The repair intentionally replaces both resolver
// variants with the explicit minibar store, preserving all other behaviour.
const resolverVariant = original.replace(
  "public.neo_item_group_store(v_folio.organization_id, v_comp.item_id, v_folio.branch_id)",
  "public.neo_stock_resolve_location(v_folio.organization_id, v_comp.item_id, v_folio.branch_id, NULL)",
).replace(/^\s*PERFORM set_config\('neo\.system_posting', '(?:on|off)', true\);\s*$/gm, "");
if (bodyHash(resolverVariant) !== "02e573b16d42f6eadb1a8fbc3ee9c80a") {
  throw new Error("Reviewed live minibar resolver variant no longer matches supplied definition");
}
const allowed = [bodyHash(original), bodyHash(resolverVariant), bodyHash(repaired)].map((hash) => `'${hash}'`).join(",");
const migration = `-- STAGED ONLY: future minibar property/store/channel and finite-amount guards.
-- No historical stock/folio rows are changed. Installed-definition review is required.
BEGIN;
DO $guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    WHERE p.oid=to_regprocedure('public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)')
      AND r.rolname NOT IN ('anon','authenticated')
      AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN (${allowed})) THEN
    RAISE EXCEPTION 'Minibar routine differs from reviewed source; nothing replaced';
  END IF;
END $guard$;
CREATE TEMP TABLE neo_minibar_scope_acl ON COMMIT DROP AS
 SELECT proowner,coalesce(proacl::text,'') AS acl FROM pg_proc
 WHERE oid='public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)'::regprocedure;
${repaired}
DO $verify$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN neo_minibar_scope_acl old
    WHERE p.oid='public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)'::regprocedure
      AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN
    RAISE EXCEPTION 'Minibar routine owner or grants changed';
  END IF;
END $verify$;
COMMIT;
`;
writeFileSync("supabase/migrations/20261116221500_minibar_property_store_guards.sql", migration);
console.log("Generated staged minibar scope repair with installed-body and ACL guards.");
