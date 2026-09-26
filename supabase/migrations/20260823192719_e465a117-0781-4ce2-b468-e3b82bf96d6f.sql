-- =====================================================================
-- CROSS-MODULE REGRESSION FIXES
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. FOLIO CHARGE IDEMPOTENCY
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.folio_post_charge(
  _folio uuid, _category text, _description text, _quantity numeric, _unit_price numeric,
  _tax numeric DEFAULT 0, _service_charge numeric DEFAULT 0, _discount numeric DEFAULT 0,
  _source_module text DEFAULT 'manual'::text, _source_record uuid DEFAULT NULL::uuid,
  _revenue_centre text DEFAULT 'rooms'::text, _idempotency_key text DEFAULT NULL::text,
  _correlation uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _f public.folios; _gross numeric; _net numeric; _id uuid;
        _key text := COALESCE(
          _idempotency_key,
          CASE
            WHEN _source_record IS NOT NULL
              THEN _source_module || ':' || _source_record::text
            ELSE 'auto:' || _folio::text
                 || ':' || COALESCE(_category, '')
                 || ':' || md5(COALESCE(_description, ''))
                 || ':' || to_char(round(COALESCE(_quantity,1) * COALESCE(_unit_price,0), 2), 'FM9999999999990.00')
                 || ':' || to_char(date_trunc('minute', now() AT TIME ZONE 'UTC'), 'YYYYMMDDHH24MI')
          END);
BEGIN
  IF NOT (public.has_permission('pms','folios.post_charge') OR public.neo_system_posting()) THEN
    RAISE EXCEPTION 'Not permitted to post charges';
  END IF;
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _f.status <> 'open' THEN RAISE EXCEPTION 'Folio is % and cannot accept charges', _f.status; END IF;

  SELECT id INTO _id FROM public.folio_lines WHERE organization_id=_org AND idempotency_key=_key;
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  IF _f.corporate_account_id IS NOT NULL THEN
    PERFORM public.corp_assert_credit(_f.corporate_account_id, _f.branch_id, _f.customer_id,
      round(COALESCE(_quantity,1)*COALESCE(_unit_price,0),2) + COALESCE(_tax,0) + COALESCE(_service_charge,0));
  END IF;

  _gross := round(COALESCE(_quantity,1) * COALESCE(_unit_price,0), 2);
  _net := _gross - COALESCE(_discount,0) + COALESCE(_tax,0) + COALESCE(_service_charge,0);

  INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, customer_id, line_type,
    category, revenue_centre, reference, source_module, source_record_id, source_record_uuid, idempotency_key,
    description, quantity, unit_price, gross_amount, discount_amount, tax_amount, service_charge_amount,
    net_amount, posted_by, actor_id, correlation_id, status)
  VALUES (_org, _f.branch_id, _folio, _f.reservation_id, _f.customer_id, 'charge',
    _category, COALESCE(_revenue_centre,'rooms'), COALESCE(_source_record::text,''), _source_module,
    _source_record::text, _source_record, _key, _description, COALESCE(_quantity,1), COALESCE(_unit_price,0),
    _gross, COALESCE(_discount,0), COALESCE(_tax,0), COALESCE(_service_charge,0), _net,
    auth.uid(), auth.uid(), COALESCE(_correlation, gen_random_uuid()), 'posted')
  RETURNING id INTO _id;

  UPDATE public.folios SET
    total_charges = total_charges + _gross,
    total_discounts = total_discounts + COALESCE(_discount,0),
    total_taxes = total_taxes + COALESCE(_tax,0),
    balance = balance + _net, updated_at = now()
  WHERE id=_folio;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'pms.folio.post_charge', 'finance', _folio::text,
    jsonb_build_object('line_id',_id,'category',_category,'amount',_net,'source',_source_module,'revenue_centre',_revenue_centre));
  RETURN _id;
END; $function$;

REVOKE EXECUTE ON FUNCTION public.folio_post_charge(uuid,text,text,numeric,numeric,numeric,numeric,numeric,text,uuid,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.folio_post_charge(uuid,text,text,numeric,numeric,numeric,numeric,numeric,text,uuid,text,text,uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. INVENTORY LEDGER READ GATE
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_read_stock()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public.has_permission('inventory','stock','view')
      OR public.has_permission('inventory','stock','manage')
      OR public.has_permission('inventory','dashboard','view')
      OR public.has_permission('stores','overview','view')
      OR public.has_permission('stores','issues','view')
      OR public.has_permission('stores','reconciliation','view')
      OR public.has_permission('procurement','receiving','view')
      OR public.is_org_admin()
$$;
REVOKE EXECUTE ON FUNCTION public.can_read_stock() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_stock() TO authenticated;

DROP POLICY IF EXISTS stock_movements_select ON public.stock_movements;
CREATE POLICY stock_movements_select ON public.stock_movements FOR SELECT TO authenticated
USING (
  public.can_read_stock()
  AND (
    public.in_my_config_scope(organization_id, branch_id)
    OR EXISTS (SELECT 1 FROM public.stock_locations l
                WHERE l.id = stock_movements.location_id
                  AND public.in_my_config_scope(l.organization_id, l.branch_id))
  )
);

DROP POLICY IF EXISTS stock_levels_select ON public.stock_levels;
CREATE POLICY stock_levels_select ON public.stock_levels FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND public.can_read_stock()
  AND (
    (location_id IS NULL AND public.in_my_config_scope(organization_id, NULL::uuid))
    OR EXISTS (SELECT 1 FROM public.stock_locations l
                WHERE l.id = stock_levels.location_id
                  AND public.in_my_config_scope(l.organization_id, l.branch_id))
  )
);

-- ---------------------------------------------------------------------
-- 3. EXACTLY ONE PRIMARY ROLE PER USER
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_user_roles_enforce_primary()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _user uuid := COALESCE(NEW.user_id, OLD.user_id);
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;

  IF TG_OP <> 'DELETE' AND COALESCE(NEW.is_primary, false) THEN
    UPDATE public.user_roles
       SET is_primary = false
     WHERE user_id = _user AND id <> NEW.id AND COALESCE(is_primary, false);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_roles
                  WHERE user_id = _user AND COALESCE(is_primary, false)) THEN
    UPDATE public.user_roles ur SET is_primary = true
     WHERE ur.id = (
       SELECT ur2.id FROM public.user_roles ur2
        JOIN public.roles r ON r.id = ur2.role_id
        WHERE ur2.user_id = _user
        ORDER BY COALESCE(r.position_level, 999), r.name, ur2.id
        LIMIT 1);
  END IF;

  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_user_roles_enforce_primary() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_user_roles_primary ON public.user_roles;
CREATE TRIGGER trg_user_roles_primary
AFTER INSERT OR DELETE OR UPDATE OF is_primary, role_id ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.neo_user_roles_enforce_primary();

WITH missing AS (
  SELECT ur.user_id
    FROM public.user_roles ur
   GROUP BY ur.user_id
  HAVING bool_and(COALESCE(ur.is_primary, false) = false)
), pick AS (
  SELECT DISTINCT ON (ur.user_id) ur.id
    FROM public.user_roles ur
    JOIN missing m ON m.user_id = ur.user_id
    JOIN public.roles r ON r.id = ur.role_id
   ORDER BY ur.user_id, COALESCE(r.position_level, 999), r.name, ur.id
)
UPDATE public.user_roles ur SET is_primary = true
  FROM pick WHERE ur.id = pick.id;

-- ---------------------------------------------------------------------
-- 4. LAUNDRY THAT NEVER REACHED A FOLIO
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_autopost_on_finalise()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _res jsonb; _room text;
BEGIN
  IF TG_TABLE_NAME = 'pos_orders' THEN
    IF NEW.status IN ('closed','paid','settled','completed')
       AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.folio_id IS NOT NULL
       AND NEW.folio_post_status IS DISTINCT FROM 'posted' THEN
      PERFORM public.neo_finance_post_source('pos', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'guest_laundry_orders' THEN
    IF NEW.status IN ('delivered','completed','closed')
       AND COALESCE(NEW.posting_status,'unposted') IS DISTINCT FROM 'posted'
       AND (NEW.status IS DISTINCT FROM OLD.status
            OR NEW.total IS DISTINCT FROM OLD.total
            OR NEW.folio_id IS DISTINCT FROM OLD.folio_id) THEN
      _res := public.neo_finance_post_source('laundry', NEW.id, true);
      IF NOT COALESCE((_res->>'ok')::boolean, false) THEN
        NEW.posting_status := 'blocked';
        SELECT room_number INTO _room FROM public.rooms WHERE id = NEW.room_id;
        PERFORM public.neo_notify(
          NEW.organization_id, NULL, NEW.branch_id, 'operational-alert',
          format('Guest laundry %s is not billed', COALESCE(NEW.laundry_number, '')),
          COALESCE(_res->>'detail', 'The laundry charge could not reach a guest folio.')
            || CASE WHEN _room IS NOT NULL THEN ' Room ' || _room || '.' ELSE '' END,
          '/laundry?order=' || NEW.id::text, 'high', true,
          'laundry', NEW.id, 'laundry.posting_blocked',
          'laundry-blocked:' || NEW.id::text || ':' || COALESCE(NEW.total,0)::text);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS guest_laundry_orders_autopost ON public.guest_laundry_orders;
CREATE TRIGGER guest_laundry_orders_autopost
BEFORE UPDATE ON public.guest_laundry_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_on_finalise();

CREATE OR REPLACE FUNCTION public.neo_laundry_retry_posting(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _res jsonb;
BEGIN
  IF NOT (public.has_permission('laundry','orders','edit')
          OR public.has_permission('laundry','orders','approve')
          OR public.has_permission('pms','folios','post_charge')
          OR public.has_permission('finance','postings','edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to re-post laundry charges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.guest_laundry_orders
                  WHERE id = _order AND organization_id = _org) THEN
    RAISE EXCEPTION 'Unknown laundry order';
  END IF;
  _res := public.neo_finance_post_source('laundry', _order, true);
  UPDATE public.guest_laundry_orders
     SET posting_status = CASE WHEN COALESCE((_res->>'ok')::boolean,false)
                               THEN posting_status ELSE 'blocked' END
   WHERE id = _order AND COALESCE(posting_status,'unposted') <> 'posted';
  RETURN _res;
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_laundry_retry_posting(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_laundry_retry_posting(uuid) TO authenticated;

UPDATE public.guest_laundry_orders
   SET posting_status = 'blocked'
 WHERE status IN ('delivered','completed','closed')
   AND COALESCE(posting_status,'unposted') = 'unposted'
   AND COALESCE(total,0) > 0;

-- ---------------------------------------------------------------------
-- 5. NOTIFICATION CATEGORY CONTRACT + DUPLICATE HOUSEKEEPING NOTICES
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_canonical_notification_category(_category text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE lower(coalesce(_category,''))
    WHEN 'task' THEN 'tasks'
    WHEN 'task-assignment' THEN 'tasks'
    WHEN 'kitchen' THEN 'tasks'
    WHEN 'approval' THEN 'approvals'
    WHEN 'operations' THEN 'operational-alert'
    WHEN 'system-alert' THEN 'operational-alert'
    WHEN 'alert' THEN 'operational-alert'
    WHEN '' THEN 'operational-alert'
    ELSE lower(_category)
  END
$$;

CREATE OR REPLACE FUNCTION public.neo_normalise_notification()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  NEW.category := public.neo_canonical_notification_category(NEW.category);
  IF NEW.category NOT IN ('tasks','approvals','operational-alert','workflow') THEN
    NEW.category := 'operational-alert';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notifications_normalise ON public.notifications;
CREATE TRIGGER trg_notifications_normalise
BEFORE INSERT OR UPDATE OF category ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.neo_normalise_notification();

UPDATE public.notifications
   SET category = public.neo_canonical_notification_category(category)
 WHERE category IS DISTINCT FROM public.neo_canonical_notification_category(category);

UPDATE public.notifications SET category = 'operational-alert'
 WHERE category NOT IN ('tasks','approvals','operational-alert','workflow');

CREATE OR REPLACE FUNCTION public.neo_housekeeping_room_state()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.room_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'in-progress' THEN
      UPDATE rooms SET housekeeping_status = 'in-progress', updated_at = now() WHERE id = NEW.room_id;
    ELSIF NEW.status = 'completed' THEN
      UPDATE rooms
         SET housekeeping_status = CASE WHEN NEW.inspection_required THEN 'awaiting-inspection' ELSE 'clean' END,
             last_cleaned_at = now(), updated_at = now()
       WHERE id = NEW.room_id;
    END IF;
  END IF;

  IF NEW.inspection_status IS DISTINCT FROM OLD.inspection_status THEN
    IF NEW.inspection_status = 'passed' THEN
      UPDATE rooms SET housekeeping_status = 'inspected', last_inspected_at = now(), updated_at = now()
       WHERE id = NEW.room_id;
      UPDATE notifications SET status = 'resolved', acted_at = now()
       WHERE source_module = 'housekeeping' AND source_record_id = NEW.id AND status = 'open';
    ELSIF NEW.inspection_status = 'failed' THEN
      UPDATE rooms SET housekeeping_status = 'rework', sellable = false, updated_at = now()
       WHERE id = NEW.room_id;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
