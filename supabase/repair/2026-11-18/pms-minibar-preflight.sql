-- READ ONLY. Run in the original project's authorized SQL console when ready.
-- This checks metadata; it neither installs routines nor submits a transaction.
-- Compare the installed body hashes with the guarded migration candidates.
SELECT requested.label,requested.signature,
       p.oid IS NOT NULL AS installed,r.rolname AS owner,p.prosecdef AS security_definer,
       p.proconfig AS function_settings,
       md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) AS body_hash
FROM (VALUES
 ('checkout','public.pms_check_out(uuid,boolean,text)'),
 ('canonical checkout money','public.neo_folio_financial_components(uuid,uuid)'),
 ('canonical review','public.neo_folio_projection(uuid)'),
 ('minibar core','public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)'),
 ('minibar durable wrapper','public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)'),
 ('organization-scoped numbering','public.next_document_number(text,text,uuid,uuid)'),
 ('room transition','public.ops_set_room_status(uuid,text,text,text,text,uuid,text)'),
 ('PMS permissions','public.has_permission(text,text)'),
 ('minibar permissions','public.has_permission(text,text,text)'),
 ('property scope','public.neo_branch_in_scope(uuid)')
) AS requested(label,signature)
LEFT JOIN pg_proc p ON p.oid=to_regprocedure(requested.signature)
LEFT JOIN pg_roles r ON r.oid=p.proowner
ORDER BY requested.label;

-- Missing or different types require reconciliation before installation.
SELECT requested.table_name,requested.column_name,
       a.attname IS NOT NULL AS installed,format_type(a.atttypid,a.atttypmod) AS data_type
FROM (VALUES
 ('folios','stay_id'),('folios','reservation_id'),('folios','branch_id'),('folios','currency'),
 ('stays','room_id'),('stays','reservation_id'),('stays','status'),
 ('stock_locations','location_type'),('stock_locations','active'),('stock_locations','branch_id'),
 ('minibar_postings','room_id'),('minibar_postings','location_id'),('minibar_postings','total_amount'),
 ('minibar_posting_lines','folio_line_id'),('payment_allocations','folio_id')
) AS requested(table_name,column_name)
LEFT JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||requested.table_name)
 AND a.attname=requested.column_name AND a.attnum>0 AND NOT a.attisdropped
ORDER BY requested.table_name,requested.column_name;

SELECT c.relname,r.rolname AS owner,c.relrowsecurity AS rls_enabled,
 obj_description(c.oid) AS schema_marker,
 (SELECT count(*) FROM pg_policy WHERE polrelid=c.oid) AS policy_count,
 has_table_privilege('authenticated',c.oid,'SELECT') AS client_can_read,
 has_table_privilege('authenticated',c.oid,'INSERT') AS client_can_insert
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
WHERE n.nspname='public' AND c.relname='minibar_posting_attempts';

-- Configuration is deliberately not inferred from names or other departments.
-- This report requires an ordinary signed-in organization context. An SQL-console
-- admin without that context gets no organization data; installation metadata above
-- still works. Inspect the intended property using the normal authorized UI.
SELECT public.current_org_id() AS current_organization,
 CASE WHEN public.current_org_id() IS NULL THEN
  'No signed-in organization context: verify actual Minibar store/item configuration in the application.'
 ELSE 'Review active Minibar stores in each intended property before posting.' END AS next_check;

SELECT branch_id,count(*) AS explicit_active_minibar_stores
FROM public.stock_locations
WHERE organization_id=public.current_org_id() AND active IS TRUE AND location_type='minibar'
GROUP BY branch_id ORDER BY branch_id;
