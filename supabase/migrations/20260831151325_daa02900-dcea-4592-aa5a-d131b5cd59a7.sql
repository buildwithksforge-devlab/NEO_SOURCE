-- 1. Every floor area belongs to an outlet.
ALTER TABLE public.restaurant_areas
  ADD COLUMN IF NOT EXISTS outlet text NOT NULL DEFAULT 'restaurant';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.restaurant_areas'::regclass
       AND conname = 'restaurant_areas_outlet_check'
  ) THEN
    ALTER TABLE public.restaurant_areas
      ADD CONSTRAINT restaurant_areas_outlet_check
      CHECK (outlet = ANY (ARRAY['restaurant','bar','coffee','room-service','banqueting','delivery']));
  END IF;
END $$;

-- Backfill from the name the property already gave the area.
UPDATE public.restaurant_areas
   SET outlet = CASE
     WHEN name ILIKE '%bar%' OR name ILIKE '%lounge%' THEN 'bar'
     WHEN name ILIKE '%coffee%' OR name ILIKE '%cafe%' OR name ILIKE '%caf_%' THEN 'coffee'
     WHEN name ILIKE '%room service%' OR name ILIKE '%room-service%' THEN 'room-service'
     WHEN name ILIKE '%banquet%' OR name ILIKE '%event%' THEN 'banqueting'
     ELSE 'restaurant'
   END
 WHERE outlet = 'restaurant';

-- 2. The outlets the signed-in member of staff may trade through.
CREATE OR REPLACE FUNCTION public.neo_floor_outlets()
RETURNS text[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH keys AS (
    SELECT DISTINCT coalesce(
             nullif(btrim(coalesce(d.catalogue_key,'')),''),
             public.neo_department_catalogue_key(d.name),
             lower(btrim(d.name))
           ) AS k
      FROM public.departments d
     WHERE d.organization_id = public.current_org_id()
       AND (
         d.id IN (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
         OR d.id IN (
           SELECT r.department_id
             FROM public.user_roles ur
             JOIN public.roles r ON r.id = ur.role_id
            WHERE ur.user_id = auth.uid()
              AND coalesce(r.active, true)
              AND coalesce(r.role_status, 'active') <> 'archived'
         )
       )
  )
  SELECT CASE
    -- Nothing to narrow by, or a whole-house department: every outlet.
    WHEN NOT EXISTS (SELECT 1 FROM keys)
      OR EXISTS (
        SELECT 1 FROM keys
         WHERE k IN ('executive-management','operations','administration','it-and-systems')
      )
      THEN ARRAY['restaurant','bar','coffee','room-service','banqueting','delivery']
    ELSE (
      SELECT coalesce(array_agg(DISTINCT o), ARRAY[]::text[])
        FROM keys, LATERAL (
          SELECT unnest(CASE
            WHEN keys.k = 'bar' THEN ARRAY['bar']
            WHEN keys.k = 'food-and-beverage' THEN ARRAY['restaurant','coffee','room-service']
            WHEN keys.k IN ('main-kitchen','pastry-and-bakery') THEN ARRAY['restaurant','room-service','banqueting']
            WHEN keys.k = 'sales-events-banqueting' THEN ARRAY['banqueting','restaurant']
            WHEN keys.k = 'front-office' THEN ARRAY['room-service','restaurant']
            WHEN keys.k = 'delivery' THEN ARRAY['delivery','restaurant']
            ELSE ARRAY['restaurant','bar','coffee','room-service','banqueting','delivery']
          END) AS o
        ) outlets
    )
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_floor_outlets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_floor_outlets() TO authenticated;

-- 3. The floor areas that staff member may work.
CREATE OR REPLACE FUNCTION public.neo_floor_areas(_branch uuid DEFAULT NULL)
RETURNS SETOF public.restaurant_areas
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT a.*
    FROM public.restaurant_areas a
   WHERE a.organization_id = public.current_org_id()
     AND (_branch IS NULL OR a.branch_id = _branch)
     AND public.neo_branch_in_scope(a.branch_id)
     AND a.outlet = ANY (public.neo_floor_outlets())
   ORDER BY a.display_order NULLS LAST, a.name;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_floor_areas(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_floor_areas(uuid) TO authenticated;