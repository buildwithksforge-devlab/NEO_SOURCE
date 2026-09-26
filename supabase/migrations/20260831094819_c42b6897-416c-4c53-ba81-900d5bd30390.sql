
-- 1. Kitchen routing: reject a send when any item has no production station
CREATE OR REPLACE FUNCTION public.neo_pos_route_tickets_internal(_order uuid, _org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o public.pos_orders; _it record; _station uuid; _ticket uuid; _target int;
  _created int := 0; _reused int := 0; _tickets int := 0; _unassigned int := 0;
BEGIN
  SELECT * INTO _o FROM public.pos_orders WHERE id = _order AND organization_id = _org;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_order::text, 42));

  FOR _it IN
    SELECT oi.* FROM public.pos_order_items oi
     WHERE oi.order_id = _order AND oi.organization_id = _org
       AND oi.held = false AND coalesce(oi.status,'draft') NOT IN ('cancelled','voided')
     ORDER BY oi.created_at
  LOOP
    IF EXISTS (SELECT 1 FROM public.station_ticket_items sti
                WHERE sti.order_item_id = _it.id AND sti.remake_of_id IS NULL) THEN
      _reused := _reused + 1; CONTINUE;
    END IF;

    _station := nullif(public.neo_kitchen_route_order_item(_it.id)->>'station_id','')::uuid;
    IF _station IS NULL THEN
      _unassigned := _unassigned + 1;
      CONTINUE;
    END IF;
    IF _station IS DISTINCT FROM _it.station_id THEN
      UPDATE public.pos_order_items SET station_id = _station WHERE id = _it.id;
    END IF;

    SELECT COALESCE(
      (SELECT pt.target_minutes FROM public.preparation_targets pt
        WHERE pt.organization_id = _org AND pt.active
          AND (pt.branch_id IS NULL OR pt.branch_id = _o.branch_id)
          AND ((pt.scope='menu-item' AND pt.menu_item_id = _it.menu_item_id)
            OR (pt.scope='station' AND pt.station_id = _station)
            OR (pt.scope='order-type' AND pt.order_type = _o.order_type)
            OR (pt.scope='branch'))
        ORDER BY CASE pt.scope WHEN 'menu-item' THEN 1 WHEN 'station' THEN 2 WHEN 'order-type' THEN 3 ELSE 4 END
        LIMIT 1),
      (SELECT mi.prep_minutes FROM public.menu_items mi WHERE mi.id = _it.menu_item_id),
      15) INTO _target;

    INSERT INTO public.station_tickets (
      organization_id, branch_id, department_id, order_id, station_id, ticket_number, course,
      priority, status, target_minutes, received_at, created_by, routing_note)
    VALUES (_org, _o.branch_id,
      (SELECT s.department_id FROM public.operational_stations s WHERE s.id = _station),
      _order, _station,
      'KT-' || upper(substr(replace(_order::text,'-',''),1,6)) || '-' ||
        upper(substr(md5(_station::text || _it.course), 1, 4)),
      _it.course, COALESCE(_o.order_type,'dine-in'), 'new', _target, now(), auth.uid(), NULL)
    ON CONFLICT (order_id, COALESCE(station_id, '00000000-0000-0000-0000-000000000000'::uuid), course)
      DO NOTHING;
    IF FOUND THEN _tickets := _tickets + 1; END IF;

    SELECT id INTO _ticket FROM public.station_tickets
      WHERE order_id = _order AND course = _it.course
        AND COALESCE(station_id,'00000000-0000-0000-0000-000000000000'::uuid) = _station;
    IF _ticket IS NULL THEN CONTINUE; END IF;

    BEGIN
      INSERT INTO public.station_ticket_items (organization_id, ticket_id, order_item_id, status)
      VALUES (_org, _ticket, _it.id, 'new');
      _created := _created + 1;
    EXCEPTION WHEN unique_violation THEN
      _reused := _reused + 1;
    END;

    UPDATE public.pos_order_items
       SET status = CASE WHEN status IN ('draft','new','held') THEN 'sent' ELSE status END,
           sent_at = COALESCE(sent_at, now())
     WHERE id = _it.id;
  END LOOP;

  IF _unassigned > 0 THEN
    RAISE EXCEPTION 'routing_unresolved: % item(s) have no production station configured for this property', _unassigned
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.pos_orders
     SET status = 'sent', sent_at = COALESCE(sent_at, now())
   WHERE id = _order AND (status IS NULL OR status IN ('draft','open','new','draft-sent','confirmed'));

  RETURN jsonb_build_object('ok', true, 'order_id', _order, 'tickets_created', _tickets,
                            'items_created', _created, 'items_reused', _reused,
                            'unassigned_station', 0);
END $function$;

-- 2. Notification render failures are never dispatched
CREATE TABLE IF NOT EXISTS public.notification_render_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  event_type text NOT NULL,
  record_id uuid,
  missing_variables text[] NOT NULL DEFAULT '{}',
  rendered_title text,
  rendered_body text,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.notification_render_failures TO authenticated;
GRANT ALL ON public.notification_render_failures TO service_role;
ALTER TABLE public.notification_render_failures ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notification_render_failures' AND policyname='render_failures_read') THEN
    CREATE POLICY "render_failures_read" ON public.notification_render_failures
      FOR SELECT TO authenticated
      USING (organization_id = public.current_org_id());
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.neo_notify_event(_org uuid, _user uuid, _branch uuid, _event text, _record uuid DEFAULT NULL::uuid, _vars jsonb DEFAULT '{}'::jsonb, _idem text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _t public.notification_templates; _title text; _body text; _link text; _k text; _missing text[];
BEGIN
  IF _org IS NULL OR _event IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO _t FROM public.notification_templates
   WHERE event_type = _event AND active
     AND (organization_id = _org OR organization_id IS NULL)
   ORDER BY organization_id NULLS LAST LIMIT 1;
  IF _t.id IS NULL THEN RETURN NULL; END IF;

  _title := _t.title_template; _body := _t.body_template; _link := _t.link_template;
  _vars := coalesce(_vars,'{}'::jsonb) || jsonb_build_object('record', coalesce(_record::text,''));
  FOR _k IN SELECT jsonb_object_keys(_vars) LOOP
    _title := replace(_title, '{{'||_k||'}}', coalesce(_vars->>_k,''));
    _body  := replace(_body,  '{{'||_k||'}}', coalesce(_vars->>_k,''));
    _link  := replace(coalesce(_link,''), '{{'||_k||'}}', coalesce(_vars->>_k,''));
  END LOOP;

  SELECT array_agg(DISTINCT m[1]) INTO _missing
    FROM regexp_matches(coalesce(_title,'')||' '||coalesce(_body,'')||' '||coalesce(_link,''),
                        '\{\{([a-zA-Z0-9_.]+)\}\}', 'g') AS m;

  IF _missing IS NOT NULL AND array_length(_missing,1) > 0 THEN
    INSERT INTO public.notification_render_failures
      (organization_id, branch_id, event_type, record_id, missing_variables, rendered_title, rendered_body, variables)
    VALUES (_org, _branch, _event, _record, _missing, _title, _body, _vars);
    RETURN NULL;
  END IF;

  RETURN public.neo_notify(_org, _user, _branch, _t.category, _title, _body,
    nullif(_link,''), _t.priority, _t.action_required, _t.source_module, _record, _event,
    coalesce(_idem, _event || ':' || coalesce(_record::text,'') || ':' || coalesce(_user::text,'all')));
END $function$;

-- 3. Emitters supply every variable the templates require
CREATE OR REPLACE FUNCTION public.neo_event_station_ticket_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _ref text; _station text; _count int;
BEGIN
  SELECT order_number INTO _ref FROM public.pos_orders WHERE id = NEW.order_id;
  SELECT s.name INTO _station FROM public.operational_stations s WHERE s.id = NEW.station_id;
  SELECT count(*)::int INTO _count FROM public.station_ticket_items sti WHERE sti.ticket_id = NEW.id;
  PERFORM public.emit_domain_event(
    NEW.organization_id, NEW.branch_id, 'pos.ticket_routed', 'kitchen', NEW.order_id,
    jsonb_build_object(
      'reference', COALESCE(_ref, NEW.ticket_number, ''),
      'ticket_id', NEW.id,
      'ticket_number', COALESCE(NEW.ticket_number, ''),
      'station_id', NEW.station_id,
      'station', COALESCE(_station, 'Unassigned station'),
      'count', GREATEST(COALESCE(_count,0), 1),
      'department_id', NEW.department_id,
      'branch_id', NEW.branch_id,
      'priority', COALESCE(NEW.priority, 'normal')
    ),
    'pos.ticket_routed:' || NEW.id::text
  );
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.ev_pos_order_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.emit_domain_event(
    NEW.organization_id, NEW.branch_id, 'order.created', 'pos', NEW.id,
    jsonb_build_object(
      'reference', COALESCE(NEW.order_number, ''),
      'order_number', NEW.order_number,
      'order_type', COALESCE(NEW.order_type, 'dine-in'),
      'status', NEW.status,
      'total_amount', NEW.grand_total,
      'guest_count', NEW.guest_count,
      'station_id', NEW.station_id,
      'department_id', NEW.department_id
    ),
    'order.created:' || NEW.id, NEW.customer_id);
  RETURN NEW;
END; $function$;

-- 4. One receipt number and one payment attempt key per organisation
CREATE UNIQUE INDEX IF NOT EXISTS payments_org_receipt_unique
  ON public.payments (organization_id, receipt_number)
  WHERE receipt_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payments_org_idempotency_unique
  ON public.payments (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 5. One live purchase order per approved requisition
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_one_live_per_request
  ON public.purchase_orders (request_id)
  WHERE request_id IS NOT NULL
    AND COALESCE(status,'draft') NOT IN ('cancelled','void','voided','rejected');

CREATE OR REPLACE FUNCTION public.neo_sync_request_ordered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.request_id IS NOT NULL
     AND COALESCE(NEW.status,'draft') NOT IN ('cancelled','void','voided','rejected') THEN
    UPDATE public.purchase_requests
       SET status = 'ordered', updated_at = now()
     WHERE id = NEW.request_id
       AND organization_id = NEW.organization_id
       AND COALESCE(status,'draft') IN ('approved','pending_approval');
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_sync_request_ordered ON public.purchase_orders;
CREATE TRIGGER trg_sync_request_ordered
AFTER INSERT OR UPDATE OF status ON public.purchase_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_sync_request_ordered();

UPDATE public.purchase_requests pr
   SET status = 'ordered', updated_at = now()
 WHERE COALESCE(pr.status,'draft') = 'approved'
   AND EXISTS (SELECT 1 FROM public.purchase_orders po
                WHERE po.request_id = pr.id
                  AND COALESCE(po.status,'draft') NOT IN ('cancelled','void','voided','rejected'));

-- 6. Accounts payable reads the matching result, never a separate derivation
CREATE OR REPLACE FUNCTION public.neo_ap_match_summary(_invoice uuid)
 RETURNS TABLE(matched_amount numeric, variance numeric, exception_lines integer, variance_lines integer, derived_match_status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH l AS (SELECT * FROM public.neo_ap_match_lines(_invoice))
  SELECT
    COALESCE(sum(CASE WHEN l.match_state = 'matched' THEN l.line_total ELSE 0 END),0),
    COALESCE(sum(CASE WHEN l.match_state <> 'matched' THEN l.line_total ELSE 0 END),0),
    COALESCE(count(*) FILTER (WHERE l.match_state = 'exception'),0)::int,
    COALESCE(count(*) FILTER (WHERE l.match_state = 'variance'),0)::int,
    CASE
      WHEN count(*) = 0 THEN 'unmatched'
      WHEN count(*) FILTER (WHERE l.match_state = 'exception') > 0 THEN 'held'
      WHEN count(*) FILTER (WHERE l.match_state = 'variance') > 0 THEN 'review'
      ELSE 'matched'
    END
  FROM l;
$function$;

CREATE OR REPLACE FUNCTION public.neo_ap_journal_register(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date, _match_status text DEFAULT NULL::text, _limit integer DEFAULT 300)
 RETURNS TABLE(invoice_id uuid, invoice_number text, invoice_date date, due_date date, supplier_id uuid, supplier_name text, branch_id uuid, property text, order_id uuid, order_number text, receipt_id uuid, grn_number text, amount numeric, tax_amount numeric, matched_amount numeric, paid_amount numeric, variance numeric, status text, match_status text, exception_count integer, critical_count integer, line_count integer, journal_id uuid, journal_number text, journal_status text, accounting_date date, total_debit numeric, total_credit numeric, balanced boolean, posted_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid:=public.current_org_id();
BEGIN
 IF _org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','ap.view') OR public.has_permission('finance','view') OR public.can_read_general_ledger()) THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
 RETURN QUERY
 SELECT si.id,si.invoice_number,si.invoice_date,si.due_date,si.supplier_id,s.name,si.branch_id,b.name,si.order_id,po.order_number,si.receipt_id,gr.grn_number,
   COALESCE(si.amount,0),COALESCE(si.tax_amount,0),
   COALESCE(ms.matched_amount, COALESCE(si.matched_amount,0)),
   COALESCE(si.paid_amount,0),
   COALESCE(ms.variance, COALESCE(si.variance,0)),
   si.status,
   COALESCE(NULLIF(ms.derived_match_status,'unmatched'), COALESCE(si.match_status,'unmatched')),
   (SELECT count(*)::int FROM public.supplier_invoice_discrepancies d WHERE d.supplier_invoice_id=si.id AND d.resolved=false),
   (SELECT count(*)::int FROM public.supplier_invoice_discrepancies d WHERE d.supplier_invoice_id=si.id AND d.resolved=false AND d.severity='critical'),
   (SELECT count(*)::int FROM public.supplier_invoice_lines il WHERE il.supplier_invoice_id=si.id),
   j.id,j.journal_number,j.status,j.accounting_date,COALESCE(j.total_debit,0),COALESCE(j.total_credit,0),
   CASE WHEN j.id IS NULL THEN false ELSE abs(COALESCE(j.total_debit,0)-COALESCE(j.total_credit,0))<0.01 END,j.posted_at
 FROM public.supplier_invoices si
 LEFT JOIN public.suppliers s ON s.id=si.supplier_id
 LEFT JOIN public.branches b ON b.id=si.branch_id
 LEFT JOIN public.purchase_orders po ON po.id=si.order_id
 LEFT JOIN public.goods_receipts gr ON gr.id=si.receipt_id
 LEFT JOIN public.journal_entries j ON j.id=si.journal_id
 LEFT JOIN LATERAL public.neo_ap_match_summary(si.id) ms ON true
 WHERE si.organization_id=_org AND (_branch IS NULL OR si.branch_id=_branch) AND (_from IS NULL OR si.invoice_date>=_from) AND (_to IS NULL OR si.invoice_date<=_to)
   AND (_match_status IS NULL OR COALESCE(NULLIF(ms.derived_match_status,'unmatched'), COALESCE(si.match_status,'unmatched'))=_match_status)
 ORDER BY si.invoice_date DESC NULLS LAST,si.created_at DESC LIMIT greatest(1,least(COALESCE(_limit,300),1000));
END;
$function$;
