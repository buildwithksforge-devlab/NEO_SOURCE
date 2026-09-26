-- 1. Internal-only routines: no direct call path from the browser.
REVOKE EXECUTE ON FUNCTION public.notify_recipients(text, text, text, text, text, uuid, uuid, text[], text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.void_document_number(text, text, text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.hk_reconcile_room_conditions() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_approval_ensure_types() FROM anon, authenticated, PUBLIC;

GRANT EXECUTE ON FUNCTION public.notify_recipients(text, text, text, text, text, uuid, uuid, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.void_document_number(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.hk_reconcile_room_conditions() TO service_role;
GRANT EXECUTE ON FUNCTION public.neo_approval_ensure_types() TO service_role;

-- 2. Waitlist: front-office capability required, in addition to the org scope.
CREATE OR REPLACE FUNCTION public.pms_waitlist_offer(_entry uuid, _rate numeric, _expires timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE w public.waitlist_entries;
BEGIN
  IF NOT (public.has_permission('pms','reservations.edit') OR public.has_permission('pms','write')) THEN
    RAISE EXCEPTION 'Not permitted to manage the waitlist';
  END IF;
  SELECT * INTO w FROM public.waitlist_entries WHERE id=_entry AND organization_id=public.current_org_id();
  IF w.id IS NULL THEN RAISE EXCEPTION 'Waitlist entry not found'; END IF;
  IF w.status NOT IN ('waiting','offered') THEN RAISE EXCEPTION 'Entry is % and cannot be offered', w.status; END IF;
  UPDATE public.waitlist_entries
     SET status='offered', quoted_rate=COALESCE(_rate, quoted_rate), offered_at=now(),
         offer_expires_at=COALESCE(_expires, now() + interval '24 hours'), updated_at=now()
   WHERE id=_entry;
  RETURN jsonb_build_object('ok', true);
END; $function$;

CREATE OR REPLACE FUNCTION public.pms_waitlist_close(_entry uuid, _status text, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_permission('pms','reservations.edit') OR public.has_permission('pms','write')) THEN
    RAISE EXCEPTION 'Not permitted to manage the waitlist';
  END IF;
  IF _status NOT IN ('cancelled','expired','declined') THEN RAISE EXCEPTION 'Unsupported close status %', _status; END IF;
  IF COALESCE(btrim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required to close a waitlist entry'; END IF;
  UPDATE public.waitlist_entries
     SET status=_status, closed_reason=_reason, updated_at=now()
   WHERE id=_entry AND organization_id=public.current_org_id() AND status IN ('waiting','offered');
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found or already closed'; END IF;
  RETURN jsonb_build_object('ok', true);
END; $function$;

-- 3. Kitchen reconciliation: kitchen capability required in front of the existing org guard.
CREATE OR REPLACE FUNCTION public.neo_kitchen_reconcile_stations_guard()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_permission('kitchen','queue.manage')
          OR public.has_permission('kitchen','all_stations')
          OR public.has_permission('kitchen','access')) THEN
    RAISE EXCEPTION 'Not permitted to reconcile kitchen stations';
  END IF;
END; $function$;

REVOKE EXECUTE ON FUNCTION public.neo_kitchen_reconcile_stations_guard() FROM anon, authenticated, PUBLIC;