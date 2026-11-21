-- Shared workflow logic for every existing and future workspace.
-- Explicit, individually reviewed definitions; no runtime source rewriting.
-- Installation changes code only, not balances, stock, bookings or permissions.
BEGIN;
DO $guard$ DECLARE item record; BEGIN
 FOR item IN SELECT * FROM (VALUES ('public.neo_cash_settle_request(uuid)','d4805592caf414dac4ff438d4da11038','9217c85e7679c639650f79fb7fdd87ea'),
('public.pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid)','9e36e6b7f47c1f87cda18d9724896f56','b2b0aa063506ccc86dcceef31b2759bc'),
('public.ops_room_state(uuid)','5fdd347962dfacb2fc93ebaedf42a348','d42f1e6a0d4516ea129135c5954ee434'),
('public.pms_record_payment(uuid,numeric,text,text,text,text,uuid)','7f167375d93e63fbd9489e96cbd933da','d5c0acac22026f8f024a7f6f5751823d'),
('public.neo_cash_till_context(uuid)','36b63a8dd5854b9e11417708478100e5','a20f1fd2483c58b3bc4671d0ca9c3e0f'),
('public.neo_cash_request_payment(uuid,numeric,text,text,text)','025359bfb6c3d6d6ad7464bfcd235df2','6b21da0e161adcaeeee6ad2e3179db32'),
('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text)','fd97015abbb7c524905ec33fb5160ae8','f11b167821be12080cc22324f843d13c'),
('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text,numeric)','e3f20676ebb812a4b1357c99a9b25038','c40eacd9e94530e01e0818de74a8d096'),
('public.neo_supplier_invoice_accept(uuid,text)','4fde341f5b26b996ef967e8dc585a5c4','dc36db393c366c4b3e8fbd30c3ee1690'),
('public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text)','121422758038ec7edda8bc6f0c9bfbcf','d07a7ae828c74596ad4a0bb01fb3a198'),
('public.neo_reservation_financial_state_sync(uuid)','106d6863e37f1ac73425b99d364ee7a5','221250a170cc5862b988f26bf7931b0d'),
('public.neo_gl_revenue_code_scoped(uuid,text,text)','a127ad1bfb734e62f7a3954e0e4305b3','5250b67c6e29ee6fc949b72fd847ac59'),
('public.ops_room_availability(uuid,date,date)','0613e5026b13e25a75960c240fce7293','fc376d87b1ce7b568fa43a4bbd8a93f1'),
('public.inventory_consume_order_item_core(uuid)','7cf50f83f00f127384f17e703e4bfb5b','0ff5a66b125e3aee34ffb5598cfb1685'),
('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)','54ca4b89c5dffe501d5bd3ccd3ac3dc1','261a88efb731375ff8c31557c79b6411'),
('public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid)','08e96545d8fc2cfe60b3839131c4ee08','bb97bc255ef2b3c0644d4248240d1406'),
('public.tg_folio_sync_reservation_payment_status()','cba45520d3c2c6bb299155d0d484d11e','a8a9705fee7ed15013653b71ec9bef74'),
('public.neo_reservation_collection_source_refresh()','e0fd6fc005deb3a46e96ca32256e8dcc','29e89bf056097b5d0ef6c50b8cfe2ac5'),
('public.inventory_post_stock_take(uuid)','c86a9f663f490881ab11e3387c14a58d','c2c1b4212c3e36ad219236109e977fd7'),
('public.neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)','2afdbba3ad8cb4852d3fdd65ff946ff7','32ed1a1bd69d2a852c6a45ecc40e57da'),
('public.neo_stores_count_submit_variance(uuid,text)','c16e752accfd06c60527171ecfe685d6','e6c05479319fdbb2dca31d9afdc32274'),
('public.neo_revenue_reconciliation(uuid,date,date)','18b839422b51de507a25fbea284f9417','fe898ebc5a5912d852b3228c140cf27c'),
('public.pms_confirm_payment(uuid,text,text)','987e80e45018a7bb3fc26383f24d46bb','96b6d1965ba35f1f78ccbfa21277320b')) expected(signature,original_hash,shared_hash) LOOP
  IF coalesce(md5(pg_get_functiondef(to_regprocedure(item.signature))) IN (item.original_hash,item.shared_hash),false) IS NOT TRUE THEN
   RAISE EXCEPTION 'Installed code changed: %. Nothing installed; review this definition first.',item.signature;
  END IF;
 END LOOP;
END $guard$;
CREATE OR REPLACE FUNCTION public.neo_cash_settle_request(_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _r public.cash_payment_requests;
  _f public.folios;
  _o public.pos_orders;
  _s public.pos_shifts;
  _pay uuid; _receipt text; _paid numeric; _fully boolean; _pending numeric; _headroom numeric;
BEGIN
  PERFORM public.neo_pms_collection_lock((SELECT folio_id FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org AND source_module IS DISTINCT FROM 'pos'));
  SELECT * INTO _r FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Cash request not found'; END IF;

    IF NOT coalesce(public.neo_branch_in_scope(_r.branch_id),false) THEN RAISE EXCEPTION 'Cash request is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _r.amount IS NULL OR _r.amount<=0 OR _r.amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Cash amount must be finite and positive'; END IF;
    IF _r.status='confirmed' THEN
      IF auth.uid() IS NULL OR NOT (coalesce(_r.requested_by=auth.uid(),false) OR coalesce(_r.assigned_cashier_id=auth.uid(),false) OR public.has_permission('finance','view') OR public.has_permission('pos','payments.record') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to view this cash confirmation' USING ERRCODE='42501'; END IF;
      IF _r.payment_id IS NULL OR nullif(btrim(_r.receipt_number),'') IS NULL OR
         (_r.source_module='pos' AND NOT EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.id=_r.payment_id AND p.organization_id=_org AND p.branch_id IS NOT DISTINCT FROM _r.branch_id AND p.order_id=_r.source_record_id AND p.receipt_number=_r.receipt_number AND p.amount=_r.amount AND p.currency=_r.currency)) OR
         (coalesce(_r.source_module,'')<>'pos' AND NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.id=_r.payment_id AND p.organization_id=_org AND p.branch_id IS NOT DISTINCT FROM _r.branch_id AND p.folio_id=_r.folio_id AND p.receipt_number=_r.receipt_number AND p.amount=_r.amount AND p.currency=_r.currency)) THEN
        RAISE EXCEPTION 'Confirmed cash request lacks matching saved payment and receipt evidence';
      END IF;
    END IF;
  IF _r.status = 'confirmed' THEN
    RETURN jsonb_build_object('status','confirmed','request_id',_r.id,
      'payment_id',_r.payment_id,'receipt_number',_r.receipt_number,'amount',_r.amount);
  END IF;
  IF _r.status <> 'pending' THEN RAISE EXCEPTION 'Cash request is % and cannot be settled', _r.status; END IF;

  SELECT * INTO _s FROM public.pos_shifts WHERE id=_r.assigned_shift_id AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL OR _s.status <> 'open' THEN
    RAISE EXCEPTION 'The assigned cash drawer is no longer open';
  END IF;

    IF auth.uid() IS NULL OR _s.status IS DISTINCT FROM 'open' OR _s.branch_id IS DISTINCT FROM _r.branch_id OR _s.cashier_id IS DISTINCT FROM auth.uid() OR (_r.assigned_cashier_id IS NOT NULL AND _r.assigned_cashier_id IS DISTINCT FROM _s.cashier_id) THEN RAISE EXCEPTION 'Only the assigned cashier with an open till in this property may confirm cash' USING ERRCODE='42501'; END IF;
    IF NOT (public.has_permission('finance','till.confirm_cash') OR public.has_permission('finance','till.edit') OR public.has_permission('pos','shifts.open')) THEN RAISE EXCEPTION 'Not permitted to confirm cash' USING ERRCODE='42501'; END IF;
  IF _r.source_module='pos' AND (coalesce(_r.tendered,_r.amount)::text IN ('NaN','Infinity','-Infinity') OR coalesce(_r.tendered,_r.amount)<_r.amount OR coalesce(_r.tendered,_r.amount)<>round(coalesce(_r.tendered,_r.amount),2) OR (_r.change_due IS NOT NULL AND _r.change_due IS DISTINCT FROM coalesce(_r.tendered,_r.amount)-_r.amount)) THEN RAISE EXCEPTION 'Saved cash tender does not agree with payment and change'; END IF;
  _receipt := public.next_document_number('receipt');

  IF _r.source_module = 'pos' THEN
    SELECT * INTO _o FROM public.pos_orders WHERE id=_r.source_record_id AND organization_id=_org FOR UPDATE;
    IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
      IF _o.branch_id IS DISTINCT FROM _r.branch_id OR _o.currency IS DISTINCT FROM _r.currency THEN RAISE EXCEPTION 'Cash source property or currency changed'; END IF;
      IF _o.status IN ('closed','cancelled','voided','charged-to-room') THEN RAISE EXCEPTION 'This order cannot accept further cash'; END IF;
      SELECT coalesce(sum(amount) FILTER(WHERE status='confirmed'),0),coalesce(sum(amount) FILTER(WHERE status IN ('initiated','pending')),0) INTO _paid,_pending FROM public.pos_payments WHERE organization_id=_org AND order_id=_o.id;
      IF _o.grand_total IS NULL OR _o.grand_total::text IN ('NaN','Infinity','-Infinity') OR _paid::text IN ('NaN','Infinity','-Infinity') OR _pending::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Order payment amounts are incomplete or non-finite'; END IF;
      _headroom:=round(_o.grand_total-_paid-_pending,2);
      IF _r.amount>_headroom+0.005 THEN RAISE EXCEPTION 'Cash request exceeds the current payment headroom'; END IF;

    INSERT INTO public.pos_payments (organization_id, branch_id, order_id, receipt_number, customer_id,
      amount, tendered, change_due, currency, method, external_reference, status, paid_at, cashier_id, shift_id,
      created_by, idempotency_key)
    VALUES (_org, _o.branch_id, _o.id, _receipt, _o.customer_id, _r.amount, coalesce(_r.tendered,_r.amount), coalesce(_r.tendered,_r.amount)-_r.amount,
      COALESCE(_o.currency,_r.currency), _r.method, CASE WHEN _r.method='cash' THEN NULL ELSE _r.reference END, 'confirmed', now(), _s.cashier_id, _s.id,
      auth.uid(), 'cash-request:' || _r.id::text)
    RETURNING id INTO _pay;

    _paid := _paid+_r.amount;
    _fully := _paid >= COALESCE(_o.grand_total,0);

    -- Move out of the service state BEFORE marking the bill paid: the lifecycle
    -- guard refuses a fully paid order that is still sent/preparing.
    IF _fully AND _o.status NOT IN ('awaiting-payment','paid','closed','charged-to-room','credit','cancelled','voided') THEN
      UPDATE public.pos_orders SET status='awaiting-payment', updated_at=now() WHERE id=_o.id;
    END IF;

    UPDATE public.pos_orders
       SET paid_total = _paid,
           payment_status = CASE WHEN _fully THEN 'paid' ELSE 'partial' END,
           updated_at = now()
     WHERE id = _o.id;

    IF _fully THEN
      UPDATE public.pos_orders SET status='paid', updated_at=now()
       WHERE id=_o.id AND status='awaiting-payment';
    END IF;
  ELSE
    SELECT * INTO _f FROM public.folios WHERE id=_r.folio_id AND organization_id=_org FOR UPDATE;
    IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
    IF (_r.amount<>round(_r.amount,2) OR _r.amount>public.neo_pms_collection_headroom(_f.id,NULL,_r.id)+0.005) THEN RAISE EXCEPTION 'Cash exceeds current unpaid amount after other pending collections'; END IF;
    IF (_f.branch_id IS DISTINCT FROM _r.branch_id OR _f.currency IS DISTINCT FROM _r.currency) THEN RAISE EXCEPTION 'Cash folio property or currency changed'; END IF;
    IF _f.status NOT IN ('open','under-review') THEN
      RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status;
    END IF;

    INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
      customer_id, amount, currency, method, external_reference, status, received_by, notes, shift_id,
      station_id, source_module, source_record_id, idempotency_key)
    VALUES (_org, _f.branch_id, _receipt, _f.id, _f.reservation_id, _f.customer_id, _r.amount,
      COALESCE(_f.currency,_r.currency), _r.method, CASE WHEN _r.method='cash' THEN NULL ELSE _r.reference END, 'confirmed', _s.cashier_id,
      COALESCE(_r.notes,''), _s.id, _s.station_id, _r.source_module, _r.source_record_id,
      'cash-request:' || _r.id::text)
    RETURNING id INTO _pay;

    INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
    VALUES (_org, _pay, _f.id, _r.amount, _s.cashier_id);

    UPDATE public.folios SET total_payments = COALESCE(total_payments,0) + _r.amount,
      balance = COALESCE(balance,0) - _r.amount, updated_at = now() WHERE id=_f.id;
  END IF;

  UPDATE public.cash_payment_requests
     SET status='confirmed', payment_id=_pay, receipt_number=_receipt,
         assigned_cashier_id=COALESCE(assigned_cashier_id,_s.cashier_id), confirmed_at=now(), updated_at=now()
   WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.receipt.confirm', 'finance', _pay::text,
    jsonb_build_object('request_id',_r.id,'folio_id',_r.folio_id,'source_module',_r.source_module,
      'source_record_id',_r.source_record_id,'amount',_r.amount,'method',_r.method,
      'shift_id',_s.id,'collected_by',_s.cashier_id,'initiated_by',_r.requested_by,
      'receipt_number',_receipt), _r.notes);

  RETURN jsonb_build_object('status','confirmed','request_id',_r.id,'payment_id',_pay,
    'receipt_number',_receipt,'amount',_r.amount,'shift_id',_s.id,'collected_by',_s.cashier_id);
END; $function$;

CREATE OR REPLACE FUNCTION public.pms_available_rooms(_branch uuid, _arrival date, _departure date, _room_type uuid DEFAULT NULL::uuid, _adults integer DEFAULT 1, _children integer DEFAULT 0, _for_group uuid DEFAULT NULL::uuid)
 RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, floor text, branch_id uuid, branch_name text, max_occupancy integer, readiness text, maintenance_status text, occupancy_status text, nights integer, qualification text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT _arrival AS a, _departure AS d,
           GREATEST(_departure - _arrival, 0)::int AS n
  ), candidates AS (
    SELECT r.id, r.room_number, r.room_type_id AS rt_id, rt.name AS rtname, r.floor,
           r.branch_id, b.name AS bname,
           COALESCE(rt.max_occupancy, 0)::int AS cap,
           rs.housekeeping_state AS readiness,
           r.maintenance_status,
           rs.occupancy_status AS occupancy_status,
           row_number() OVER (PARTITION BY r.room_type_id ORDER BY r.room_number DESC) AS rn
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    LEFT JOIN public.branches b ON b.id = r.branch_id
    JOIN public.ops_room_state(_branch) rs ON rs.room_id=r.id AND rs.organization_id=r.organization_id
    CROSS JOIN bounds
    CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE coalesce(nullif(b.timezone,''),'UTC'))::date AS room_today) clock
    WHERE public.neo_branch_in_scope(r.branch_id) AND r.organization_id = public.current_org_id()
      AND (_branch IS NULL OR r.branch_id = _branch)
      AND r.status = 'active'
      AND r.maintenance_status = 'operational'
      AND (_room_type IS NULL OR r.room_type_id = _room_type)
      AND (rt.id IS NULL OR rt.max_occupancy >= (COALESCE(_adults,1) + COALESCE(_children,0)))
      AND bounds.n > 0 AND coalesce(_adults,1)>=1 AND coalesce(_children,0)>=0
      -- Same-day and in-progress stays must also be physically ready.
      AND (bounds.a > clock.room_today OR rs.sellable)
      AND NOT (r.out_of_order_from IS NOT NULL
               AND daterange(r.out_of_order_from, coalesce(r.out_of_order_to,'infinity'::date), '[]')
                   && daterange(bounds.a, bounds.d, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM public.reservations res
        WHERE res.room_id = r.id
          AND res.organization_id=r.organization_id AND ((res.status IN ('checked-in','in-house','checked_in','in_house') AND res.departure_date<clock.room_today) OR
            (res.status IN ('confirmed','guaranteed','checked-in','in-house','checked_in','in_house')
             AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)'))))
      AND NOT EXISTS (
        SELECT 1 FROM public.room_assignments a
        WHERE a.room_id = r.id AND a.status = 'active'
          AND daterange(a.start_date, a.end_date, '[)') && daterange(bounds.a, bounds.d, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM public.room_blocks bl
        WHERE bl.room_id = r.id AND bl.status = 'active'
          AND daterange(bl.start_date, bl.end_date, '[]') && daterange(bounds.a, bounds.d, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM public.reservation_holds h
        WHERE h.room_id = r.id AND h.status = 'active' AND h.hold_expires_at > now()
          AND daterange(h.arrival_date, h.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)'))
  ), held AS (
    SELECT gb.room_type_id AS rt_id,
           COALESCE(sum(GREATEST(gb.rooms_blocked - gb.rooms_picked_up - gb.rooms_released,0)),0)::int AS qty
    FROM public.group_room_blocks gb
    JOIN public.group_bookings g ON g.id = gb.group_booking_id
    CROSS JOIN bounds
    WHERE gb.status = 'active' AND g.organization_id = public.current_org_id()
      AND g.status NOT IN ('cancelled','closed')
      AND (_branch IS NULL OR g.branch_id = _branch)
      AND (_for_group IS NULL OR gb.group_booking_id <> _for_group)
      AND daterange(gb.start_date, gb.end_date, '[]') && daterange(bounds.a, bounds.d, '[)')
    GROUP BY gb.room_type_id
  ), demand AS (
    -- Confirmed/guaranteed stays that have no room yet still consume inventory
    -- of their room type; otherwise the same room type is sold twice.
    SELECT res.room_type_id AS rt_id, count(*)::int AS qty
    FROM public.reservations res
    CROSS JOIN bounds
    WHERE res.organization_id = public.current_org_id()
      AND res.room_id IS NULL
      AND res.room_type_id IS NOT NULL
      AND res.status IN ('confirmed','guaranteed')
      AND (_branch IS NULL OR res.branch_id = _branch)
      AND (_for_group IS NULL OR res.group_booking_id IS DISTINCT FROM _for_group)
      AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)')
    GROUP BY res.room_type_id
  )
  SELECT c.id, c.room_number, c.rt_id, c.rtname, c.floor, c.branch_id, c.bname,
         c.cap, c.readiness, c.maintenance_status, c.occupancy_status,
         (SELECT n FROM bounds),
         'Sellable, no overlapping stay, assignment, block, hold or group inventory for '
           || to_char((SELECT a FROM bounds),'YYYY-MM-DD') || ' → '
           || to_char((SELECT d FROM bounds),'YYYY-MM-DD')
  FROM candidates c
  LEFT JOIN held h ON h.rt_id = c.rt_id
  LEFT JOIN demand dm ON dm.rt_id = c.rt_id
  WHERE c.rn > COALESCE(h.qty, 0) + COALESCE(dm.qty, 0)
  ORDER BY c.bname NULLS LAST, c.room_number;
$function$;

CREATE OR REPLACE FUNCTION public.ops_room_state(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, organization_id uuid, property_id uuid, floor text, building text, inventory_status text, occupancy_status text, housekeeping_status text, housekeeping_state text, readiness_state text, room_condition text, inspection_status text, maintenance_status text, out_of_order_reason text, sellable boolean, sellable_now boolean, sellability_reason text, exclusion_reasons text[], current_reservation_id uuid, current_confirmation_number text, arrival_today boolean, departure_today boolean, current_job_id uuid, current_task_id uuid, current_job_status text, assignee_id uuid, assignee_name text, pending_inspection boolean, last_cleaned_at timestamp with time zone, last_inspected_at timestamp with time zone, last_status_change timestamp with time zone, data_version timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT r.*, public.hk_canonical_condition(r.housekeeping_status) AS hk, rt.name AS rt_name,
      (now() AT TIME ZONE coalesce(nullif(br.timezone,''),'UTC'))::date AS room_today
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    LEFT JOIN public.branches br ON br.id=r.branch_id AND br.organization_id=r.organization_id
    WHERE r.organization_id=public.current_org_id() AND public.neo_branch_in_scope(r.branch_id)
      AND (_branch IS NULL OR r.branch_id = _branch)
  ),
  stay AS (
    SELECT DISTINCT ON (res.organization_id,res.room_id)
      res.organization_id, res.room_id, res.id, res.confirmation_number, res.arrival_date, res.departure_date, res.status
    FROM public.reservations res JOIN base b ON b.id=res.room_id AND b.organization_id=res.organization_id AND b.branch_id IS NOT DISTINCT FROM res.branch_id
    WHERE res.room_id IS NOT NULL
      AND (
        res.status IN ('checked-in','in-house','checked_in','in_house') OR
        (res.status IN ('confirmed','on-hold','guaranteed') AND res.arrival_date<=b.room_today AND res.departure_date>=b.room_today)
      )
    ORDER BY res.organization_id,res.room_id,
      CASE WHEN res.status IN ('checked-in','in-house','checked_in','in_house') THEN 0 ELSE 1 END,
      res.arrival_date,res.id
  ),
  job AS (
    SELECT DISTINCT ON (j.organization_id,j.room_id)
      j.organization_id,j.room_id, j.id, j.task_id, j.status, j.assignee_id
    FROM public.housekeeping_jobs j JOIN base b ON b.id=j.room_id AND b.organization_id=j.organization_id AND b.branch_id IS NOT DISTINCT FROM j.branch_id
    WHERE j.room_id IS NOT NULL AND public.hk_job_is_open(j.status, j.superseded_by)
    ORDER BY j.organization_id,j.room_id, j.created_at DESC,j.id DESC
  ),
  derived AS (
    SELECT b.*, s.id AS res_id, s.confirmation_number AS res_no,
      s.arrival_date, s.departure_date,
      job.id AS job_id, job.task_id, job.status AS job_status, job.assignee_id,
      coalesce(b.inspection_status,'not-required') AS insp,
      coalesce(b.maintenance_status,'operational') AS mt,
      CASE WHEN s.status IN ('checked-in','in-house','checked_in','in_house') THEN 'occupied' ELSE coalesce(b.occupancy_status,'vacant') END AS occ,
      coalesce(b.status,'active') AS inv,
      CASE
        WHEN job.status='rework' THEN 'rework_required'
        WHEN job.status='awaiting-inspection' THEN 'awaiting_inspection'
        WHEN job.id IS NOT NULL THEN
          CASE WHEN job.status IN ('in-progress','in_progress','cleaning') THEN 'cleaning_in_progress' ELSE 'cleaning_queued' END
        WHEN b.hk = 'rework' OR coalesce(b.inspection_status,'not-required') = 'failed' THEN 'rework_required'
        WHEN b.hk = 'awaiting_inspection' OR (b.hk IN ('clean','inspected') AND coalesce(b.inspection_status,'not-required') = 'pending')
          THEN 'awaiting_inspection'
        WHEN b.hk = 'cleaning_in_progress' THEN 'cleaning_in_progress'
        WHEN b.hk = 'cleaning_queued' THEN 'cleaning_queued'
        WHEN b.hk = 'dirty' THEN 'dirty'
        WHEN b.hk IN ('clean','inspected') THEN 'ready'
        ELSE b.hk
      END AS hk_state,
      job.status IS NOT NULL AS has_open_job
    FROM base b
    LEFT JOIN stay s ON s.room_id = b.id AND s.organization_id=b.organization_id
    LEFT JOIN job ON job.room_id = b.id AND job.organization_id=b.organization_id
  )
  SELECT
    d.id, d.room_number, d.room_type_id, d.rt_name, d.organization_id, d.branch_id,
    d.floor, d.building,
    d.inv, d.occ, d.hk, d.hk_state,
    CASE WHEN d.hk_state='ready' AND d.mt='operational' AND d.occ='vacant' AND d.inv='active'
         THEN 'ready' ELSE 'not_ready' END,
    d.room_condition, d.insp, d.mt, d.out_of_order_reason,
    (d.inv='active' AND d.occ='vacant' AND d.mt='operational' AND d.hk_state='ready'),
    (d.inv='active' AND d.occ='vacant' AND d.mt='operational' AND d.hk_state='ready' AND d.res_id IS NULL),
    CASE
      WHEN d.inv <> 'active' THEN 'Room inventory is not active'
      WHEN d.mt = 'out-of-order' THEN coalesce('Out of order: '||d.out_of_order_reason,'Out of order')
      WHEN d.mt = 'out-of-service' THEN coalesce('Out of service: '||d.out_of_order_reason,'Out of service')
      WHEN d.mt = 'under-maintenance' THEN 'Maintenance block in place'
      WHEN d.occ = 'occupied' THEN 'Currently occupied'
      WHEN d.occ = 'house-use' THEN 'Reserved for house use'
      WHEN d.hk_state <> 'ready' THEN 'Housekeeping: '||replace(d.hk_state,'_',' ')
      WHEN d.res_id IS NOT NULL THEN 'Held by reservation '||coalesce(d.res_no,'')
      ELSE 'Sellable'
    END,
    (SELECT array_remove(ARRAY[
        CASE WHEN d.inv <> 'active' THEN 'inventory-inactive' END,
        CASE WHEN d.mt <> 'operational' THEN 'maintenance-'||d.mt END,
        CASE WHEN d.occ <> 'vacant' THEN 'occupancy-'||d.occ END,
        CASE WHEN d.hk_state <> 'ready' THEN 'housekeeping-'||d.hk_state END,
        CASE WHEN d.res_id IS NOT NULL THEN 'reservation-hold' END
      ], NULL)),
    d.res_id, d.res_no,
    (d.arrival_date = d.room_today), (d.departure_date = d.room_today),
    d.job_id, d.task_id, d.job_status, d.assignee_id, p.full_name,
    (d.insp = 'pending'),
    d.last_cleaned_at, d.last_inspected_at, d.updated_at, d.updated_at
  FROM derived d
  LEFT JOIN public.profiles p ON p.id = d.assignee_id
  ORDER BY d.room_number;
$function$;

CREATE OR REPLACE FUNCTION public.pms_record_payment(_folio uuid, _amount numeric, _method text, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text, _intent_key text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _f public.folios; _id uuid; _receipt text; _status text; _shift uuid; _req public.cash_payment_requests; _settled jsonb; _key text; _acct uuid; _saved public.payments;
BEGIN
  IF NOT (public.has_permission('pms','payments.record') OR public.is_org_admin() OR public.neo_system_posting()) THEN RAISE EXCEPTION 'Not permitted to record payments'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
   IF nullif(btrim(_intent_key),'') IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':pms-collection:'||btrim(_intent_key),0)); END IF;
   PERFORM public.neo_pms_collection_lock(_folio);
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
    IF NOT coalesce(public.neo_branch_in_scope(_f.branch_id),false) THEN RAISE EXCEPTION 'Payment source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) THEN RAISE EXCEPTION 'Payment amount must be finite and in currency cents' USING ERRCODE='22023'; END IF;

  IF _account IS NOT NULL THEN
    SELECT b.id INTO _acct FROM public.bank_accounts b
     WHERE b.id = _account AND b.organization_id = _org AND b.active
       AND (b.branch_id IS NULL OR _f.branch_id IS NULL OR b.branch_id = _f.branch_id);
    IF _acct IS NULL THEN RAISE EXCEPTION 'Selected receiving account is not available for this property'; END IF;
  END IF;

  _key := NULLIF(btrim(coalesce(_intent_key,'')), '');
  IF _key IS NULL THEN
    _key := 'pms:payment:' || encode(extensions.digest(
      _folio::text || '|' || round(_amount,2)::text || '|' || _method || '|' ||
      coalesce(_reference,'') || '|' || coalesce(auth.uid()::text,'system') || '|' ||
      to_char(now() at time zone 'utc', 'YYYYMMDD"T"HH24MI'), 'sha256'), 'hex');
  END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':pms-collection:'||_key,0));
  SELECT p.* INTO _saved FROM public.payments p WHERE p.organization_id=_org AND p.idempotency_key=_key LIMIT 1;
  IF _saved.id IS NOT NULL THEN
    IF (_saved.folio_id IS DISTINCT FROM _f.id OR _saved.branch_id IS DISTINCT FROM _f.branch_id OR _saved.amount IS DISTINCT FROM _amount OR _saved.currency IS DISTINCT FROM _f.currency OR _saved.method IS DISTINCT FROM _method OR _saved.destination_account_id IS DISTINCT FROM _acct) THEN RAISE EXCEPTION 'Payment collection key was already used for different payment details' USING ERRCODE='23514'; END IF;
    RETURN _saved.id;
  END IF;
  IF EXISTS(SELECT 1 FROM public.cash_payment_requests r WHERE r.organization_id=_org AND r.idempotency_key=_key) THEN
    SELECT * INTO _req FROM public.cash_payment_requests r WHERE r.organization_id=_org AND r.idempotency_key=_key;
    IF _method IS DISTINCT FROM 'cash' OR _req.folio_id IS DISTINCT FROM _f.id OR _req.amount IS DISTINCT FROM _amount OR _req.currency IS DISTINCT FROM _f.currency THEN RAISE EXCEPTION 'Collection key already belongs to a cash request; review the saved collection' USING ERRCODE='23514'; END IF;
    _settled:=public.neo_cash_settle_request(_req.id); RETURN (_settled->>'payment_id')::uuid;
  END IF;

  IF _f.status NOT IN ('open','under-review') THEN RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status; END IF;

  IF _method = 'cash' THEN
    SELECT * INTO _req
      FROM public.cash_payment_requests r
     WHERE r.organization_id = _org
       AND r.folio_id = _folio
       AND r.status = 'pending'
       AND r.method = _method
       AND abs(coalesce(r.amount,0) - _amount) < 0.01
     ORDER BY r.created_at ASC
     LIMIT 1;
    IF _req.id IS NOT NULL THEN
      _settled := public.neo_cash_settle_request(_req.id);
      RETURN (_settled ->> 'payment_id')::uuid;
    END IF;
  END IF;

  IF _method = 'cash' THEN
    SELECT s.id INTO _shift
      FROM public.pos_shifts s
     WHERE s.cashier_id = auth.uid()
       AND s.status = 'open'
       AND s.organization_id = _org
       AND (s.branch_id IS NULL OR _f.branch_id IS NULL OR s.branch_id = _f.branch_id)
     ORDER BY (s.branch_id = _f.branch_id) DESC NULLS LAST, s.opened_at DESC
     LIMIT 1;
    IF _shift IS NULL THEN
      RAISE EXCEPTION 'Open your cash drawer before taking cash at this desk';
    END IF;
  END IF;

  IF _amount>public.neo_pms_collection_headroom(_f.id)+0.005 THEN RAISE EXCEPTION 'This payment exceeds the unpaid reservation or folio amount after pending collections'; END IF;
  _status := CASE WHEN _method IN ('cash','corporate-credit') THEN 'confirmed' ELSE 'pending' END;
  _receipt := public.next_document_number('receipt');

  BEGIN
    INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
      customer_id, amount, currency, method, external_reference, status, received_by, notes, shift_id,
      source_module, idempotency_key, destination_account_id)
    VALUES (_org, _f.branch_id, _receipt, _folio, _f.reservation_id, _f.customer_id, _amount, _f.currency,
      _method, _reference, _status, auth.uid(), COALESCE(_notes,''), _shift, 'pms', _key, _acct)
    RETURNING id INTO _id;
  EXCEPTION WHEN unique_violation THEN
    SELECT p.* INTO _saved FROM public.payments p WHERE p.organization_id=_org AND p.idempotency_key=_key LIMIT 1;
    IF _saved.id IS NULL THEN RAISE; END IF;
    IF (_saved.folio_id IS DISTINCT FROM _f.id OR _saved.branch_id IS DISTINCT FROM _f.branch_id OR _saved.amount IS DISTINCT FROM _amount OR _saved.currency IS DISTINCT FROM _f.currency OR _saved.method IS DISTINCT FROM _method OR _saved.destination_account_id IS DISTINCT FROM _acct) THEN RAISE EXCEPTION 'Payment collection key was already used for different payment details' USING ERRCODE='23514'; END IF;
    RETURN _saved.id;
  END;

  IF _status = 'confirmed' THEN
    INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
    VALUES (_org, _id, _folio, _amount, auth.uid());
    UPDATE public.folios SET total_payments = total_payments + _amount,
      balance = balance - _amount, updated_at = now() WHERE id=_folio;
  END IF;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.payment.record', 'finance', _id::text,
    jsonb_build_object('folio_id',_folio,'amount',_amount,'method',_method,'status',_status,'shift_id',_shift,'intent_key',_key,'destination_account_id',_acct), _notes);
  RETURN _id;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_till_context(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _mine public.pos_shifts;
  _can_open boolean;
  _can_confirm boolean;
  _tills jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('active_tills', '[]'::jsonb); END IF;

  _can_open := public.has_permission('finance','till.create') OR public.has_permission('pos','shifts.open');
  _can_confirm := public.has_permission('finance','till.confirm_cash')
               OR public.has_permission('finance','till.edit')
               OR public.has_permission('pos','shifts.open');

  SELECT * INTO _mine FROM public.pos_shifts s
   WHERE s.organization_id=_org AND s.cashier_id=auth.uid() AND s.status='open'
     AND coalesce(public.neo_branch_in_scope(s.branch_id),false) AND (_branch IS NULL OR s.branch_id=_branch)
   ORDER BY (s.branch_id = _branch) DESC NULLS LAST, s.opened_at DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'shift_id', s.id, 'shift_number', s.shift_number,
           'cashier_id', s.cashier_id, 'cashier_name', COALESCE(p.full_name,'Cashier'),
           'branch_id', s.branch_id, 'opened_at', s.opened_at) ORDER BY s.opened_at DESC), '[]'::jsonb)
    INTO _tills
    FROM public.pos_shifts s
    LEFT JOIN public.profiles p ON p.id = s.cashier_id
   WHERE s.organization_id=_org AND s.status='open'
     AND coalesce(public.neo_branch_in_scope(s.branch_id),false) AND (_branch IS NULL OR s.branch_id=_branch);

  RETURN jsonb_build_object(
    'can_open_drawer', _can_open,
    'can_confirm_cash', _can_confirm,
    'my_shift_id', _mine.id,
    'my_shift_number', _mine.shift_number,
    'self_service', (_mine.id IS NOT NULL AND _can_confirm),
    'active_tills', _tills
  );
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_request_payment(_folio uuid, _amount numeric, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text, _idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _f public.folios;
  _ctx jsonb;
  _shift uuid; _cashier uuid; _req uuid; _existing public.cash_payment_requests;
BEGIN
  IF NOT (public.has_permission('pms','payments.record') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record payments';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

    IF _idempotency_key IS NOT NULL THEN
      IF nullif(btrim(_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'A stable collection key is required'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':pms-collection:'||_idempotency_key,0));
    END IF;
    PERFORM public.neo_pms_collection_lock(_folio);
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;

    IF NOT coalesce(public.neo_branch_in_scope(_f.branch_id),false) THEN RAISE EXCEPTION 'Cash source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) THEN RAISE EXCEPTION 'Cash amount must be finite and positive' USING ERRCODE='22023'; END IF;
  IF _idempotency_key IS NOT NULL AND EXISTS(SELECT 1 FROM public.payments p WHERE p.organization_id=_org AND p.idempotency_key=_idempotency_key) THEN RAISE EXCEPTION 'Collection key already belongs to a recorded payment; review the saved collection' USING ERRCODE='23514'; END IF;
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
      IF (_existing.folio_id IS DISTINCT FROM _f.id OR _existing.amount IS DISTINCT FROM _amount OR _existing.currency IS DISTINCT FROM coalesce(_f.currency,'KES') OR _existing.method IS DISTINCT FROM 'cash') THEN RAISE EXCEPTION 'Cash collection key was already used for a different amount, currency or folio' USING ERRCODE='23514'; END IF;
      IF (_existing.source_record_id IS DISTINCT FROM _f.id OR _existing.source_module IS DISTINCT FROM 'pms' OR _existing.branch_id IS DISTINCT FROM _f.branch_id) THEN RAISE EXCEPTION 'Cash request intent belongs to a different source or property' USING ERRCODE='23514'; END IF;
      IF _existing.status='confirmed' THEN RETURN public.neo_cash_settle_request(_existing.id); END IF;
      RETURN jsonb_build_object('status',_existing.status,'request_id',_existing.id,
        'payment_id',_existing.payment_id,'receipt_number',_existing.receipt_number,'amount',_existing.amount);
    END IF;
  END IF;

  IF _f.status NOT IN ('open','under-review') THEN RAISE EXCEPTION 'Folio is % and cannot accept new cash requests',_f.status; END IF;
  _ctx := public.neo_cash_till_context(_f.branch_id);

  IF (_ctx->>'self_service')::boolean THEN
    _shift := (_ctx->>'my_shift_id')::uuid;
    _cashier := auth.uid();
  ELSE
    SELECT s.id, s.cashier_id INTO _shift, _cashier
      FROM public.pos_shifts s
     WHERE s.organization_id=_org AND s.status='open'
       AND s.branch_id IS NOT DISTINCT FROM _f.branch_id AND coalesce(public.neo_branch_in_scope(s.branch_id),false)
     ORDER BY (s.branch_id = _f.branch_id) DESC NULLS LAST, s.opened_at DESC
     LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  IF _amount>public.neo_pms_collection_headroom(_f.id)+0.005 THEN RAISE EXCEPTION 'This cash request exceeds the unpaid reservation or folio amount after pending collections'; END IF;
  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key)
  VALUES (_org, _f.branch_id, 'pms', _f.id, _f.id, _amount, COALESCE(_f.currency,'KES'), 'cash',
    _reference, COALESCE(_notes,''), 'pending', auth.uid(), _shift, _cashier, _idempotency_key)
  RETURNING id INTO _req;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.create', 'finance', _req::text,
    jsonb_build_object('folio_id',_f.id,'amount',_amount,'assigned_shift',_shift,'assigned_cashier',_cashier));

  IF (_ctx->>'self_service')::boolean THEN
    RETURN public.neo_cash_settle_request(_req);
  END IF;

  RETURN jsonb_build_object('status','pending','request_id',_req,'assigned_shift_id',_shift,
    'assigned_cashier_id',_cashier,'amount',_amount);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_request_pos_payment(_order uuid, _amount numeric, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text, _idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _ctx jsonb; _shift uuid; _cashier uuid; _req uuid; _existing public.cash_payment_requests;
BEGIN
  IF NOT (public.has_permission('pos','payments.record') OR public.has_permission('pos','orders.edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record payments' USING ERRCODE = '42501';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id=_order AND organization_id=_org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

    IF NOT coalesce(public.neo_branch_in_scope(_o.branch_id),false) THEN RAISE EXCEPTION 'Cash source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Cash amount must be finite and positive' USING ERRCODE='22023'; END IF;
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
      IF (_existing.source_record_id IS DISTINCT FROM _o.id OR _existing.source_module IS DISTINCT FROM 'pos' OR _existing.branch_id IS DISTINCT FROM _o.branch_id OR _existing.amount IS DISTINCT FROM _amount OR _existing.currency IS DISTINCT FROM _o.currency) THEN RAISE EXCEPTION 'Cash request intent belongs to different payment details' USING ERRCODE='23514'; END IF;
      IF _existing.status='confirmed' THEN RETURN public.neo_cash_settle_request(_existing.id); END IF;
      RETURN jsonb_build_object('status',_existing.status,'request_id',_existing.id,
        'payment_id',_existing.payment_id,'receipt_number',_existing.receipt_number);
    END IF;
  END IF;

  _ctx := public.neo_cash_till_context(_o.branch_id);

  IF (_ctx->>'self_service')::boolean THEN
    _shift := (_ctx->>'my_shift_id')::uuid; _cashier := auth.uid();
  ELSE
    SELECT s.id, s.cashier_id INTO _shift, _cashier
      FROM public.pos_shifts s
     WHERE s.organization_id=_org AND s.status='open'
       AND s.branch_id IS NOT DISTINCT FROM _o.branch_id AND coalesce(public.neo_branch_in_scope(s.branch_id),false)
     ORDER BY (s.branch_id = _o.branch_id) DESC NULLS LAST, s.opened_at DESC LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key)
  VALUES (_org, _o.branch_id, 'pos', _o.id, NULL, _amount, COALESCE(_o.currency,'KES'), 'cash',
    COALESCE(_reference, _o.order_number), COALESCE(_notes,''), 'pending', auth.uid(),
    _shift, _cashier, _idempotency_key)
  RETURNING id INTO _req;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.create', 'pos', _req::text,
    jsonb_build_object('order_id',_o.id,'amount',_amount,'assigned_shift',_shift,'assigned_cashier',_cashier));

  IF (_ctx->>'self_service')::boolean THEN
    RETURN public.neo_cash_settle_request(_req);
  END IF;

  RETURN jsonb_build_object('status','pending','request_id',_req,'assigned_shift_id',_shift,
    'assigned_cashier_id',_cashier,'amount',_amount);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_cash_request_pos_payment(_order uuid, _amount numeric, _reference text, _notes text, _idempotency_key text, _tendered numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _ctx jsonb; _shift uuid; _cashier uuid; _req uuid; _existing public.cash_payment_requests;
BEGIN
  IF NOT (public.has_permission('pos','payments.record') OR public.has_permission('pos','orders.edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record payments' USING ERRCODE = '42501';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) OR _tendered IS NULL OR _tendered::text IN ('NaN','Infinity','-Infinity') OR _tendered<_amount OR _tendered<>round(_tendered,2) THEN RAISE EXCEPTION 'Cash tender must be finite, in cents and at least the payment amount' USING ERRCODE='22023'; END IF;
  IF nullif(btrim(_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'A stable cash collection key is required' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':cash-intent:'||_idempotency_key,0));
  SELECT * INTO _o FROM public.pos_orders WHERE id=_order AND organization_id=_org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

    IF NOT coalesce(public.neo_branch_in_scope(_o.branch_id),false) THEN RAISE EXCEPTION 'Cash source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Cash amount must be finite and positive' USING ERRCODE='22023'; END IF;
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
      IF _existing.source_record_id IS DISTINCT FROM _o.id OR _existing.source_module IS DISTINCT FROM 'pos' OR _existing.branch_id IS DISTINCT FROM _o.branch_id OR _existing.currency IS DISTINCT FROM _o.currency OR _existing.amount IS DISTINCT FROM _amount OR coalesce(_existing.tendered,_existing.amount) IS DISTINCT FROM _tendered THEN RAISE EXCEPTION 'Cash collection key was already used for a different payment or tender' USING ERRCODE='23514'; END IF;
      IF (_existing.source_record_id IS DISTINCT FROM _o.id OR _existing.source_module IS DISTINCT FROM 'pos' OR _existing.branch_id IS DISTINCT FROM _o.branch_id) THEN RAISE EXCEPTION 'Cash request intent belongs to a different source or property' USING ERRCODE='23514'; END IF;
      IF _existing.status='confirmed' THEN RETURN public.neo_cash_settle_request(_existing.id); END IF;
      RETURN jsonb_build_object('status',_existing.status,'request_id',_existing.id,
        'payment_id',_existing.payment_id,'receipt_number',_existing.receipt_number);
    END IF;
  END IF;

  _ctx := public.neo_cash_till_context(_o.branch_id);

  IF (_ctx->>'self_service')::boolean THEN
    _shift := (_ctx->>'my_shift_id')::uuid; _cashier := auth.uid();
  ELSE
    SELECT s.id, s.cashier_id INTO _shift, _cashier
      FROM public.pos_shifts s
     WHERE s.organization_id=_org AND s.status='open'
       AND s.branch_id IS NOT DISTINCT FROM _o.branch_id AND coalesce(public.neo_branch_in_scope(s.branch_id),false)
     ORDER BY (s.branch_id = _o.branch_id) DESC NULLS LAST, s.opened_at DESC LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key, tendered, change_due)
  VALUES (_org, _o.branch_id, 'pos', _o.id, NULL, _amount, COALESCE(_o.currency,'KES'), 'cash',
    COALESCE(_reference, _o.order_number), COALESCE(_notes,''), 'pending', auth.uid(),
    _shift, _cashier, _idempotency_key, _tendered, _tendered-_amount)
  RETURNING id INTO _req;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.create', 'pos', _req::text,
    jsonb_build_object('order_id',_o.id,'amount',_amount,'assigned_shift',_shift,'assigned_cashier',_cashier));

  IF (_ctx->>'self_service')::boolean THEN
    RETURN public.neo_cash_settle_request(_req);
  END IF;

  RETURN jsonb_build_object('status','pending','request_id',_req,'assigned_shift_id',_shift,
    'assigned_cashier_id',_cashier,'amount',_amount);
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_supplier_invoice_accept(_invoice uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  inv record; pol public.procurement_matching_policies; l record;
  v_net numeric; v_tax numeric; v_lines jsonb := '[]'::jsonb; v_res jsonb; v_debit_code text; _cur text;
BEGIN
  IF NOT (has_permission('finance','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to accept supplier invoices';
  END IF;
  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org FOR UPDATE;
  IF inv IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
    IF auth.uid() IS NULL OR public.neo_branch_in_scope(inv.branch_id) IS NOT TRUE THEN RAISE EXCEPTION 'Invoice outside authorized property scope' USING ERRCODE='42501'; END IF;
    IF inv.amount IS NULL OR inv.amount<=0 OR inv.amount::text IN ('NaN','Infinity','-Infinity') OR inv.tax_amount IS NULL OR inv.tax_amount<0 OR inv.tax_amount>inv.amount OR inv.tax_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invoice amount or tax is incomplete or non-finite'; END IF;
    IF inv.journal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=inv.journal_id AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id AND j.status='posted') THEN RAISE EXCEPTION 'Saved invoice journal is not confirmed posted; review before retrying'; END IF;
  IF inv.journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'journal_id', inv.journal_id);
  END IF;
  IF inv.journal_id IS NULL THEN
    PERFORM public.proc_three_way_match(_invoice);
    SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice;
  END IF;
  IF inv.match_status = 'held' AND COALESCE(btrim(_reason),'') = '' THEN
    RAISE EXCEPTION 'This invoice is on hold. A written override reason is required.';
  END IF;

  pol := public.neo_matching_policy(v_org, inv.branch_id);
  v_tax := round(COALESCE(inv.tax_amount,0), 2);
  v_net := round(COALESCE(inv.amount,0) - v_tax, 2);
  IF v_net + v_tax <= 0 THEN RAISE EXCEPTION 'Invoice has no value to post'; END IF;

  v_debit_code := CASE WHEN inv.order_id IS NULL THEN pol.expense_account_code ELSE pol.grni_account_code END;
  PERFORM public.neo_finance_ensure_account(v_org, v_debit_code,
    CASE WHEN inv.order_id IS NULL THEN 'Other Operating Expenses' ELSE 'Goods Received Not Invoiced' END,
    CASE WHEN inv.order_id IS NULL THEN 'operating_expense' ELSE 'liability' END,
    CASE WHEN inv.order_id IS NULL THEN 'Operating Expenses' ELSE 'Payables' END);
  PERFORM public.neo_finance_ensure_account(v_org, pol.payable_account_code, 'Accounts Payable', 'liability', 'Payables');

  v_lines := v_lines || jsonb_build_object('code', v_debit_code, 'debit', v_net,
    'description', CASE WHEN inv.order_id IS NULL THEN 'Non-order supplier invoice' ELSE 'Clear goods received not invoiced' END);
  IF v_tax > 0 THEN
    PERFORM public.neo_finance_ensure_account(v_org, pol.tax_input_account_code, 'VAT Input (Recoverable)', 'asset', 'Tax');
    v_lines := v_lines || jsonb_build_object('code', pol.tax_input_account_code, 'debit', v_tax, 'description', 'Recoverable input tax');
  END IF;
  v_lines := v_lines || jsonb_build_object('code', pol.payable_account_code, 'credit', round(v_net + v_tax,2), 'description', 'Supplier payable');

  _cur:=public.neo_fact_currency(v_org,inv.branch_id);
  IF nullif(btrim(_cur),'') IS NULL THEN RAISE EXCEPTION 'Invoice property currency could not be verified'; END IF;
  v_res := public.neo_gl_post(v_org, inv.branch_id, 'procurement', 'supplier_invoice', _invoice, 'payable',
    COALESCE(inv.invoice_date, CURRENT_DATE), _cur,
    'Supplier invoice ' || inv.invoice_number, v_lines);

  IF (coalesce((v_res->>'ok')::boolean,false) IS NOT TRUE OR nullif(v_res->>'journal_id','') IS NULL OR NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=nullif(v_res->>'journal_id','')::uuid AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id AND j.status='posted')) THEN RAISE EXCEPTION 'Supplier invoice acceptance requires its successfully posted journal: %',v_res USING ERRCODE='23514'; END IF;

  UPDATE supplier_invoices
     SET journal_id = (v_res->>'journal_id')::uuid,
         status = 'approved',
         match_status = CASE WHEN match_status = 'held' THEN 'approved-with-variance' ELSE match_status END,
         approved_by = auth.uid(), approved_at = now(),
         notes = COALESCE(notes,'') || CASE WHEN COALESCE(btrim(_reason),'') = '' THEN '' ELSE E'\nAccepted: ' || _reason END
   WHERE id = _invoice;

  -- Reflect what has been invoiced back onto the purchase order trail.
  IF inv.order_id IS NOT NULL THEN
    FOR l IN SELECT * FROM supplier_invoice_lines WHERE supplier_invoice_id = _invoice LOOP
      UPDATE purchase_order_lines pl
         SET invoiced_quantity = COALESCE(pl.invoiced_quantity,0) + l.quantity
       WHERE pl.order_id = inv.order_id
         AND (pl.stock_item_id = l.stock_item_id
              OR (l.stock_item_id IS NULL AND lower(pl.description) = lower(COALESCE(l.description,''))));
    END LOOP;
    UPDATE purchase_orders
       SET invoiced_amount = COALESCE(invoiced_amount,0) + round(COALESCE(inv.amount,0),2),
           status = CASE WHEN status IN ('closed','cancelled','voided') THEN status
                         WHEN COALESCE(invoiced_amount,0) + COALESCE(inv.amount,0) >= COALESCE(total_amount,0) THEN 'fully-invoiced'
                         ELSE 'partially-invoiced' END
     WHERE id = inv.order_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'journal_id', v_res->>'journal_id', 'amount', round(v_net + v_tax,2));
END $function$;

CREATE OR REPLACE FUNCTION public.neo_reservation_deposit_record(_reservation uuid, _amount numeric, _method text DEFAULT 'cash'::text, _reference text DEFAULT NULL::text, _idempotency_key text DEFAULT NULL::text, _notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _res public.reservations;
  _id uuid;
  _existing uuid;
  _post jsonb; _saved public.reservation_deposits; _facts jsonb;
BEGIN
  IF NOT (public.has_permission('pms','reservations.edit') OR public.has_permission('finance','collections.record_payment')) THEN
    RAISE EXCEPTION 'Not permitted to record a reservation deposit';
  END IF;
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'A deposit must be greater than zero'; END IF;
  IF NULLIF(btrim(COALESCE(_idempotency_key,'')), '') IS NULL THEN RAISE EXCEPTION 'A deposit idempotency key is required'; END IF;

   IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) THEN RAISE EXCEPTION 'Deposit amount must be finite and in currency cents'; END IF;
   IF coalesce(nullif(lower(_method),''),'cash') NOT IN ('cash','card','bank-transfer','bank','bank_transfer','eft','voucher') THEN RAISE EXCEPTION 'This deposit method needs a verified collection workflow; do not record an unconfirmed provider payment as a received deposit'; END IF;
   IF coalesce(nullif(lower(_method),''),'cash')<>'cash' AND nullif(btrim(_reference),'') IS NULL THEN RAISE EXCEPTION 'A received non-cash deposit requires its bank, terminal or voucher confirmation reference'; END IF;
   PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':deposit-intent:'||_idempotency_key,0));
   PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':reservation-collection:'||_reservation::text,0));
  SELECT * INTO _res FROM public.reservations
   WHERE id = _reservation AND organization_id = _org FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;
  IF NOT coalesce(public.neo_branch_in_scope(_res.branch_id),false) THEN RAISE EXCEPTION 'Reservation is outside your property scope' USING ERRCODE='42501'; END IF;

  SELECT id INTO _existing FROM public.reservation_deposits
   WHERE organization_id = _org AND idempotency_key = _idempotency_key;
  IF _existing IS NOT NULL THEN
      SELECT * INTO _saved FROM public.reservation_deposits WHERE id=_existing AND organization_id=_org;
      IF _saved.reservation_id IS DISTINCT FROM _res.id OR _saved.branch_id IS DISTINCT FROM _res.branch_id OR _saved.amount IS DISTINCT FROM _amount OR _saved.method IS DISTINCT FROM coalesce(nullif(lower(_method),''),'cash') OR _saved.currency IS DISTINCT FROM public.neo_fact_currency(_org,_res.branch_id) OR _saved.status NOT IN ('held','applied') THEN RAISE EXCEPTION 'Deposit collection key already belongs to different details. Review the saved collection.' USING ERRCODE='23514'; END IF;
    _post := public.neo_deposit_post(_existing, true);
    RETURN jsonb_build_object('deposit_id', _existing, 'idempotent', true,
      'position', public.neo_reservation_deposit_position(_reservation), 'finance', _post);
  END IF;

    IF _res.status NOT IN ('enquiry','on-hold','waitlisted','tentative','pending-deposit','confirmed','guaranteed','provisional-hold','awaiting-deposit') THEN RAISE EXCEPTION 'Record further collections against the active folio after arrival; do not create another pre-arrival deposit'; END IF;
    _facts:=public.neo_reservation_collection_facts(_reservation);
    IF _amount>(_facts->>'headroom')::numeric+0.005 THEN RAISE EXCEPTION 'Deposit exceeds the unpaid booking amount after pending collections'; END IF;
  INSERT INTO public.reservation_deposits
    (organization_id, branch_id, reservation_id, customer_id, amount, method,
     reference, received_by, idempotency_key, notes, currency)
  VALUES
    (_org, _res.branch_id, _reservation, _res.customer_id, round(_amount,2),
     COALESCE(NULLIF(lower(_method),''),'cash'), NULLIF(btrim(COALESCE(_reference,'')),''),
     auth.uid(), _idempotency_key, _notes, public.neo_fact_currency(_org,_res.branch_id))
  RETURNING id INTO _id;

  UPDATE public.reservations r
     SET deposit_paid = (SELECT COALESCE(sum(d.amount),0) FROM public.reservation_deposits d
                          WHERE d.reservation_id = _reservation AND d.status IN ('held','applied')),
         updated_at = now()
   WHERE r.id = _reservation;

  _post := public.neo_deposit_post(_id, true);
  RETURN jsonb_build_object('deposit_id', _id, 'idempotent', false,
    'position', public.neo_reservation_deposit_position(_reservation), 'finance', _post);
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_reservation_financial_state_sync(_reservation uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE facts jsonb;
BEGIN
 IF _reservation IS NULL THEN RETURN; END IF;
 -- The existing facts routine verifies the active workspace. Never silently
 -- skip an out-of-context update and leave a stale reservation balance.
 facts:=public.neo_reservation_collection_facts(_reservation);
 UPDATE public.reservations r SET deposit_paid=(facts->>'deposit_paid')::numeric,
   payment_status=facts->>'payment_status',balance=(facts->>'outstanding')::numeric,
   status=CASE WHEN r.status='pending-deposit' AND (facts->>'minimum_deposit_satisfied')::boolean
     THEN 'confirmed' ELSE r.status END,updated_at=now()
 WHERE r.id=_reservation AND r.organization_id=public.current_org_id()
   AND (r.deposit_paid IS DISTINCT FROM (facts->>'deposit_paid')::numeric
     OR r.payment_status IS DISTINCT FROM facts->>'payment_status'
     OR r.balance IS DISTINCT FROM (facts->>'outstanding')::numeric
     OR (r.status='pending-deposit' AND (facts->>'minimum_deposit_satisfied')::boolean));
END $function$;

CREATE OR REPLACE FUNCTION public.neo_gl_revenue_code_scoped(_org uuid, _category text, _revenue_centre text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
 cat text:=replace(replace(lower(btrim(coalesce(_category,'other'))),'-','_'),' ','_');
 centre text:=replace(replace(lower(btrim(coalesce(_revenue_centre,''))),'-','_'),' ','_');
 stream text; labels text[]; codes text[];
BEGIN
 IF _org IS NULL THEN RAISE EXCEPTION 'Organization required for revenue classification'; END IF;
 stream:=CASE
  WHEN cat IN ('accommodation','room','rooms','lodging') THEN 'rooms'
  WHEN cat IN ('food_beverage','fnb','f_b') AND centre IN ('bar','main_bar','beverage') THEN 'bar'
  WHEN cat IN ('food_beverage','fnb','f_b') AND centre IN ('coffee','coffee_station','cafe') THEN 'coffee'
  WHEN cat IN ('room_service','in_room_dining') THEN 'room_service'
  WHEN cat IN ('meal_plan','restaurant','food','food_beverage','fnb','f_b','dining','kitchen',
   'dine_in','takeaway','take_away','takeout','counter','quick_service','pickup','walk_in',
   'buffet','banquet_food','cafe') THEN 'restaurant'
  WHEN cat IN ('bar','beverage','beverages','drinks','minibar','poolbar','pool_bar') THEN 'bar'
  WHEN cat IN ('coffee','espresso','barista') THEN 'coffee'
  WHEN cat IN ('laundry','dry_cleaning') THEN 'laundry'
  WHEN cat IN ('event','events','banquet','conference','event_catering') THEN 'events'
  WHEN cat='delivery' THEN 'delivery'
  WHEN cat IN ('transfer','transfers','airport_transfer') THEN 'transfers'
  WHEN cat='transport' THEN 'transport'
  WHEN cat IN ('other','miscellaneous','excursion') THEN 'other'
  ELSE NULL END;
 IF stream IS NULL THEN RAISE EXCEPTION 'Unmapped revenue category: %',_category USING ERRCODE='22023'; END IF;
 -- Existing org-level mappings take precedence. Property-specific mappings are
 -- not guessed by this signature, which intentionally has no property argument.
 SELECT array_agg(DISTINCT a.code) INTO codes FROM public.account_mappings m
 JOIN public.chart_of_accounts a ON a.id=m.credit_account_id AND a.organization_id=m.organization_id
 WHERE m.organization_id=_org AND m.active AND m.branch_id IS NULL AND m.payment_method IS NULL
  AND m.source_module IN (stream,cat)
  AND m.event_key IN ('revenue','earned','charge',stream||'.revenue',stream||'.earned')
  AND a.active AND a.postable AND NOT a.is_header AND a.category IN ('revenue','other_income');
 IF cardinality(codes)>1 THEN RAISE EXCEPTION 'Ambiguous revenue mappings for %; configure one account',stream; END IF;
 IF cardinality(codes)=1 THEN RETURN codes[1]; END IF;
 -- Resolve semantic account names from THIS workspace's chart. No hotel ID,
 -- copied account ID or workspace-specific account number is embedded here.
 labels:=CASE stream
  WHEN 'rooms' THEN ARRAY['room revenue','rooms revenue','accommodation revenue']
  WHEN 'restaurant' THEN ARRAY['restaurant revenue','food revenue','food and beverage revenue','food & beverage revenue']
  WHEN 'bar' THEN ARRAY['bar revenue','beverage revenue','bar and beverage revenue']
  WHEN 'coffee' THEN ARRAY['coffee revenue','cafe revenue','coffee station revenue']
  WHEN 'room_service' THEN ARRAY['room service revenue','in room dining revenue']
  WHEN 'laundry' THEN ARRAY['laundry revenue','guest laundry revenue']
  WHEN 'events' THEN ARRAY['event revenue','events revenue','banquet revenue','conference revenue']
  WHEN 'delivery' THEN ARRAY['delivery revenue']
  WHEN 'transfers' THEN ARRAY['transfer revenue','transfers revenue','airport transfer revenue']
  WHEN 'transport' THEN ARRAY['transport revenue']
  ELSE ARRAY['other revenue','other income','miscellaneous revenue'] END;
 SELECT array_agg(DISTINCT a.code) INTO codes FROM public.chart_of_accounts a
 WHERE a.organization_id=_org AND a.active AND a.postable AND NOT a.is_header
  AND a.category IN ('revenue','other_income')
  AND lower(btrim(replace(a.name,'-',' ')))=ANY(labels);
 IF cardinality(codes)>1 THEN RAISE EXCEPTION 'Ambiguous revenue accounts for %; configure an explicit mapping',stream; END IF;
 IF cardinality(codes)=1 THEN RETURN codes[1]; END IF;
 -- A property without separate room-service accounting uses its configured
 -- restaurant account, consistently in every workspace.
 IF stream='room_service' THEN RETURN public.neo_gl_revenue_code_scoped(_org,'restaurant',NULL); END IF;
 RAISE EXCEPTION 'Configure a revenue account or mapping for % in this workspace',stream USING ERRCODE='22023';
END $function$;

CREATE OR REPLACE FUNCTION public.ops_room_availability(_branch uuid, _from date, _to date)
 RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, housekeeping_state text, maintenance_status text, occupancy_status text, sellable_now boolean, available_for_requested_dates boolean, exclusion_reasons text[], data_version timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT rs.*,(now() AT TIME ZONE coalesce(nullif(br.timezone,''),'UTC'))::date AS room_today
    FROM public.ops_room_state(_branch) rs LEFT JOIN public.branches br ON br.id=rs.property_id AND br.organization_id=rs.organization_id
    WHERE rs.organization_id = public.current_org_id() AND public.neo_branch_in_scope(rs.property_id)
      AND _from IS NOT NULL AND _to IS NOT NULL AND _from<_to
  ), overlap AS (
    SELECT s.room_id,
      array_remove(ARRAY[
        CASE WHEN EXISTS (
          SELECT 1 FROM public.reservations r
          WHERE r.room_id = s.room_id
            AND r.organization_id=s.organization_id AND ((r.status IN ('checked-in','in-house','checked_in','in_house') AND r.departure_date<s.room_today) OR
              (r.status IN ('confirmed','guaranteed','checked-in','in-house','checked_in','in_house')
               AND daterange(r.arrival_date, r.departure_date, '[)') && daterange(_from, _to, '[)')))
        ) THEN 'reservation-overlap' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM public.room_assignments a
          WHERE a.room_id = s.room_id AND a.status='active'
            AND daterange(a.start_date, a.end_date, '[)') && daterange(_from, _to, '[)')
        ) THEN 'assignment-overlap' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM public.room_blocks b
          WHERE b.room_id = s.room_id AND b.status='active'
            AND daterange(b.start_date, b.end_date, '[]') && daterange(_from, _to, '[)')
        ) THEN 'room-block' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM public.reservation_holds h
          WHERE h.room_id = s.room_id AND h.status='active' AND h.hold_expires_at > now()
            AND daterange(h.arrival_date, h.departure_date, '[)') && daterange(_from, _to, '[)')
        ) THEN 'active-hold' END
      ], NULL) AS reasons
    FROM s
  ), ooo AS (
    SELECT r.id AS room_id,
      (r.out_of_order_from IS NOT NULL
        AND daterange(r.out_of_order_from, coalesce(r.out_of_order_to, 'infinity'::date), '[]')
            && daterange(_from, _to, '[)')) AS blocked
    FROM public.rooms r
  )
  SELECT s.room_id, s.room_number, s.room_type_id, s.room_type_name,
    s.housekeeping_state, s.maintenance_status, s.occupancy_status,
    s.sellable_now,
    (s.maintenance_status = 'operational'
      AND s.inventory_status = 'active'
      AND coalesce(array_length(o.reasons,1),0) = 0
      AND NOT coalesce(x.blocked,false)
      AND (_from > s.room_today OR (s.housekeeping_state = 'ready' AND s.occupancy_status='vacant'))),
    (o.reasons
      || CASE WHEN _from<=s.room_today AND s.occupancy_status<>'vacant' THEN ARRAY['occupancy-'||s.occupancy_status] ELSE ARRAY[]::text[] END
      || CASE WHEN coalesce(x.blocked,false) THEN ARRAY['out-of-order-period'] ELSE ARRAY[]::text[] END
      || CASE WHEN s.maintenance_status <> 'operational' THEN ARRAY['maintenance-'||s.maintenance_status] ELSE ARRAY[]::text[] END
      || CASE WHEN _from <= s.room_today AND s.housekeeping_state <> 'ready'
              THEN ARRAY['housekeeping-'||s.housekeeping_state] ELSE ARRAY[]::text[] END),
    s.data_version
  FROM s
  JOIN overlap o ON o.room_id = s.room_id
  JOIN ooo x ON x.room_id = s.room_id
  ORDER BY s.room_number;
$function$;

CREATE OR REPLACE FUNCTION public.inventory_consume_order_item_core(_order_item uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item record;
  v_menu record;
  v_recipe record;
  v_comp record;
  v_stock record;

  v_location uuid;
  v_station_location uuid;
  v_line_location uuid;

  v_batches numeric;
  v_cost numeric := 0;
  v_lines integer := 0;
  v_group_lines integer := 0;
  v_volume_lines integer := 0;
  v_waste_lines integer := 0;
  v_ml numeric;

  v_org uuid;
  v_branch uuid;
  v_station uuid;
  v_mode text;

  v_order_number text;
  v_menu_name text;
  v_station_name text;
  v_ticket_number text;
  v_actor text;
  v_store_name text;
  v_note text;
  v_channel text;

  v_components jsonb := '[]'::jsonb;
  v_kind text;
  v_movement_type text;
  v_key text;

  v_batch_use numeric;
  v_batch_use_recipe numeric;
  v_batch_unit text;
BEGIN
  SELECT oi.*, o.branch_id, o.organization_id AS org, o.status AS order_status
    INTO v_item
    FROM public.pos_order_items oi
    JOIN public.pos_orders o ON o.id = oi.order_id
   WHERE oi.id = _order_item;

  IF v_item IS NULL THEN
    RETURN jsonb_build_object('status', 'no-item');
  END IF;

  v_org := v_item.org;
  v_branch := v_item.branch_id;

  IF v_item.order_status IN ('cancelled','voided','void-pending')
     OR v_item.status IN ('draft','cancelled','voided','cancel-pending') THEN

    INSERT INTO public.inventory_posting_events (
      organization_id, branch_id, order_id, order_item_id,
      posting_type, idempotency_key, status, payload
    )
    VALUES (
      v_org, v_branch, v_item.order_id, _order_item,
      'consumption',
      'skip:' || _order_item::text,
      'skipped',
      jsonb_build_object(
        'reason','lifecycle',
        'order_status',v_item.order_status,
        'item_status',v_item.status
      )
    )
    ON CONFLICT DO NOTHING;

    RETURN jsonb_build_object(
      'status','skipped-lifecycle',
      'order_status',v_item.order_status
    );
  END IF;

    IF public.current_org_id() IS DISTINCT FROM v_org OR NOT coalesce(public.neo_branch_in_scope(v_branch),false) THEN
      RAISE EXCEPTION 'Sold item is outside the current organization or property scope' USING ERRCODE='42501';
    END IF;
    -- Serialize all replay paths for this sold item before checking its receipt.
    PERFORM pg_advisory_xact_lock(hashtextextended('pos-consume:'||_order_item::text,0));
    IF v_item.organization_id IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'Sold item belongs to a different organization' USING ERRCODE='23514';
    END IF;
    IF v_item.quantity IS NULL OR v_item.quantity<=0 OR v_item.quantity::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'Sold quantity must be finite and positive' USING ERRCODE='22023';
    END IF;

  IF EXISTS (
    SELECT 1
      FROM public.inventory_posting_events
     WHERE order_item_id = _order_item
       AND status = 'posted'
  ) THEN
    RETURN jsonb_build_object('status','already-posted');
  END IF;

  SELECT o.order_number,
         replace(lower(COALESCE(o.order_type,'')), '_', '-')
    INTO v_order_number, v_channel
    FROM public.pos_orders o
   WHERE o.id = v_item.order_id;

  SELECT *
    INTO v_menu
    FROM public.menu_items
   WHERE id = v_item.menu_item_id;

  IF (v_menu IS NULL OR v_menu.organization_id IS DISTINCT FROM v_org) THEN
    RAISE EXCEPTION 'Menu item is missing or belongs to a different organization' USING ERRCODE='23514';
  END IF;
  v_menu_name := v_menu.name;

  SELECT *
    INTO v_recipe
    FROM public.recipes
   WHERE organization_id = v_org
     AND menu_item_id = v_item.menu_item_id
     AND recipe_type IN ('menu_item','direct_sale')
     AND status = 'active'
   ORDER BY (recipe_type = 'menu_item') DESC, version DESC
   LIMIT 1;

  v_mode := COALESCE(v_menu.consumption_mode, 'none');

  IF v_mode = 'none' AND v_recipe.id IS NOT NULL THEN
    v_mode :=
      CASE
        WHEN v_recipe.recipe_type = 'direct_sale'
          THEN 'direct_stock'
        ELSE 'recipe'
      END;
  END IF;

  IF v_mode NOT IN ('none','recipe','batch','direct_stock') THEN
    RAISE EXCEPTION 'Unknown menu consumption mode' USING ERRCODE='22023';
  END IF;
  IF v_mode = 'none' THEN
    RETURN jsonb_build_object(
      'status','no-consumption',
      'menu_item',v_menu_name
    );
  END IF;

  IF v_menu.consumption_channels IS NOT NULL
     AND array_length(v_menu.consumption_channels, 1) > 0
     AND NOT (v_channel = ANY (v_menu.consumption_channels)) THEN
    RETURN jsonb_build_object(
      'status','channel-excluded',
      'order_channel',v_channel
    );
  END IF;

  v_station := COALESCE(
    v_item.station_id,
    v_menu.station_id,
    v_recipe.station_id
  );

  /*
   * POS consumption is owned by the production station's explicitly mapped
   * departmental store. Menu overrides, item defaults and Main Store fallbacks
   * must never redirect an operational sale.
   */
  v_location :=
    public.neo_station_consumption_location(
      v_org,
      v_station,
      v_branch
    );

  IF v_location IS NULL THEN
    RETURN jsonb_build_object(
      'status','no-location',
      'branch_id',v_branch,
      'station_id',v_station
    );
  END IF;

  IF v_mode IN ('direct_stock','batch') AND
     (v_menu.stock_quantity_per_sale IS NULL OR v_menu.stock_quantity_per_sale<=0 OR v_menu.stock_quantity_per_sale::text IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'Per-sale stock quantity must be finite and positive' USING ERRCODE='22023';
  END IF;
  IF v_mode<>'direct_stock' AND v_recipe.id IS NOT NULL AND
     (v_recipe.yield_quantity IS NULL OR v_recipe.yield_quantity<=0 OR v_recipe.yield_quantity::text IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'Recipe yield must be finite and positive' USING ERRCODE='22023';
  END IF;
  -- Direct-stock products consume their linked inventory item.
  -- Only recipe and batch modes require an active recipe.
  IF v_mode <> 'direct_stock' AND v_recipe IS NULL THEN
    RETURN jsonb_build_object('status','no-recipe');
  END IF;

  IF v_mode <> 'direct_stock'
     AND COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
    RAISE EXCEPTION
      'Recipe % has no usable yield quantity',
      v_recipe.id
      USING ERRCODE = 'data_exception';
  END IF;

  /*
   * batch_operational_consumption
   *
   * Batch mode now means:
   * - reserve/use prepared container quantity operationally
   * - then continue through the canonical recipe expansion below.
   *
   * stock_quantity_per_sale is the amount removed from the prepared
   * container for one sold menu quantity.
   */
  IF v_mode = 'batch' THEN
    v_batch_use :=
      COALESCE(NULLIF(v_menu.stock_quantity_per_sale, 0), 1)
      * COALESCE(v_item.quantity, 1);

    v_batch_unit := COALESCE(
      NULLIF(trim(v_menu.stock_unit), ''),
      NULLIF(trim(v_recipe.yield_unit), '')
    );

    IF v_batch_unit IS NULL THEN
      RAISE EXCEPTION
        'Batch menu item % has no usable consumption unit',
        v_menu.id
        USING ERRCODE = 'data_exception';
    END IF;

    /*
     * Convert the amount used by the sale into the recipe's yield unit.
     *
     * Example:
     *   sale uses 250 ml
     *   recipe yields 10 L
     *   250 ml -> 0.25 L
     *   canonical recipe fraction = 0.25 / 10 = 0.025
     */
    v_batch_use_recipe :=
      public.inventory_convert_strict(
        v_batch_use,
        v_batch_unit,
        v_recipe.yield_unit
      );

    PERFORM public.neo_consume_prepared_batch(
      v_recipe.id,
      v_branch,
      v_batch_use_recipe,
      v_recipe.yield_unit,
      _order_item
    );
  END IF;

  /*
   * Direct-stock products remain direct-stock.
   * Recipe and batch products both consume their canonical recipe here.
   */
  IF v_mode = 'direct_stock' THEN
    IF v_menu.stock_item_id IS NULL THEN
      RETURN jsonb_build_object(
        'status','no-stock-item',
        'menu_item',v_menu_name
      );
    END IF;

    v_components := jsonb_build_array(
      jsonb_build_object(
        'item_id', v_menu.stock_item_id,
        'qty',
          public.inventory_round_for_item(
            COALESCE(NULLIF(v_menu.stock_quantity_per_sale,0),1)
              * COALESCE(v_item.quantity,1),
            COALESCE(NULLIF(v_menu.stock_unit,''),'unit'),
            v_menu.stock_item_id
          ),
        'unit', COALESCE(NULLIF(v_menu.stock_unit,''),'unit'),
        'kind','use'
      )
    );

    v_batches := COALESCE(v_item.quantity, 1);

  ELSE
    -- batch_canonical_recipe_consumption
    --
    -- A normal recipe menu item is driven by menu quantity.
    -- A prepared batch item is driven by the actual amount removed
    -- from the prepared container, converted to recipe-yield units.
    v_batches :=
      CASE
        WHEN v_mode = 'batch'
          THEN v_batch_use_recipe / v_recipe.yield_quantity
        ELSE COALESCE(v_item.quantity, 1) / v_recipe.yield_quantity
      END;

    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'item_id', x.stock_item_id,
                 'qty', x.qty,
                 'unit', x.unit,
                 'kind', x.kind
               )
             ),
             '[]'::jsonb
           )
      INTO v_components
      FROM (
        SELECT
          e.stock_item_id,
          e.kind,
          sum(e.quantity) AS qty,
          min(e.unit) AS unit
        FROM public.recipe_expand_to_stock_kinds(
          v_recipe.id,
          v_batches,
          v_branch
        ) e
        GROUP BY e.stock_item_id, e.kind
      ) x;
  END IF;

  IF jsonb_array_length(v_components)=0 THEN
    RAISE EXCEPTION 'Configured consumption produced no stock components' USING ERRCODE='23514';
  END IF;
  IF v_station IS NOT NULL THEN
    SELECT s.name
      INTO v_station_name
      FROM public.operational_stations s
     WHERE s.id = v_station;
  END IF;

  SELECT t.ticket_number
    INTO v_ticket_number
    FROM public.station_ticket_items ti
    JOIN public.station_tickets t ON t.id = ti.ticket_id
   WHERE ti.order_item_id = _order_item
   ORDER BY t.created_at DESC
   LIMIT 1;

  SELECT COALESCE(p.full_name, p.email)
    INTO v_actor
    FROM public.profiles p
   WHERE p.id = auth.uid();

  FOR v_comp IN
    SELECT
      (e->>'item_id')::uuid AS item_id,
      (e->>'qty')::numeric AS qty,
      e->>'unit' AS unit,
      COALESCE(e->>'kind','use') AS kind
    FROM jsonb_array_elements(v_components) e
  LOOP
    IF (v_comp.item_id IS NULL OR v_comp.qty IS NULL OR v_comp.qty<=0
       OR v_comp.qty::text IN ('NaN','Infinity','-Infinity') OR nullif(btrim(v_comp.unit),'') IS NULL
       OR v_comp.kind NOT IN ('use','waste')) THEN
      RAISE EXCEPTION 'Stock component requires an item, finite positive quantity, unit and valid kind' USING ERRCODE='22023';
    END IF;
    v_kind := v_comp.kind;

    /*
     * Every component of this sold item leaves the same departmental store
     * selected for its production station.
     */
    v_line_location := v_location;

    SELECT sl.name
      INTO v_store_name
      FROM public.stock_locations sl
     WHERE sl.id = v_line_location;

    SELECT si.*
      INTO v_stock
      FROM public.stock_items si
     WHERE si.id = v_comp.item_id;

    IF (v_stock IS NULL OR v_stock.organization_id IS DISTINCT FROM v_org) THEN
      RAISE EXCEPTION 'Stock component is missing or belongs to a different organization' USING ERRCODE='23514';
    END IF;
    v_note :=
      CASE
        WHEN v_kind = 'waste'
          THEN 'Wastage allowance Ãƒâ€šÃ‚Â· order '
        ELSE 'Sale consumption Ãƒâ€šÃ‚Â· order '
      END
      || COALESCE(v_order_number, v_item.order_id::text)
      || ' Ãƒâ€šÃ‚Â· ' || COALESCE(v_menu_name, 'menu item')
      || ' (' || v_mode || ')';

    IF lower(COALESCE(v_comp.unit,'')) IN (
         'ml','millilitre','millilitres','cl','l','litre','litres'
       )
       AND COALESCE(v_stock.tracking_method,'whole') IN ('volume','both')
       AND COALESCE(v_stock.container_volume_ml,0) > 0 THEN

      v_ml :=
        v_comp.qty *
        CASE lower(v_comp.unit)
          WHEN 'cl' THEN 10
          WHEN 'l' THEN 1000
          WHEN 'litre' THEN 1000
          WHEN 'litres' THEN 1000
          ELSE 1
        END;

      PERFORM public.inventory_consume_volume(
        v_comp.item_id,
        v_line_location,
        v_ml,
        v_note,
        CASE WHEN v_kind = 'waste' THEN 'wastage' ELSE 'pour' END,
        'pos_order_item',
        _order_item,
        CASE WHEN v_kind = 'waste' THEN 'pour-waste:' ELSE 'pour:' END
          || _order_item::text || ':' || v_comp.item_id::text
      );

      v_cost :=
        v_cost
        + (v_ml / v_stock.container_volume_ml)
          * COALESCE(v_stock.average_cost, 0);

      v_volume_lines := v_volume_lines + 1;

      IF v_kind = 'waste' THEN
        v_waste_lines := v_waste_lines + 1;
      END IF;

      v_lines := v_lines + 1;

      PERFORM public.neo_evaluate_low_stock(
        v_org,
        v_branch,
        v_comp.item_id,
        'consumption',
        _order_item
      );

      CONTINUE;
    END IF;

    v_movement_type :=
      CASE
        WHEN v_kind = 'waste' THEN 'wastage'
        ELSE 'consumption'
      END;

    v_key :=
      CASE
        WHEN v_kind = 'waste' THEN 'waste:'
        ELSE 'consume:'
      END
      || _order_item::text
      || ':'
      || v_comp.item_id::text;

    PERFORM public.inventory_apply_movement(
      v_comp.item_id,
      v_line_location,
      -v_comp.qty,
      v_comp.unit,
      v_movement_type,
      COALESCE(v_stock.average_cost, 0),
      'pos_order_item',
      _order_item,
      v_note,
      v_key,
      NULL,
      NULL
    );

    v_cost :=
      v_cost
      + v_comp.qty * COALESCE(v_stock.average_cost, 0);

    v_lines := v_lines + 1;

    IF v_kind = 'waste' THEN
      v_waste_lines := v_waste_lines + 1;
    END IF;

    PERFORM public.neo_evaluate_low_stock(
      v_org,
      v_branch,
      v_comp.item_id,
      'consumption',
      _order_item
    );
  END LOOP;

  INSERT INTO public.inventory_posting_events (
    organization_id,
    branch_id,
    order_id,
    order_item_id,
    recipe_id,
    recipe_version,
    posting_type,
    idempotency_key,
    status,
    cost_snapshot,
    payload
  )
  VALUES (
    v_org,
    v_branch,
    v_item.order_id,
    _order_item,
    CASE
      WHEN v_mode IN ('recipe','batch') THEN v_recipe.id
      ELSE NULL
    END,
    CASE
      WHEN v_mode IN ('recipe','batch') THEN v_recipe.version
      ELSE NULL
    END,
    'consumption',
    'consume:' || _order_item::text,
    'posted',
    v_cost,
    jsonb_build_object(
      'lines', v_lines,
      'costing', 'weighted-average',
      'consumption_mode', v_mode,
      'components', v_components,
      'batch_operational_quantity',
        CASE WHEN v_mode = 'batch' THEN v_batch_use ELSE NULL END,
      'batch_operational_unit',
        CASE WHEN v_mode = 'batch' THEN v_batch_unit ELSE NULL END,
      'batch_recipe_quantity',
        CASE WHEN v_mode = 'batch' THEN v_batch_use_recipe ELSE NULL END,
      'batch_recipe_unit',
        CASE WHEN v_mode = 'batch' THEN v_recipe.yield_unit ELSE NULL END,
      'inventory_policy',
        CASE
          WHEN v_mode = 'batch'
            THEN 'batch_canonical_recipe_consumption'
          ELSE v_mode
        END,
      'order_number', v_order_number,
      'menu_item', v_menu_name,
      'ticket_number', v_ticket_number,
      'station_name', v_station_name
    )
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'status','posted',
    'lines',v_lines,
    'cost',v_cost,
    'consumption_mode',v_mode,
    'batch_operational_quantity',
      CASE WHEN v_mode = 'batch' THEN v_batch_use ELSE NULL END,
    'batch_operational_unit',
      CASE WHEN v_mode = 'batch' THEN v_batch_unit ELSE NULL END,
    'batch_recipe_quantity',
      CASE WHEN v_mode = 'batch' THEN v_batch_use_recipe ELSE NULL END,
    'batch_recipe_unit',
      CASE WHEN v_mode = 'batch' THEN v_recipe.yield_unit ELSE NULL END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.pos_record_payment_attempt(_order_id uuid, _amount numeric, _method text, _tendered numeric DEFAULT NULL::numeric, _reference text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _idempotency_key text DEFAULT NULL::text, _manual_confirm boolean DEFAULT false, _note text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _existing public.pos_payments;
  _confirmed numeric := 0;
  _active numeric := 0;
  _balance numeric;
  _headroom numeric;
  _status text;
  _provider boolean;
  _needs_reference boolean;
  _change numeric := 0;
  _payment uuid;
  _shift public.pos_shifts;
  _receipt text;
  _settle jsonb;
  _acct uuid;
  _finance jsonb := jsonb_build_object('ok', true, 'reason', 'not_due');
  _key text := coalesce(nullif(_idempotency_key,''), 'pos-pay:' || _order_id::text || ':' || gen_random_uuid()::text);
BEGIN
  IF NOT public.neo_pos_can_take_payment() THEN
    RAISE EXCEPTION 'Not permitted to take payments';
  END IF;

  SELECT * INTO _existing FROM public.pos_payments
   WHERE organization_id = _org AND idempotency_key = _key;
  IF _existing.id IS NOT NULL THEN
      IF _existing.order_id IS DISTINCT FROM _order_id THEN RAISE EXCEPTION 'Payment intent belongs to a different order' USING ERRCODE='23514'; END IF;
      SELECT * INTO _o FROM public.pos_orders WHERE id=_existing.order_id AND organization_id=_org FOR UPDATE;
      IF _o.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(_o.branch_id),false) THEN RAISE EXCEPTION 'Payment intent belongs to a property outside your access' USING ERRCODE='42501'; END IF;
      IF _existing.branch_id IS DISTINCT FROM _o.branch_id THEN RAISE EXCEPTION 'Payment intent has inconsistent property links' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('payment_id', _existing.id, 'status', _existing.status, 'duplicate', true,
                              'receipt_number', _existing.receipt_number)
        || public.pos_reconcile_settlement_internal(_existing.order_id);
  END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That bill belongs to a property outside your access';
  END IF;
  IF _o.status IN ('closed','cancelled','voided','charged-to-room') THEN
    RAISE EXCEPTION 'Bill is % and cannot take further payment', _o.status;
  END IF;

  _acct := public.neo_assert_financial_account(_org, _o.branch_id, _account);

  IF _method = 'cash' THEN
    _shift_id := coalesce(_shift_id, public.pos_resolve_open_shift(_o.branch_id));
    IF _shift_id IS NULL THEN
      RAISE EXCEPTION 'No cash drawer is open for this property. Open your till before taking cash.';
    END IF;
    SELECT * INTO _shift FROM public.pos_shifts WHERE id = _shift_id AND organization_id = _org FOR UPDATE;
    IF _shift.id IS NULL THEN RAISE EXCEPTION 'Cash drawer not found for this property'; END IF;
    IF _shift.status <> 'open' THEN
      RAISE EXCEPTION 'That cash drawer is % and cannot take cash. Open a till first.', _shift.status;
    END IF;
  END IF;

  IF _shift_id IS NOT NULL THEN
    SELECT * INTO _shift FROM public.pos_shifts WHERE id=_shift_id AND organization_id=_org FOR UPDATE;
    IF auth.uid() IS NULL OR _shift.id IS NULL OR _shift.status IS DISTINCT FROM 'open' OR _shift.branch_id IS DISTINCT FROM _o.branch_id OR _shift.cashier_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Use your own open till for this property; route cash to its assigned cashier otherwise' USING ERRCODE='42501';
    END IF;
  END IF;
  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _confirmed, _active
    FROM public.pos_payments WHERE order_id = _order_id;

  _balance := round(coalesce(_o.grand_total,0) - _confirmed, 2);
  _headroom := round(_balance - _active, 2);

  IF coalesce(_amount,0) <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  IF _amount > _headroom + 0.005 THEN
    RAISE EXCEPTION 'Payment of % exceeds the settleable balance of % (outstanding %, awaiting provider %)',
      _amount, greatest(_headroom,0), greatest(_balance,0), _active;
  END IF;

  _provider := _method IN ('mpesa','card-terminal','qr');
  _needs_reference := _method <> 'cash' AND _method <> 'complimentary';

  IF _needs_reference AND coalesce(btrim(coalesce(_reference,'')),'') = '' THEN
    RAISE EXCEPTION 'A reference is required for a % payment', _method;
  END IF;

  IF _manual_confirm THEN
    IF NOT public.has_permission('pos','payments','manual-confirm') THEN
      RAISE EXCEPTION 'Not permitted to confirm payments manually';
    END IF;
    IF NOT _provider THEN
      RAISE EXCEPTION 'Manual confirmation applies to provider-backed payments only';
    END IF;
    IF coalesce(btrim(coalesce(_note,'')),'') = '' THEN
      RAISE EXCEPTION 'A verification note is required for a manually confirmed payment';
    END IF;
    _status := 'confirmed';
  ELSE
    _status := CASE WHEN _provider THEN 'pending' ELSE 'confirmed' END;
  END IF;

  IF _method = 'cash' AND _tendered IS NOT NULL THEN
    _change := greatest(0, _tendered - _amount);
  END IF;

  IF _status = 'confirmed' THEN
    _receipt := public.next_document_number('receipt');
  END IF;

  INSERT INTO public.pos_payments (
    organization_id, branch_id, order_id, amount, tendered, change_due, currency, method,
    external_reference, receipt_number, status, provider_status, paid_at, cashier_id, shift_id, customer_id,
    created_by, verified_by, verification_note, idempotency_key, destination_account_id
  ) VALUES (
    _org, _o.branch_id, _order_id, round(_amount,2), _tendered, _change, _o.currency, _method,
    nullif(btrim(coalesce(_reference,'')),''), _receipt, _status,
    CASE WHEN _manual_confirm THEN 'manual-confirmed'
         WHEN _provider THEN 'awaiting-provider'
         WHEN _method = 'cash' THEN NULL
         ELSE 'recorded-unverified' END,
    CASE WHEN _status = 'confirmed' THEN now() ELSE NULL END,
    auth.uid(), _shift_id, _o.customer_id, auth.uid(),
    CASE WHEN _manual_confirm THEN auth.uid() ELSE NULL END,
    nullif(btrim(coalesce(_note,'')),''), _key, _acct
  ) RETURNING id INTO _payment;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _o.branch_id, auth.uid(), 'pos.payment.record', 'pos', _order_id,
          jsonb_build_object('paymentId', _payment, 'amount', round(_amount,2), 'method', _method,
                             'status', _status, 'manualConfirm', _manual_confirm,
                             'providerBacked', _provider, 'receiptNumber', _receipt,
                             'shiftId', _shift_id, 'destinationAccountId', _acct,
                             'reference', nullif(btrim(coalesce(_reference,'')),'')));

  _settle := public.pos_reconcile_settlement_internal(_order_id);

  IF coalesce((_settle->>'payment_status'), '') = 'paid' THEN
    _finance := public.neo_finance_post_source('pos', _order_id, true);
  END IF;

  RETURN jsonb_build_object('payment_id', _payment, 'status', _status, 'duplicate', false,
                            'provider_backed', _provider, 'receipt_number', _receipt,
                            'shift_id', _shift_id, 'destination_account_id', _acct, 'finance', _finance)
      || _settle;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_gl_post(_org uuid, _branch uuid, _module text, _source_type text, _source_id uuid, _posting_type text, _date date, _currency text, _desc text, _lines jsonb, _customer uuid DEFAULT NULL::uuid, _reverses uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE key text := _source_type || ':' || _source_id::text || ':' || _posting_type;
        j uuid; ln jsonb; i int := 0; td numeric := 0; tc numeric := 0; acct uuid;
        d numeric; c numeric; prior text; existing public.journal_entries;
BEGIN
    IF public.current_org_id() IS DISTINCT FROM _org OR NOT coalesce(public.neo_branch_in_scope(_branch),false) THEN
      RAISE EXCEPTION 'Posting is outside the current organization or property scope' USING ERRCODE='42501';
    END IF;
    IF _source_id IS NULL OR nullif(btrim(_source_type),'') IS NULL OR nullif(btrim(_posting_type),'') IS NULL THEN
      RAISE EXCEPTION 'Posting source and type are required' USING ERRCODE='22023';
    END IF;
    IF _lines IS NULL OR jsonb_typeof(_lines)<>'array' THEN RAISE EXCEPTION 'Posting lines must be an array'; END IF;
    IF jsonb_array_length(_lines)=0 THEN RAISE EXCEPTION 'nothing_to_post'; END IF;
    FOR ln IN SELECT * FROM jsonb_array_elements(_lines) LOOP
      d:=coalesce((ln->>'debit')::numeric,0);c:=coalesce((ln->>'credit')::numeric,0);
      IF d<0 OR c<0 OR d::text IN ('NaN','Infinity','-Infinity') OR c::text IN ('NaN','Infinity','-Infinity') OR (d>0 AND c>0) THEN
        RAISE EXCEPTION 'Posting amounts must be finite nonnegative and one-sided' USING ERRCODE='22023';
      END IF;
    END LOOP;
    PERFORM pg_advisory_xact_lock(hashtextextended('gl:'||_org::text||':'||key,0));
  SELECT id INTO j FROM public.journal_entries
   WHERE organization_id = _org
     AND (idempotency_key = key OR left(idempotency_key,length(key||':correction:'))=key||':correction:')
     AND reversed_by_journal_id IS NULL
   ORDER BY created_at DESC LIMIT 1;
  IF j IS NOT NULL THEN
      SELECT * INTO existing FROM public.journal_entries WHERE id=j FOR UPDATE;
      IF existing.branch_id IS DISTINCT FROM _branch OR existing.currency IS DISTINCT FROM coalesce(_currency,'KES')
         OR existing.accounting_date IS DISTINCT FROM _date
         OR existing.source_document_id IS DISTINCT FROM _source_id OR existing.source_document_type IS DISTINCT FROM _source_type||':'||_posting_type THEN
        RAISE EXCEPTION 'Existing journal source, property or currency differs';
      END IF;
      IF existing.status IS NULL OR existing.status NOT IN ('posted','draft','approved') THEN RAISE EXCEPTION 'Existing journal cannot be reused from status %',existing.status; END IF;
      SELECT coalesce(sum(debit),0),coalesce(sum(credit),0) INTO td,tc FROM public.journal_entry_lines WHERE journal_id=j;
      IF td<=0 OR td<>tc OR td::text IN ('NaN','Infinity','-Infinity') OR tc::text IN ('NaN','Infinity','-Infinity')
         OR EXISTS(SELECT 1 FROM public.journal_entry_lines l LEFT JOIN public.chart_of_accounts a ON a.id=l.account_id
             WHERE l.journal_id=j AND (l.organization_id IS DISTINCT FROM _org OR a.organization_id IS DISTINCT FROM _org
               OR l.debit IS NULL OR l.credit IS NULL OR l.debit<0 OR l.credit<0 OR (l.debit>0 AND l.credit>0))) THEN
        RAISE EXCEPTION 'Existing journal has invalid or unbalanced lines';
      END IF;
      IF existing.status='posted' THEN
        IF existing.total_debit IS DISTINCT FROM td OR existing.total_credit IS DISTINCT FROM tc THEN RAISE EXCEPTION 'Posted journal totals disagree with its lines'; END IF;
      ELSE
        IF EXISTS(WITH wanted AS (
          SELECT requested.value->>'code' AS code,sum(round(coalesce((requested.value->>'debit')::numeric,0),2)) AS d,sum(round(coalesce((requested.value->>'credit')::numeric,0),2)) AS c
          FROM jsonb_array_elements(_lines) AS requested(value) GROUP BY 1
        ), actual AS (
          SELECT a.code,sum(l.debit) AS d,sum(l.credit) AS c FROM public.journal_entry_lines l JOIN public.chart_of_accounts a ON a.id=l.account_id
          WHERE l.journal_id=j GROUP BY a.code
        ) SELECT 1 FROM wanted w FULL JOIN actual a ON a.code=w.code
          WHERE coalesce(w.d,0)<>coalesce(a.d,0) OR coalesce(w.c,0)<>coalesce(a.c,0)) THEN
          RAISE EXCEPTION 'Existing draft lines differ from the requested posting';
        END IF;
        prior:=coalesce(current_setting('neo.system_posting',true),'off');
        BEGIN
          PERFORM set_config('neo.system_posting','on',true);
          PERFORM public.fin_post_journal(j);
          PERFORM set_config('neo.system_posting',prior,true);
        EXCEPTION WHEN OTHERS THEN
          PERFORM set_config('neo.system_posting',prior,true);RAISE;
        END;
        IF NOT EXISTS(SELECT 1 FROM public.journal_entries WHERE id=j AND status='posted') THEN RAISE EXCEPTION 'Existing journal did not reach posted status'; END IF;
      END IF;
    RETURN jsonb_build_object('ok', true, 'journal_id', j, 'duplicate_prevented', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries
             WHERE organization_id = _org AND idempotency_key = key
               AND reversed_by_journal_id IS NOT NULL) THEN
    key := key || ':correction:' || (1 + (SELECT count(*) FROM public.journal_entries
      WHERE organization_id = _org AND left(idempotency_key,length(key||':correction:'))=key||':correction:'))::text;
  END IF;

  INSERT INTO public.journal_entries
    (organization_id, branch_id, journal_number, journal_type, accounting_date,
     period_id, source_module, source_document_type, source_document_id,
     idempotency_key, description, currency, status, created_by, reverses_journal_id)
  VALUES (_org, _branch, public.next_document_number('journal','JV',_branch),
          CASE WHEN _reverses IS NULL THEN 'automatic' ELSE 'reversal' END, _date,
          public.neo_gl_period(_org, _date), _module,
          _source_type || ':' || _posting_type, _source_id, key, _desc,
          coalesce(_currency,'KES'), 'draft', auth.uid(), _reverses)
  RETURNING id INTO j;

  FOR ln IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    d := round(coalesce((ln->>'debit')::numeric, 0), 2);
    c := round(coalesce((ln->>'credit')::numeric, 0), 2);
    CONTINUE WHEN d = 0 AND c = 0;
    acct := public.neo_gl_acct(_org, ln->>'code');
    IF acct IS NULL THEN
      RAISE EXCEPTION 'chart_of_accounts is missing postable account %', ln->>'code';
    END IF;
    i := i + 1;
    INSERT INTO public.journal_entry_lines
      (organization_id, journal_id, line_number, account_id, description, debit, credit,
       branch_id, customer_id)
    VALUES (_org, j, i, acct, coalesce(ln->>'description', _desc), d, c, _branch, _customer);
    td := td + d; tc := tc + c;
  END LOOP;

  IF i = 0 THEN RAISE EXCEPTION 'nothing_to_post'; END IF;
  IF round(td,2) <> round(tc,2) THEN
    RAISE EXCEPTION 'Journal does not balance: debits % vs credits %', td, tc;
  END IF;

  UPDATE public.journal_entries
     SET total_debit = round(td,2), total_credit = round(tc,2)
   WHERE id = j;

  -- Automatic module postings are system postings: the operational authority was
  -- already verified upstream, so the caller does not need manual journal rights.
  prior := coalesce(current_setting('neo.system_posting', true), 'off');
  PERFORM set_config('neo.system_posting', 'on', true);
  PERFORM public.fin_post_journal(j);
  PERFORM set_config('neo.system_posting', prior, true);
  RETURN jsonb_build_object('ok', true, 'journal_id', j, 'duplicate_prevented', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_folio_sync_reservation_payment_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE booking public.reservations;
BEGIN
 IF NEW.reservation_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO booking FROM public.reservations r WHERE r.id=NEW.reservation_id AND r.organization_id=NEW.organization_id AND r.branch_id IS NOT DISTINCT FROM NEW.branch_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 PERFORM public.neo_reservation_financial_state_sync(booking.id);
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_reservation_collection_source_refresh()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE row_data jsonb; res uuid; previous_res uuid;
BEGIN
 row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 res:=CASE WHEN TG_TABLE_NAME='reservations' THEN nullif(row_data->>'id','')::uuid ELSE nullif(row_data->>'reservation_id','')::uuid END;
 IF res IS NULL THEN SELECT f.reservation_id INTO res FROM public.folios f WHERE f.id=nullif(row_data->>'folio_id','')::uuid AND f.organization_id=(row_data->>'organization_id')::uuid; END IF;
 IF res IS NOT NULL THEN PERFORM public.neo_reservation_financial_state_sync(res); END IF;
 IF TG_OP='UPDATE' THEN
  previous_res:=nullif(to_jsonb(OLD)->>'reservation_id','')::uuid;
  IF previous_res IS NULL THEN SELECT f.reservation_id INTO previous_res FROM public.folios f WHERE f.id=nullif(to_jsonb(OLD)->>'folio_id','')::uuid AND f.organization_id=OLD.organization_id; END IF;
  IF previous_res IS NOT NULL AND previous_res IS DISTINCT FROM res THEN PERFORM public.neo_reservation_financial_state_sync(previous_res); END IF;
 END IF;
 RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.inventory_post_stock_take(_take uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  s record;
  l record;
  v_value numeric := 0;
BEGIN
  IF NOT has_permission('inventory','stocktake.manage') THEN RAISE EXCEPTION 'Not permitted to close stock takes'; END IF;
  SELECT * INTO s FROM stock_takes WHERE id = _take AND organization_id = v_org FOR UPDATE;
  IF s IS NULL THEN RAISE EXCEPTION 'Stock take not found'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_locations sl WHERE sl.id=s.location_id AND sl.organization_id=v_org AND public.neo_branch_in_scope(sl.branch_id) IS TRUE) THEN RAISE EXCEPTION 'Stock take outside authorized property scope' USING ERRCODE='42501'; END IF;
  IF s.status = 'closed' THEN RETURN jsonb_build_object('status','already-closed'); END IF;

    PERFORM 1 FROM public.stock_take_lines WHERE stock_take_id=_take FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM public.stock_take_lines WHERE stock_take_id=_take) THEN RAISE EXCEPTION 'A stock take needs counted lines before closure'; END IF;
    IF EXISTS(SELECT 1 FROM public.stock_take_lines WHERE stock_take_id=_take AND (counted_quantity IS NULL OR counted_quantity<0 OR counted_quantity::text IN ('NaN','Infinity','-Infinity') OR system_quantity IS NULL OR system_quantity::text IN ('NaN','Infinity','-Infinity') OR unit_cost<0 OR unit_cost::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Complete every stock count with finite nonnegative counted quantities before closing'; END IF;
  FOR l IN SELECT * FROM stock_take_lines WHERE stock_take_id = _take AND counted_quantity IS NOT NULL LOOP
    UPDATE stock_take_lines SET variance = l.counted_quantity - l.system_quantity WHERE id = l.id;
    IF l.counted_quantity <> l.system_quantity THEN
      PERFORM inventory_apply_movement(l.stock_item_id, s.location_id, l.counted_quantity - l.system_quantity, l.unit,
        'stock-take', NULL, 'stock_take', _take, 'Stock count variance',
        'stocktake:' || _take::text || ':' || l.id::text, NULL, NULL);
      v_value := v_value + ((l.counted_quantity - l.system_quantity) * COALESCE(NULLIF(l.unit_cost, 0), 0));
    END IF;
  END LOOP;

  UPDATE stock_takes SET status = 'closed', completed_at = now(), variance_value = v_value, approved_by = auth.uid() WHERE id = _take;
  RETURN jsonb_build_object('status','closed','variance',v_value);
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_stores_issue(_location uuid, _lines jsonb, _attempt uuid, _department uuid DEFAULT NULL::uuid, _reason text DEFAULT NULL::text, _direction text DEFAULT 'issue'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _prior jsonb; _line jsonb;
        _sign numeric; _count integer := 0; _idx integer := 0; _qty numeric;
        _loc record; _movements uuid[] := '{}';
        _cost numeric; _value numeric := 0; _unvalued integer := 0;
        _pol public.procurement_matching_policies; _gl jsonb; _journal uuid;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;
  IF lower(coalesce(_direction,'issue')) NOT IN ('issue','return') THEN
    RAISE EXCEPTION 'invalid_direction' USING ERRCODE='22023';
  END IF;

    IF NOT (public.has_permission('stores','issues.create') OR public.has_permission('stores','requisition.issue') OR public.is_org_admin()) THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.stock_locations WHERE id=_location AND organization_id=_org AND coalesce(public.neo_branch_in_scope(branch_id),false)) THEN RAISE EXCEPTION 'store_out_of_scope' USING ERRCODE='42501'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('store:'||_org::text||':'||lower(_direction)||':'||_attempt::text,0));
  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='stores.'||lower(_direction) AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;

  IF NOT (public.has_permission('stores','issues.create')
          OR public.has_permission('stores','requisition.issue')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _loc FROM public.stock_locations WHERE id=_location AND organization_id=_org AND active;
  IF _loc IS NULL THEN RAISE EXCEPTION 'store_location_required' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_loc.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'reason_required' USING ERRCODE='22023'; END IF;

    IF _lines IS NULL OR jsonb_typeof(_lines)<>'array' THEN RAISE EXCEPTION 'stock_lines_required'; END IF;
    IF jsonb_array_length(_lines)=0 THEN RAISE EXCEPTION 'stock_lines_required'; END IF;
    FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
      _qty:=(_line->>'quantity')::numeric;
      IF _qty IS NULL OR _qty<=0 OR _qty::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'stock_quantity_must_be_finite_positive' USING ERRCODE='22023'; END IF;
      IF (_line->>'unit_cost')::numeric<0 OR ((_line->>'unit_cost')::numeric)::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'stock_cost_must_be_finite_nonnegative' USING ERRCODE='22023'; END IF;
    END LOOP;
  _sign := CASE WHEN lower(_direction)='issue' THEN -1 ELSE 1 END;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _idx := _idx + 1;
    _qty := COALESCE((_line->>'quantity')::numeric, 0);
    IF _qty <= 0 THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.stock_items si
                    WHERE si.id=(_line->>'stock_item_id')::uuid AND si.organization_id=_org) THEN
      RAISE EXCEPTION 'unknown_stock_item' USING ERRCODE='22023';
    END IF;

    -- Value the movement from recorded purchase cost only; never invent a cost.
    _cost := nullif((_line->>'unit_cost')::numeric, 0);
    IF _cost IS NULL THEN
      _cost := public.neo_stock_average_cost((_line->>'stock_item_id')::uuid, _location);
    END IF;
    IF (_cost<0 OR _cost::text IN ('NaN','Infinity','-Infinity')) THEN RAISE EXCEPTION 'stock_cost_must_be_finite_nonnegative' USING ERRCODE='22023'; END IF;
    IF _cost IS NULL OR _cost <= 0 THEN
      _unvalued := _unvalued + 1;
    ELSE
      _value := _value + round(_qty * _cost, 2);
    END IF;

    _movements := _movements || public.inventory_apply_movement(
      (_line->>'stock_item_id')::uuid, _location, _sign * _qty, nullif(_line->>'unit',''),
      CASE WHEN _sign < 0 THEN 'issue' ELSE 'return' END, _cost,
      'store_'||lower(_direction), _attempt, _reason,
      'store:'||lower(_direction)||':'||_attempt::text||':'||_idx::text, NULL, NULL);
    IF (_movements[array_length(_movements,1)] IS NULL) THEN RAISE EXCEPTION 'stock_movement_not_saved'; END IF;
    _count := _count + 1;
  END LOOP;

  IF _count = 0 THEN RAISE EXCEPTION 'no_lines' USING ERRCODE='22023'; END IF;

    IF (SELECT count(*) FROM public.stock_movements m WHERE m.organization_id=_org AND m.id=ANY(_movements))<>_count OR EXISTS(SELECT 1 FROM public.stock_movements m WHERE m.organization_id=_org AND m.id=ANY(_movements) AND (m.quantity IS NULL OR m.quantity::text IN ('NaN','Infinity','-Infinity') OR m.unit_cost<0 OR m.unit_cost::text IN ('NaN','Infinity','-Infinity') OR m.value::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Saved issue or return valuation needs review'; END IF;
    -- Movement values already use the converted base quantity and actual cost.
    SELECT coalesce(sum(abs(m.value)),0),count(*) FILTER(WHERE m.unit_cost IS NULL OR m.unit_cost<=0) INTO _value,_unvalued FROM public.stock_movements m WHERE m.organization_id=_org AND m.id=ANY(_movements);
    _value:=round(_value,2);

  IF round(_value, 2) > 0 THEN
    _pol := public.neo_matching_policy(_org, _loc.branch_id);
    PERFORM public.neo_finance_ensure_account(_org, _pol.inventory_account_code, 'Inventory', 'asset', 'Current Assets');
    PERFORM public.neo_finance_ensure_account(_org, _pol.cost_of_sales_account_code, 'Cost of Sales — Stores Issues', 'cost_of_sales', 'Cost of Sales');
    IF _sign < 0 THEN
      _gl := jsonb_build_array(
        jsonb_build_object('code', _pol.cost_of_sales_account_code, 'debit', round(_value,2), 'description', 'Stock issued to operations'),
        jsonb_build_object('code', _pol.inventory_account_code, 'credit', round(_value,2), 'description', 'Inventory released on issue'));
    ELSE
      _gl := jsonb_build_array(
        jsonb_build_object('code', _pol.inventory_account_code, 'debit', round(_value,2), 'description', 'Inventory restored on return'),
        jsonb_build_object('code', _pol.cost_of_sales_account_code, 'credit', round(_value,2), 'description', 'Stock returned from operations'));
    END IF;
    _journal := (public.neo_gl_post(_org, _loc.branch_id, 'stores', 'stock_'||lower(_direction), _attempt,
                   'consumption', CURRENT_DATE, public.neo_fact_currency(_org,_loc.branch_id),
                   'Stock '||lower(_direction)||' '||_attempt::text, _gl)->>'journal_id')::uuid;
  END IF;

  _prior := jsonb_build_object('ok',true,'direction',lower(_direction),'lines',_count,
              'location_id',_location,'department_id',_department,'movements',to_jsonb(_movements),
              'value', round(_value,2), 'unvalued_lines', _unvalued, 'journal_id', _journal);
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'stores.'||lower(_direction),_attempt,_location,_prior);
  RETURN _prior;
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_stores_count_submit_variance(_take uuid, _notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  s record; l record;
  v_adj uuid; v_lines int := 0; v_value numeric := 0; v_number text;
  v_invalid int := 0; v_counted int := 0; v_total int := 0;
BEGIN
  IF NOT (has_permission('stores','edit') OR has_permission('inventory','stocktake.manage') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to submit stock count variances';
  END IF;
  SELECT * INTO s FROM stock_takes WHERE id = _take AND organization_id = v_org FOR UPDATE;
  IF s IS NULL THEN RAISE EXCEPTION 'Stock take not found'; END IF;
  IF NOT coalesce(public.neo_branch_in_scope(s.branch_id),false) THEN RAISE EXCEPTION 'Count is outside your property scope' USING ERRCODE='42501'; END IF;
  IF s.status IN ('closed','awaiting-approval') THEN
    RETURN jsonb_build_object('status', s.status, 'adjustment', NULL);
  END IF;

    IF s.status IS NULL OR s.status NOT IN ('in-progress','open','counting') THEN RAISE EXCEPTION 'Count cannot be submitted from status %',s.status; END IF;
    -- Stabilize submitted line values for the whole submission transaction.
    PERFORM 1 FROM public.stock_take_lines WHERE stock_take_id=_take FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.stock_take_lines count_line WHERE count_line.stock_take_id=_take AND
       (count_line.organization_id IS DISTINCT FROM v_org OR count_line.counted_quantity IS NULL)) THEN
      RAISE EXCEPTION 'count_incomplete: every line must be counted in this workspace before submission' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM public.stock_take_lines count_line WHERE count_line.stock_take_id=_take AND
       (count_line.counted_quantity::text IN ('NaN','Infinity','-Infinity') OR count_line.system_quantity IS NULL OR count_line.system_quantity::text IN ('NaN','Infinity','-Infinity')
        OR count_line.unit_cost<0 OR count_line.unit_cost::text IN ('NaN','Infinity','-Infinity'))) THEN
      RAISE EXCEPTION 'count_line_invalid: count amounts must be finite and the snapshot must be present' USING ERRCODE='22023';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.stock_take_lines WHERE stock_take_id=_take) THEN
      RAISE EXCEPTION 'count_empty: no stock lines exist for this count' USING ERRCODE='23514';
    END IF;
  SELECT count(*), count(*) FILTER (WHERE counted_quantity IS NOT NULL),
         count(*) FILTER (WHERE counted_quantity < 0)
    INTO v_total, v_counted, v_invalid
    FROM stock_take_lines WHERE stock_take_id = _take;

  IF v_invalid > 0 THEN
    RAISE EXCEPTION 'count_line_invalid: % line(s) hold a negative physical count.', v_invalid
      USING HINT = 'Correct those lines before closing the count.';
  END IF;

  IF v_total > 0 AND v_counted = 0 THEN
    RAISE EXCEPTION 'count_not_started: no quantity has been counted on this count yet.'
      USING HINT = 'Record at least one counted quantity, or abandon the count.';
  END IF;

  UPDATE stock_take_lines
     SET variance = counted_quantity - COALESCE(system_quantity, 0)
   WHERE stock_take_id = _take AND counted_quantity IS NOT NULL;

  SELECT count(*) INTO v_lines FROM stock_take_lines
   WHERE stock_take_id = _take AND counted_quantity IS NOT NULL AND variance <> 0;

  IF v_lines = 0 THEN
    UPDATE stock_takes
       SET status = 'closed', completed_at = now(), variance_value = 0,
           counted_by = COALESCE(counted_by, auth.uid())
     WHERE id = _take;
    RETURN jsonb_build_object('status','closed','adjustment',NULL,'lines',0,'counted',v_counted,'total',v_total);
  END IF;

  BEGIN
    SELECT next_document_number('stock-adjustment') INTO v_number;
  EXCEPTION WHEN OTHERS THEN
    v_number := 'ADJ-' || to_char(now(), 'YYYYMMDDHH24MISS');
  END;

  INSERT INTO stock_adjustments (organization_id, branch_id, adjustment_number, location_id, reason, status, notes, requested_by)
  VALUES (v_org, s.branch_id, COALESCE(v_number, 'ADJ-' || to_char(now(),'YYYYMMDDHH24MISS')), s.location_id,
          'count-variance', 'pending',
          COALESCE(_notes, 'Variance from stock count ' || COALESCE(s.reference, _take::text)), auth.uid())
  RETURNING id INTO v_adj;

  FOR l IN SELECT * FROM stock_take_lines
            WHERE stock_take_id = _take AND counted_quantity IS NOT NULL AND variance <> 0 LOOP
    INSERT INTO stock_adjustment_lines (organization_id, adjustment_id, stock_item_id, quantity, unit, unit_cost, reason)
    VALUES (v_org, v_adj, l.stock_item_id, l.variance, l.unit, l.unit_cost,
            'Count variance: counted ' || l.counted_quantity || ' against system ' || COALESCE(l.system_quantity,0));
    v_value := v_value + abs(l.variance * COALESCE(NULLIF(l.unit_cost,0),0));
  END LOOP;

  UPDATE stock_adjustments SET total_value = v_value WHERE id = v_adj;
  UPDATE stock_takes SET status = 'awaiting-approval', completed_at = now(), variance_value = v_value,
                         counted_by = COALESCE(counted_by, auth.uid())
   WHERE id = _take;

  RETURN jsonb_build_object('status','awaiting-approval','adjustment',v_adj,'lines',v_lines,'value',v_value,
                            'counted',v_counted,'total',v_total);
END $function$;

CREATE OR REPLACE FUNCTION public.neo_revenue_reconciliation(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(module text, operational_amount numeric, posted_amount numeric, variance numeric, awaiting_amount numeric, blocked_amount numeric, failed_amount numeric, explanation text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare org uuid := public.current_org_id(); tz text; f date; t date; report_currency text;
begin
  if org is null or not (public.is_org_admin() or public.has_permission('finance','view')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  tz := public.neo_fact_timezone(org, _branch);
  t := coalesce(_to, (now() at time zone tz)::date);
  f := coalesce(_from, t - 29);
  report_currency:=public.neo_fact_currency(org,_branch);
  if nullif(btrim(report_currency),'') is null then raise exception 'Report currency is not configured'; end if;

  -- This contract has no currency column: never add different currencies.
  if exists (
    select 1 from public.pos_orders o where o.organization_id=org
      and (_branch is null or o.branch_id=_branch) and o.folio_id is null
      and o.status in ('closed','paid','settled','completed') and o.currency is distinct from report_currency
      and (coalesce(o.closed_at,o.created_at) at time zone tz)::date between f and t
  ) or exists (
    select 1 from public.folio_lines fl join public.folios fo on fo.id=fl.folio_id and fo.organization_id=fl.organization_id
    where fl.organization_id=org and (_branch is null or fl.branch_id=_branch)
      and fl.status='posted' and coalesce(fl.line_type,'charge')<>'payment'
      and coalesce(fl.operational_date,(fl.posting_date at time zone tz)::date) between f and t
      and fo.currency is distinct from report_currency
  ) or exists (
    select 1 from public.journal_entries j where j.organization_id=org
      and (_branch is null or j.branch_id=_branch) and j.status='posted'
      and j.accounting_date between f and t and j.currency is distinct from report_currency
  ) then raise exception 'Revenue report contains currencies different from %. Filter to one currency/property or configure verified conversion.',report_currency; end if;

  return query
  with source_rows as (
    -- Finalised standalone sales are revenue; room transfers are recognised on folio charges.
    select 'pos'::text as m,o.id as source_id,'pos_order:revenue'::text as source_type,
      (coalesce(o.grand_total,0)-coalesce(o.tax_total,0)-coalesce(o.service_charge_total,0))::numeric as net,
      o.branch_id
    from public.pos_orders o
    where o.organization_id=org
      and (_branch is null or o.branch_id=_branch) and o.folio_id is null
      and o.status in ('closed','paid','settled','completed')
      and (coalesce(o.closed_at,o.created_at) at time zone tz)::date between f and t
    union all
    select 'folio',fl.id,'folio_charge:revenue',
      (coalesce(fl.gross_amount,0)-coalesce(fl.discount_amount,0))::numeric,fl.branch_id
    from public.folio_lines fl
    where fl.organization_id=org
      and (_branch is null or fl.branch_id=_branch) and fl.status='posted'
      and coalesce(fl.line_type,'charge')<>'payment'
      and coalesce(fl.operational_date,(fl.posting_date at time zone tz)::date) between f and t
  ), source_evidence as (
    select s.*,exists(select 1 from public.journal_entries j
      where j.organization_id=org and j.branch_id is not distinct from s.branch_id
      and j.source_document_id=s.source_id and j.source_document_type=s.source_type
      and j.status='posted' and j.reversed_by_journal_id is null
      and j.reverses_journal_id is null and j.total_debit=j.total_credit and j.total_debit<>0) as posted,
      (select r.status from public.finance_posting_receipts r
       where r.organization_id=org and r.branch_id is not distinct from s.branch_id
       and r.source_id=s.source_id order by r.updated_at desc,r.id limit 1) as receipt_status
    from source_rows s
  ), q_source as (
    select m,sum(net) as source_amount,
      sum(net) filter(where not posted and coalesce(receipt_status,'') not in ('failed','blocked')) as awaiting,
      sum(net) filter(where not posted and receipt_status='blocked') as blocked,
      sum(net) filter(where not posted and receipt_status='failed') as failed
    from source_evidence group by m
  ), q_legacy as (
    select public.neo_module_label(k.source_module) as m,
           sum(k.amount) as source_amount,
           sum(k.amount) filter (where k.eligible) as awaiting,
           sum(k.amount) filter (where not k.eligible) as blocked
      from public.neo_finance_posting_queue(_branch, f, t) k
     where public.neo_module_label(k.source_module) not in ('pos','folio')
     group by 1
  ), q as (
    select m,source_amount,awaiting,blocked,failed from q_source
    union all select m,source_amount,awaiting,blocked,null::numeric from q_legacy
  ), r as (
    select public.neo_module_label(x.source_module) as m,
           sum(x.amount) filter (where x.status = 'failed') as failed
      from public.finance_posting_receipts x
     where x.organization_id = org
       and (_branch is null or x.branch_id = _branch)
       and coalesce(x.occurred_on, (x.created_at at time zone tz)::date) between f and t
     group by 1
  ), g as (
    select public.neo_module_label(j.source_module) as m,
           sum(l.credit - l.debit) as posted
      from public.journal_entries j
      join public.journal_entry_lines l on l.journal_id = j.id
      join public.chart_of_accounts c on c.id = l.account_id
     where j.organization_id = org
       and j.status = 'posted'
       and (_branch is null or j.branch_id = _branch)
       and j.accounting_date between f and t
       and c.category in ('revenue','other_income')
     group by 1
  ), joined as (
    select coalesce(q.m, r.m, g.m)::text as m,
           coalesce(q.source_amount, 0)::numeric(18,2) as src,
           coalesce(g.posted, 0)::numeric(18,2) as pst,
           coalesce(q.awaiting, 0)::numeric(18,2) as await_amt,
           coalesce(q.blocked, 0)::numeric(18,2) as blk,
           case when coalesce(q.m,r.m,g.m) in ('pos','folio')
             then coalesce(q.failed,0) else coalesce(r.failed,0) end::numeric(18,2) as fail
      from q
      full outer join r on r.m = q.m
      full outer join g on g.m = coalesce(q.m, r.m)
  )
  select j.m,
         j.src, j.pst, (j.src - j.pst)::numeric(18,2),
         j.await_amt, j.blk, j.fail,
         case
           when j.m not in ('pos','folio')
             then 'Legacy stream calculation: not certified as earned-revenue reconciliation. Review this stream separately.'
           when abs(j.src - j.pst) < 0.01 then 'Reconciled — operations and Finance agree.'
           else trim(both ' ' from concat_ws(' ',
             case when j.await_amt > 0 then 'Awaiting posting: ' || to_char(j.await_amt, 'FM999,999,999.00') || '.' end,
             case when j.blk > 0 then 'Blocked by a posting rule: ' || to_char(j.blk, 'FM999,999,999.00') || '.' end,
             case when j.fail > 0 then 'Failed postings needing retry: ' || to_char(j.fail, 'FM999,999,999.00') || '.' end,
             case when j.await_amt = 0 and j.blk = 0 and j.fail = 0
                  then 'Difference sits outside the posting queue — review the period and source records.' end))
         end::text
    from joined j
   order by 1;
end $function$;

CREATE OR REPLACE FUNCTION public.pms_confirm_payment(_payment uuid, _reference text DEFAULT NULL::text, _note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid:=public.current_org_id(); p public.payments; f public.folios; allocated numeric; allocation_count integer;
BEGIN
 IF org IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','no_organisation'); END IF;
 IF NOT (public.has_permission('pms','payments.confirm') OR public.has_permission('finance','approve') OR public.is_org_admin() OR public.neo_system_posting()) THEN RAISE EXCEPTION 'Not permitted to confirm payments' USING ERRCODE='42501'; END IF;
 PERFORM public.neo_pms_collection_lock((SELECT folio_id FROM public.payments WHERE id=_payment AND organization_id=org));
 SELECT * INTO p FROM public.payments WHERE id=_payment AND organization_id=org FOR UPDATE;
 IF p.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF NOT coalesce(public.neo_branch_in_scope(p.branch_id),false) THEN RAISE EXCEPTION 'Payment is outside your property scope' USING ERRCODE='42501'; END IF;
 IF p.status='confirmed' THEN RETURN jsonb_build_object('ok',true,'reason','already_confirmed','payment_id',p.id); END IF;
 IF p.status NOT IN ('pending','processing','submitted') THEN RETURN jsonb_build_object('ok',false,'reason','invalid_status','status',p.status); END IF;
 IF p.method NOT IN ('cash','corporate-credit','card','bank-transfer','bank','bank_transfer','eft','voucher','ota-prepaid','debit-card','credit-card') THEN RETURN jsonb_build_object('ok',false,'reason','provider_confirmation_required','detail','This provider-backed payment requires its verified provider confirmation.'); END IF;
 IF p.amount IS NULL OR p.amount<=0 OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount<>round(p.amount,2) THEN RAISE EXCEPTION 'Payment amount is invalid'; END IF;
 IF p.method NOT IN ('cash','corporate-credit') AND nullif(btrim(coalesce(_reference,p.external_reference,'')),'') IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','reference_required','detail','External payments require a confirmation reference.'); END IF;
 SELECT * INTO f FROM public.folios WHERE id=p.folio_id AND organization_id=org FOR UPDATE;
 IF f.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','folio_not_found'); END IF;
 IF f.status NOT IN ('open','under-review') THEN RETURN jsonb_build_object('ok',false,'reason','folio_not_open','status',f.status); END IF;
 IF p.branch_id IS DISTINCT FROM f.branch_id OR p.currency IS DISTINCT FROM f.currency THEN RAISE EXCEPTION 'Payment property or currency differs from the folio'; END IF;
 IF p.amount>public.neo_pms_collection_headroom(f.id,p.id,NULL)+0.005 THEN RAISE EXCEPTION 'Payment exceeds the current unpaid amount after other pending collections'; END IF;
 SELECT count(*),coalesce(sum(a.amount),0) INTO allocation_count,allocated FROM public.payment_allocations a WHERE a.payment_id=p.id AND a.organization_id=org;
 IF allocation_count>0 AND (allocation_count<>1 OR allocated IS DISTINCT FROM p.amount OR NOT EXISTS(SELECT 1 FROM public.payment_allocations a WHERE a.payment_id=p.id AND a.folio_id=f.id AND a.organization_id=org AND a.amount=p.amount)) THEN RAISE EXCEPTION 'Existing payment allocations need review before confirmation'; END IF;
 IF allocation_count=0 THEN
  INSERT INTO public.payment_allocations(organization_id,payment_id,folio_id,amount,created_by) VALUES(org,p.id,f.id,p.amount,auth.uid());
  UPDATE public.folios SET total_payments=total_payments+p.amount,balance=balance-p.amount,updated_at=now() WHERE id=f.id AND organization_id=org;
 END IF;
 UPDATE public.payments SET status='confirmed',external_reference=coalesce(nullif(btrim(_reference),''),external_reference),notes=concat_ws(' · ',nullif(notes,''),nullif(_note,'')),paid_at=now(),updated_at=now() WHERE id=p.id AND organization_id=org;
 INSERT INTO public.audit_logs(organization_id,user_id,user_name,action,module,record_id,new_value,reason) VALUES(org,auth.uid(),'','pms.payment.confirm','finance',p.id::text,jsonb_build_object('folio_id',f.id,'amount',p.amount,'method',p.method,'reference',coalesce(nullif(btrim(_reference),''),p.external_reference)),_note);
 RETURN jsonb_build_object('ok',true,'payment_id',p.id,'folio_id',f.id,'amount',p.amount,'balance',(SELECT balance FROM public.folios WHERE id=f.id AND organization_id=org));
END $function$;
NOTIFY pgrst,'reload schema';
WITH expected(signature,hash) AS (VALUES ('public.neo_cash_settle_request(uuid)','9217c85e7679c639650f79fb7fdd87ea'),
('public.pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid)','b2b0aa063506ccc86dcceef31b2759bc'),
('public.ops_room_state(uuid)','d42f1e6a0d4516ea129135c5954ee434'),
('public.pms_record_payment(uuid,numeric,text,text,text,text,uuid)','d5c0acac22026f8f024a7f6f5751823d'),
('public.neo_cash_till_context(uuid)','a20f1fd2483c58b3bc4671d0ca9c3e0f'),
('public.neo_cash_request_payment(uuid,numeric,text,text,text)','6b21da0e161adcaeeee6ad2e3179db32'),
('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text)','f11b167821be12080cc22324f843d13c'),
('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text,numeric)','c40eacd9e94530e01e0818de74a8d096'),
('public.neo_supplier_invoice_accept(uuid,text)','dc36db393c366c4b3e8fbd30c3ee1690'),
('public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text)','d07a7ae828c74596ad4a0bb01fb3a198'),
('public.neo_reservation_financial_state_sync(uuid)','221250a170cc5862b988f26bf7931b0d'),
('public.neo_gl_revenue_code_scoped(uuid,text,text)','5250b67c6e29ee6fc949b72fd847ac59'),
('public.ops_room_availability(uuid,date,date)','fc376d87b1ce7b568fa43a4bbd8a93f1'),
('public.inventory_consume_order_item_core(uuid)','0ff5a66b125e3aee34ffb5598cfb1685'),
('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)','261a88efb731375ff8c31557c79b6411'),
('public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid)','bb97bc255ef2b3c0644d4248240d1406'),
('public.tg_folio_sync_reservation_payment_status()','a8a9705fee7ed15013653b71ec9bef74'),
('public.neo_reservation_collection_source_refresh()','29e89bf056097b5d0ef6c50b8cfe2ac5'),
('public.inventory_post_stock_take(uuid)','c2c1b4212c3e36ad219236109e977fd7'),
('public.neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)','32ed1a1bd69d2a852c6a45ecc40e57da'),
('public.neo_stores_count_submit_variance(uuid,text)','e6c05479319fdbb2dca31d9afdc32274'),
('public.neo_revenue_reconciliation(uuid,date,date)','fe898ebc5a5912d852b3228c140cf27c'),
('public.pms_confirm_payment(uuid,text,text)','96b6d1965ba35f1f78ccbfa21277320b')), checked AS (
 SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) matches FROM expected)
SELECT jsonb_build_object('diagnostic_version','shared-workspace-workflows-v1',
 'definitions_match',(SELECT bool_and(matches) FROM checked),
 'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),
 'scope','Installs shared workflow logic for all workspaces. No payment, stock movement, approval, historical rewrite or permission change is executed by installation.') result;
COMMIT;
