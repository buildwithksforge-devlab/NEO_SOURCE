-- 1. Merge duplicate operational stations per branch+name (keep oldest)
DO $$
DECLARE
  grp RECORD;
  dup RECORD;
  col RECORD;
  merged_count int := 0;
BEGIN
  FOR grp IN
    SELECT branch_id, lower(btrim(name)) AS key,
           (array_agg(id ORDER BY created_at NULLS LAST, id))[1] AS keep_id
    FROM public.operational_stations
    WHERE active
    GROUP BY branch_id, lower(btrim(name))
    HAVING count(*) > 1
  LOOP
    FOR dup IN
      SELECT id FROM public.operational_stations
      WHERE active AND branch_id = grp.branch_id
        AND lower(btrim(name)) = grp.key AND id <> grp.keep_id
    LOOP
      FOR col IN
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public'
          AND c.column_name = 'station_id'
          AND c.table_name <> 'operational_stations'
      LOOP
        BEGIN
          EXECUTE format(
            'UPDATE public.%I SET station_id = %L WHERE station_id = %L',
            col.table_name, grp.keep_id, dup.id);
        EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation THEN
          -- row would collide with an equivalent row already on the surviving station; leave it
          NULL;
        END;
      END LOOP;

      UPDATE public.operational_stations
      SET active = false,
          status = 'merged',
          name = name || ' (merged)',
          description = coalesce(description || ' | ', '') || 'Merged into ' || grp.keep_id::text || ' on ' || now()::date,
          updated_at = now()
      WHERE id = dup.id;

      merged_count := merged_count + 1;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'merged % duplicate stations', merged_count;
END $$;

-- 2. Prevent future duplicates: one active station name per branch
CREATE UNIQUE INDEX IF NOT EXISTS operational_stations_branch_name_active_uidx
  ON public.operational_stations (branch_id, lower(btrim(name)))
  WHERE active;

-- 3. Prevent duplicate station codes per branch where a code is set
CREATE UNIQUE INDEX IF NOT EXISTS operational_stations_branch_code_active_uidx
  ON public.operational_stations (branch_id, lower(btrim(code)))
  WHERE active AND code IS NOT NULL AND btrim(code) <> '';
