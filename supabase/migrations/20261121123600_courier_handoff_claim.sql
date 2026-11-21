DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_dispatch_jobs'::regclass
      AND tgname = 'neo_guard_courier_handoff' AND tgenabled IN ('O', 'A'))
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_orders'::regclass
      AND tgname = 'neo_guard_rider_assignment_during_courier_handoff' AND tgenabled IN ('O', 'A')) THEN
    RAISE EXCEPTION 'Apply the courier handoff exclusivity migration before installing the courier claim.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_delivery_dispatch_claim(_job uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  org uuid := public.current_org_id();
BEGIN
  IF auth.uid() IS NULL OR org IS NULL OR NOT coalesce(
    public.has_permission('delivery', 'dispatch', 'assign') OR public.has_permission('delivery', 'edit'), false
  ) THEN
    RAISE EXCEPTION 'Not permitted to dispatch delivery orders.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.delivery_dispatch_jobs
  SET state = 'sent', state_detail = 'Handoff started. Waiting for courier confirmation.', updated_at = now()
  WHERE id = _job AND organization_id = org AND state = 'requested'
    AND (branch_id IS NULL OR public.neo_branch_in_scope(branch_id));
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_delivery_dispatch_claim(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_dispatch_claim(uuid) TO authenticated;
