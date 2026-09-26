
SET LOCAL neo.internal = 'on';
DO $$
DECLARE _o record;
BEGIN
  FOR _o IN SELECT id FROM organizations LOOP
    PERFORM public.neo_classify_roles(_o.id);
  END LOOP;
END $$;
SELECT migration_status, count(*) AS roles FROM public.roles GROUP BY 1 ORDER BY 1;
