-- Metadata only. Run in the ORIGINAL authorized Lovable project's SQL editor.
-- Does not read operational rows, key values, PINs or function bodies; no writes.
-- The database name alone is not proof of the project's identity.

SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('recipes', 'recipe_ingredients', 'menu_items', 'stock_items',
    'stock_locations', 'uom_units', 'neo_print_agents', 'print_connectors',
    'print_jobs', 'neo_staff_login_devices', 'mpesa_transactions',
    'neo_blind_receiving_counts', 'neo_blind_receiving_count_lines')
ORDER BY table_name;

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('recipes', 'recipe_ingredients', 'menu_items',
    'neo_print_agents', 'print_connectors', 'print_jobs',
    'mpesa_transactions', 'neo_blind_receiving_counts')
ORDER BY table_name, ordinal_position;

SELECT p.proname AS routine,
  pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  pg_get_function_result(p.oid) AS result_contract,
  p.prosecdef AS security_definer,
  md5(pg_get_functiondef(p.oid)) AS definition_fingerprint,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND (p.proname ILIKE '%recipe%'
    OR p.proname ILIKE '%import%'
    OR p.proname ILIKE '%print_agent%'
    OR p.proname ILIKE '%print_connector%'
    OR p.proname ILIKE '%staff_login%'
    OR p.proname ILIKE '%mpesa%'
    OR p.proname ILIKE '%blind_receiving%')
ORDER BY p.proname, identity_arguments;
