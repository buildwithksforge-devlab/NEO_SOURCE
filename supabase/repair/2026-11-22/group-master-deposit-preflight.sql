-- Read-only. Run before and after 20261122032500_group_master_deposit_integrity.sql.
WITH expected(signature, supported_baselines, installed_definition) AS (
  VALUES
    ('public.pms_group_master_folio(uuid)',
      ARRAY['7b012d1fc093d3e8797371df1517de7e'], 'd92dbf19d47aceff79afbe1a2ab5f8d8'),
    ('public.pms_group_record_deposit(uuid,numeric,text,text)',
      ARRAY['bec92f98f5f1fb8d771a3c9fbdbd54af','53fe19416b12ce7e96ea71f379cb339b','cd19a123f24e3120508451c6f38e47f0'],
      'fdd61dfbb695ca573e4d194cc8bf246b')
), resolved AS (
  SELECT *, to_regprocedure(signature) AS routine
  FROM expected
), definitions AS (
  SELECT *, md5(pg_get_functiondef(routine)) AS definition
  FROM resolved
)
SELECT signature, definition,
       CASE WHEN routine IS NULL THEN 'missing'
            WHEN definition = installed_definition THEN 'installed'
            WHEN definition = ANY(supported_baselines) THEN 'supported baseline'
            ELSE 'unknown definition' END AS rollout_status,
       has_function_privilege('anon', routine, 'EXECUTE') AS anonymous_execute,
       has_function_privilege('authenticated', routine, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role', routine, 'EXECUTE') AS service_execute
FROM definitions
ORDER BY signature;
