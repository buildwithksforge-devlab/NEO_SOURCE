-- Cash settlement must bank into the caller's open till automatically, the same
-- way Front Office receipting was repaired. Previously the caller had to pass
-- the shift explicitly, so a cash bill failed with "Cash payments must
-- reference an open cashier shift" even with an open till.
CREATE OR REPLACE FUNCTION public.pos_resolve_open_shift(_branch uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT s.id FROM public.pos_shifts s
   WHERE s.organization_id = public.current_org_id()
     AND s.status = 'open'
     AND s.cashier_id = auth.uid()
     AND (_branch IS NULL OR s.branch_id = _branch)
   ORDER BY s.opened_at DESC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.pos_resolve_open_shift(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_resolve_open_shift(uuid) TO authenticated, service_role;