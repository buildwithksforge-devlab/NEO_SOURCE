CREATE OR REPLACE FUNCTION public.pos_open_folio_for_stay(_stay uuid)
RETURNS TABLE(id uuid, folio_number text, status text, balance numeric, currency text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT (public.is_org_admin()
          OR public.has_permission('restaurant','orders','view')
          OR public.can_read_guest_ledger()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT f.id, f.folio_number, f.status, f.balance, f.currency
  FROM public.folios f
  WHERE f.stay_id = _stay
    AND f.status = 'open'
    AND f.organization_id = public.current_org_id()
    AND public.in_my_branch_scope(f.organization_id, f.branch_id)
  ORDER BY f.created_at
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.pos_open_folio_for_stay(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_open_folio_for_stay(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.pos_open_folio_for_stay(uuid) TO authenticated, service_role;