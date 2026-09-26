CREATE OR REPLACE FUNCTION public.neo_gl_pos_settlement_code(_order uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT coalesce(public.neo_gl_settlement_code(p.method), '1010')
    FROM public.pos_payments p
   WHERE p.order_id = _order
     AND p.status IN ('confirmed','paid','completed','captured','settled')
   ORDER BY p.amount DESC
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.neo_gl_pos_settlement_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_gl_pos_settlement_code(uuid) TO authenticated, service_role;