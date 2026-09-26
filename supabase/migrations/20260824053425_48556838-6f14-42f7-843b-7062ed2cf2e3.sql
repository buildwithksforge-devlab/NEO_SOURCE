CREATE OR REPLACE FUNCTION public.neo_gl_revenue_code(_category text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH n AS (
    SELECT replace(replace(lower(btrim(coalesce(_category,'other'))), '-', '_'), ' ', '_') AS c
  )
  SELECT CASE (SELECT c FROM n)
    WHEN 'accommodation' THEN '4010' WHEN 'room' THEN '4010' WHEN 'rooms' THEN '4010'
    WHEN 'lodging' THEN '4010'
    WHEN 'meal_plan' THEN '4020' WHEN 'restaurant' THEN '4020' WHEN 'food' THEN '4020'
    WHEN 'fnb' THEN '4020' WHEN 'f_b' THEN '4020' WHEN 'dining' THEN '4020'
    WHEN 'kitchen' THEN '4020' WHEN 'dine_in' THEN '4020' WHEN 'takeaway' THEN '4020'
    WHEN 'take_away' THEN '4020' WHEN 'takeout' THEN '4020' WHEN 'counter' THEN '4020'
    WHEN 'quick_service' THEN '4020' WHEN 'pickup' THEN '4020' WHEN 'walk_in' THEN '4020'
    WHEN 'buffet' THEN '4020' WHEN 'banquet_food' THEN '4020' WHEN 'cafe' THEN '4020'
    WHEN 'bar' THEN '4030' WHEN 'beverage' THEN '4030' WHEN 'beverages' THEN '4030'
    WHEN 'drinks' THEN '4030' WHEN 'minibar' THEN '4030' WHEN 'poolbar' THEN '4030'
    WHEN 'pool_bar' THEN '4030'
    WHEN 'room_service' THEN '4040' WHEN 'in_room_dining' THEN '4040'
    WHEN 'laundry' THEN '4050' WHEN 'dry_cleaning' THEN '4050'
    WHEN 'event' THEN '4060' WHEN 'events' THEN '4060' WHEN 'banquet' THEN '4060'
    WHEN 'conference' THEN '4060'
    WHEN 'delivery' THEN '4070'
    WHEN 'transport' THEN '4080' WHEN 'airport_transfer' THEN '4080'
    ELSE '4090' END;
$$;

REVOKE ALL ON FUNCTION public.neo_gl_revenue_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_gl_revenue_code(text) TO authenticated, service_role;