CREATE OR REPLACE FUNCTION public.neo_public_experiences(_branch uuid)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  price numeric,
  price_basis text,
  tax_rate numeric,
  min_guests integer,
  max_guests integer,
  valid_to date,
  event_type text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id,
         p.name,
         p.description,
         p.price,
         p.price_basis,
         p.tax_rate,
         p.min_guests,
         p.max_guests,
         p.valid_to,
         t.name AS event_type
  FROM public.event_packages p
  LEFT JOIN public.event_types t ON t.id = p.event_type_id
  JOIN public.branches b ON b.id = p.branch_id
  WHERE p.branch_id = _branch
    AND p.active IS TRUE
    AND b.active IS TRUE
    AND (p.valid_from IS NULL OR p.valid_from <= current_date)
    AND (p.valid_to IS NULL OR p.valid_to >= current_date)
  ORDER BY p.price NULLS LAST, p.name
  LIMIT 60;
$$;

REVOKE ALL ON FUNCTION public.neo_public_experiences(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.neo_public_experiences(uuid) TO anon, authenticated, service_role;