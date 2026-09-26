-- 1. Approve now parks the order in an explicit pending-delivery stage and raises a chase task.
CREATE OR REPLACE FUNCTION public.neo_procurement_order_approve(_order uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _p record; _dept uuid; _supplier text; _due timestamptz;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  SELECT * INTO _p FROM public.purchase_orders WHERE id=_order AND organization_id=_org FOR UPDATE;
  IF _p IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF NOT (public.has_permission('procurement','lpos.approve') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;
  IF _p.status NOT IN ('draft','pending_approval','pending-approval') THEN
    RAISE EXCEPTION 'order_not_approvable' USING ERRCODE='22023';
  END IF;

  UPDATE public.purchase_orders
     SET status='pending-delivery', approved_by=auth.uid(), approved_at=now(), updated_at=now()
   WHERE id=_order;

  SELECT s.name INTO _supplier FROM public.suppliers s WHERE s.id=_p.supplier_id;

  SELECT d.id INTO _dept
    FROM public.departments d
   WHERE d.organization_id=_org
     AND (d.branch_id = _p.branch_id OR d.branch_id IS NULL)
     AND d.name ILIKE '%procure%'
   ORDER BY (d.branch_id = _p.branch_id) DESC
   LIMIT 1;

  _due := COALESCE(_p.expected_date::timestamptz, now() + interval '3 days');

  INSERT INTO public.tasks (organization_id, branch_id, department_id, reference, title, description,
                            due_at, priority, status, created_by)
  VALUES (_org, _p.branch_id, _dept, 'po-followup:'||_order::text,
          'Follow up delivery — '||COALESCE(_p.order_number,'purchase order'),
          'Approved purchase order '||COALESCE(_p.order_number,'')||
          ' is awaiting delivery from '||COALESCE(_supplier,'the supplier')||
          '. Confirm the delivery date and chase anything outstanding.',
          _due, 'normal', 'open', auth.uid())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.audit_logs (organization_id, branch_id, module, action, record_id, user_id, reason, new_value)
  VALUES (_org, _p.branch_id, 'procurement', 'order.approved', _order::text, auth.uid(), _reason,
          jsonb_build_object('status','pending-delivery','order_number',_p.order_number));

  RETURN jsonb_build_object('ok',true,'order_id',_order,'status','pending-delivery');
END $function$;

-- 2. The generic LPO action routine uses the same stage.
DO $patch$
DECLARE _def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='proc_lpo_action';
  IF _def IS NOT NULL AND position($$SET status='approved'$$ in _def) > 0 THEN
    EXECUTE replace(_def, $$SET status='approved'$$, $$SET status='pending-delivery'$$);
  END IF;
END $patch$;

-- 3. Everything that already recognises an approved order recognises the new stage too.
DO $patch$
DECLARE _name text; _def text; _new text;
BEGIN
  FOREACH _name IN ARRAY ARRAY['neo_stores_receive_goods','neo_procurement_reconciliation',
                               'inventory_metrics','neo_operational_facts','proc_three_way_match',
                               'neo_grn_reverse','proc_lpo_action'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO _def
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=_name
     LIMIT 1;
    IF _def IS NULL THEN CONTINUE; END IF;
    _new := replace(_def, $$'approved','sent'$$, $$'approved','pending-delivery','sent'$$);
    _new := replace(_new, $$'draft','approved','sent'$$, $$'draft','approved','pending-delivery','sent'$$);
    IF _new <> _def THEN EXECUTE _new; END IF;
  END LOOP;
END $patch$;

-- 4. The chase task closes itself once the order is settled one way or the other.
CREATE OR REPLACE FUNCTION public.neo_po_followup_task_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('received','fully-received','fully_received','closed','cancelled','voided') THEN
    UPDATE public.tasks
       SET status='completed', completed_at=now(), progress=100, updated_at=now()
     WHERE reference = 'po-followup:'||NEW.id::text
       AND status NOT IN ('completed','cancelled');
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_po_followup_task_sync ON public.purchase_orders;
CREATE TRIGGER trg_po_followup_task_sync
AFTER UPDATE OF status ON public.purchase_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_po_followup_task_sync();