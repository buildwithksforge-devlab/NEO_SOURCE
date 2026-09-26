-- 1) Scoped escape hatch for removing an isolated automated-test workspace.
--    The bypass only applies when the caller has set neo.test_purge to the exact
--    organisation being removed, which only the purge routine below does.

CREATE OR REPLACE FUNCTION public.neo_reservation_history_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('neo.test_purge', true) IS NOT NULL
     AND current_setting('neo.test_purge', true) = OLD.organization_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Reservation history is immutable';
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_folio_line_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _status text;
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('neo.test_purge', true) IS NOT NULL
     AND current_setting('neo.test_purge', true) = OLD.organization_id::text THEN
    RETURN OLD;
  END IF;
  SELECT status INTO _status FROM public.folios
   WHERE id = COALESCE(NEW.folio_id, OLD.folio_id);
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Folio charges cannot be deleted. Post a reversal or credit note instead.';
  END IF;
  IF _status IN ('closed','settled','invoiced') AND current_setting('neo.folio_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Folio is % and cannot be edited. Reopen it or post a credit note/reversal.', _status;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted'
     AND (NEW.gross_amount IS DISTINCT FROM OLD.gross_amount
       OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount)
     AND current_setting('neo.folio_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Posted folio charges are immutable. Use a reversal, allowance or credit note.';
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.fin_protect_posted_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('neo.test_purge', true) IS NOT NULL
       AND current_setting('neo.test_purge', true) = OLD.organization_id::text THEN
      RETURN OLD;
    END IF;
    IF OLD.status IN ('posted','reversed') THEN RAISE EXCEPTION 'Posted journals cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' AND NEW.status NOT IN ('posted','reversed') THEN
    RAISE EXCEPTION 'Posted journals are immutable';
  END IF;
  IF OLD.status IN ('posted','reversed') AND (
      NEW.total_debit <> OLD.total_debit OR NEW.total_credit <> OLD.total_credit
      OR NEW.accounting_date <> OLD.accounting_date OR NEW.journal_number <> OLD.journal_number) THEN
    RAISE EXCEPTION 'Posted journals are immutable';
  END IF;
  RETURN NEW;
END $function$;

-- 2) Complete, retry-safe removal of one isolated test workspace.
CREATE OR REPLACE FUNCTION public.neo_test_purge_org(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _name text;
  _registered boolean;
BEGIN
  SELECT name INTO _name FROM public.organizations WHERE id = _org;
  IF _name IS NULL THEN
    RETURN jsonb_build_object('removed', false, 'reason', 'not_found');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.neo_test_environments WHERE test_org_id = _org)
    INTO _registered;

  IF _name NOT LIKE 'NEØ Test Organization%' AND NOT _registered THEN
    RAISE EXCEPTION 'Refusing to purge % — it is not an automated test workspace', _name;
  END IF;

  PERFORM set_config('neo.test_purge', _org::text, true);

  DELETE FROM public.role_permissions WHERE organization_id = _org;
  DELETE FROM public.approval_rules WHERE organization_id = _org;
  DELETE FROM public.audit_logs WHERE organization_id = _org;
  DELETE FROM public.domain_events WHERE organization_id = _org;
  DELETE FROM public.notifications WHERE organization_id = _org;
  DELETE FROM public.communication_queue WHERE organization_id = _org;
  DELETE FROM public.reservation_history WHERE organization_id = _org;
  DELETE FROM public.folio_lines WHERE organization_id = _org;
  DELETE FROM public.journal_entries WHERE organization_id = _org;

  DELETE FROM public.organizations WHERE id = _org;

  PERFORM set_config('neo.test_purge', '', true);
  RETURN jsonb_build_object('removed', true, 'organization', _org, 'label', _name);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_test_purge_org(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_test_purge_org(uuid) TO service_role;

-- 3) Post-purge verification: proves nothing of the workspace remains.
CREATE OR REPLACE FUNCTION public.neo_test_purge_verify(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _res jsonb := '{}'::jsonb;
  _t text;
  _n bigint;
  _tables text[] := ARRAY[
    'profiles','employees','branches','departments','roles','user_roles','customers',
    'reservations','folios','folio_lines','payments','pos_orders','station_tickets',
    'purchase_requests','purchase_orders','goods_receipts','housekeeping_jobs',
    'maintenance_work_orders','event_bookings','event_payments','notifications',
    'audit_logs','domain_events','communication_queue','stock_items','stock_levels',
    'journal_entries','reservation_history'
  ];
BEGIN
  FOREACH _t IN ARRAY _tables LOOP
    IF to_regclass('public.' || _t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', _t)
      INTO _n USING _org;
    IF _n > 0 THEN _res := _res || jsonb_build_object(_t, _n); END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'organization_exists', EXISTS (SELECT 1 FROM public.organizations WHERE id = _org),
    'remaining', _res,
    'clean', NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = _org) AND _res = '{}'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_test_purge_verify(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_test_purge_verify(uuid) TO service_role;