CREATE OR REPLACE FUNCTION public.neo_canonical_posting_module(_module text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE lower(coalesce(_module,''))
           WHEN 'pos_order' THEN 'pos'
           WHEN 'laundry_order' THEN 'laundry'
           WHEN 'delivery_order' THEN 'delivery'
           WHEN 'event_booking' THEN 'events'
           ELSE lower(coalesce(_module,''))
         END
$$;