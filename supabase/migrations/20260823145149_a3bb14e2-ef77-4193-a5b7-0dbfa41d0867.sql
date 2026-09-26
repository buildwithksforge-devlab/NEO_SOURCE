-- UAT Scenario 2 defect: the kitchen station guard tested for an access scope
-- value ('station') that the visibility contract never produces, so it never
-- fired. A Pastry chef was able to advance a Hot Kitchen ticket. Replace it
-- with the canonical in_my_scope predicate on both the item-level and the
-- ticket-level contracts.

CREATE OR REPLACE FUNCTION public.neo_kitchen_assert_ticket_scope(_ticket uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _t record;
BEGIN
  SELECT * INTO _t FROM public.station_tickets WHERE id = _ticket;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Ticket not found'; END IF;
  IF NOT public.in_my_scope(_t.organization_id, _t.branch_id, _t.department_id,
                            _t.station_id, _t.assigned_chef_id, _t.created_by) THEN
    RAISE EXCEPTION 'Ticket % belongs to a station outside your assigned stations', _t.ticket_number
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_kitchen_assert_ticket_scope(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_assert_ticket_scope(uuid) TO authenticated, service_role;
