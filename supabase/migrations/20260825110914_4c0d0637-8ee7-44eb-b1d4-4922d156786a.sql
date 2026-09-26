-- ============================================================
-- A. POS -> KDS : canonical send-to-kitchen for every kitchen-bound order
-- ============================================================

CREATE OR REPLACE FUNCTION public.neo_pos_order_is_kitchen_bound(_order uuid, _org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.pos_order_items oi
     WHERE oi.order_id = _order
       AND oi.organization_id = _org
       AND oi.held = false
       AND coalesce(oi.status,'draft') NOT IN ('cancelled','voided')
  );
$$;

REVOKE ALL ON FUNCTION public.neo_pos_order_is_kitchen_bound(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_order_is_kitchen_bound(uuid, uuid) TO authenticated, service_role;

-- Trigger: an order entering a kitchen-bound lifecycle state always routes tickets.
CREATE OR REPLACE FUNCTION public.neo_pos_autoroute_tickets()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _org uuid := NEW.organization_id;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF _org IS NULL THEN RETURN NEW; END IF;
  IF coalesce(NEW.status,'draft') NOT IN ('sent','confirmed','preparing','ready','served','settled','closed','paid') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  IF NOT public.neo_pos_order_is_kitchen_bound(NEW.id, _org) THEN RETURN NEW; END IF;
  IF EXISTS (
       SELECT 1 FROM public.station_ticket_items sti
        JOIN public.pos_order_items oi ON oi.id = sti.order_item_id
       WHERE oi.order_id = NEW.id
     ) AND NOT EXISTS (
       SELECT 1 FROM public.pos_order_items oi
        WHERE oi.order_id = NEW.id
          AND oi.held = false
          AND coalesce(oi.status,'draft') NOT IN ('cancelled','voided')
          AND NOT EXISTS (SELECT 1 FROM public.station_ticket_items t
                           WHERE t.order_item_id = oi.id AND t.remake_of_id IS NULL)
     ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.neo_pos_route_tickets_internal(NEW.id, _org);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_orders_autoroute ON public.pos_orders;
CREATE TRIGGER trg_pos_orders_autoroute
AFTER INSERT OR UPDATE OF status ON public.pos_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_autoroute_tickets();

-- Trigger: items added to an already-sent order reach the kitchen too.
CREATE OR REPLACE FUNCTION public.neo_pos_autoroute_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _status text;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF NEW.held IS TRUE OR coalesce(NEW.status,'draft') IN ('cancelled','voided') THEN RETURN NEW; END IF;
  SELECT status INTO _status FROM public.pos_orders WHERE id = NEW.order_id;
  IF coalesce(_status,'draft') NOT IN ('sent','confirmed','preparing','ready','served') THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.station_ticket_items t
              WHERE t.order_item_id = NEW.id AND t.remake_of_id IS NULL) THEN
    RETURN NEW;
  END IF;
  PERFORM public.neo_pos_route_tickets_internal(NEW.order_id, NEW.organization_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_order_items_autoroute ON public.pos_order_items;
CREATE TRIGGER trg_pos_order_items_autoroute
AFTER INSERT ON public.pos_order_items
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_autoroute_item();

-- Supervisor repair action: rebuild tickets for kitchen-bound orders that never reached KDS.
CREATE OR REPLACE FUNCTION public.neo_pos_route_missing_tickets(_branch uuid DEFAULT NULL, _limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _o record; _res jsonb;
  _orders int := 0; _tickets int := 0; _items int := 0; _unassigned int := 0;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE = '42501'; END IF;
  IF NOT (public.has_permission('kitchen','queue.manage')
          OR public.has_permission('restaurant','orders.manage')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE = '42501';
  END IF;

  FOR _o IN
    SELECT o.id, o.branch_id
      FROM public.pos_orders o
     WHERE o.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND public.neo_branch_in_scope(o.branch_id)
       AND coalesce(o.status,'draft') NOT IN ('draft','held','cancelled','voided')
       AND EXISTS (SELECT 1 FROM public.pos_order_items oi
                    WHERE oi.order_id = o.id AND oi.held = false
                      AND coalesce(oi.status,'draft') NOT IN ('cancelled','voided')
                      AND NOT EXISTS (SELECT 1 FROM public.station_ticket_items t
                                       WHERE t.order_item_id = oi.id AND t.remake_of_id IS NULL))
     ORDER BY o.created_at
     LIMIT greatest(coalesce(_limit,200), 1)
  LOOP
    _res := public.neo_pos_route_tickets_internal(_o.id, _org);
    _orders := _orders + 1;
    _tickets := _tickets + coalesce((_res->>'tickets_created')::int, 0);
    _items := _items + coalesce((_res->>'items_created')::int, 0);
    _unassigned := _unassigned + coalesce((_res->>'unassigned_station')::int, 0);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'orders_routed', _orders, 'tickets_created', _tickets,
                            'items_created', _items, 'unassigned_station', _unassigned);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_pos_route_missing_tickets(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_route_missing_tickets(uuid, int) TO authenticated, service_role;

-- ============================================================
-- B. Laundry : guest garments separated from hotel linen stock
-- ============================================================

ALTER TABLE public.laundry_batch_items
  ADD COLUMN IF NOT EXISTS item_kind text NOT NULL DEFAULT 'linen',
  ADD COLUMN IF NOT EXISTS guest_laundry_item_id uuid REFERENCES public.guest_laundry_items(id) ON DELETE SET NULL;

UPDATE public.laundry_batch_items i
   SET item_kind = 'guest'
  FROM public.laundry_batches b
 WHERE b.id = i.batch_id
   AND coalesce(b.batch_kind,'linen') = 'guest'
   AND i.item_kind <> 'guest';

ALTER TABLE public.laundry_batch_items
  DROP CONSTRAINT IF EXISTS laundry_batch_items_kind_shape;
ALTER TABLE public.laundry_batch_items
  ADD CONSTRAINT laundry_batch_items_kind_shape CHECK (
    (item_kind = 'guest' AND linen_item_id IS NULL AND coalesce(description,'') <> '')
    OR (item_kind <> 'guest' AND guest_laundry_item_id IS NULL)
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public.neo_laundry_batch_create(
  _branch uuid DEFAULT NULL, _kind text DEFAULT 'linen', _items jsonb DEFAULT '[]'::jsonb,
  _source_department uuid DEFAULT NULL, _guest_order uuid DEFAULT NULL, _notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_batch uuid;
  v_number text;
  v_line jsonb;
  v_count int := 0;
  v_kind text := COALESCE(NULLIF(_kind,''), 'linen');
  v_guest boolean;
  v_linen uuid;
  v_desc text;
BEGIN
  IF NOT (has_exact_permission('laundry','batches','create')
          OR has_exact_permission('laundry','batches','edit')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to receive items into Laundry';
  END IF;
  IF _branch IS NULL THEN RAISE EXCEPTION 'Select a property before receiving a handover'; END IF;
  IF NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE = '42501';
  END IF;
  IF jsonb_array_length(COALESCE(_items,'[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Record at least one item on the handover';
  END IF;

  v_guest := (v_kind = 'guest');

  IF v_guest AND _guest_order IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM guest_laundry_orders g
                    WHERE g.id = _guest_order AND g.organization_id = v_org
                      AND (g.branch_id IS NULL OR g.branch_id = _branch)) THEN
      RAISE EXCEPTION 'That guest laundry order does not belong to this property';
    END IF;
  END IF;
  IF NOT v_guest AND _guest_order IS NOT NULL THEN
    RAISE EXCEPTION 'Only guest laundry batches can be linked to a guest laundry order';
  END IF;

  v_number := 'LB-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 5));

  INSERT INTO laundry_batches (
    organization_id, branch_id, batch_number, source_department_id, batch_kind,
    guest_order_id, status, received_at, notes, created_by
  ) VALUES (
    v_org, _branch, v_number, _source_department, v_kind,
    _guest_order, 'received', now(), _notes, auth.uid()
  ) RETURNING id INTO v_batch;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_items) LOOP
    IF COALESCE((v_line->>'quantity')::numeric, 0) <= 0 THEN CONTINUE; END IF;
    v_linen := NULLIF(v_line->>'linen_item_id','')::uuid;
    v_desc := NULLIF(v_line->>'description','');

    IF v_guest THEN
      IF v_desc IS NULL THEN
        RAISE EXCEPTION 'Describe each guest garment on the handover';
      END IF;
      INSERT INTO laundry_batch_items (
        organization_id, batch_id, item_kind, linen_item_id, guest_laundry_item_id, description, quantity)
      VALUES (v_org, v_batch, 'guest', NULL,
        NULLIF(v_line->>'guest_laundry_item_id','')::uuid, v_desc,
        (v_line->>'quantity')::numeric);
    ELSE
      IF v_linen IS NULL THEN
        RAISE EXCEPTION 'Choose the linen item for every line on a hotel linen handover';
      END IF;
      INSERT INTO laundry_batch_items (
        organization_id, batch_id, item_kind, linen_item_id, description, quantity)
      VALUES (v_org, v_batch, v_kind, v_linen, v_desc, (v_line->>'quantity')::numeric);

      INSERT INTO linen_movements (
        organization_id, branch_id, linen_item_id, from_state, to_state,
        from_department_id, to_department_id, batch_id, quantity, performed_by
      ) VALUES (
        v_org, _branch, v_linen, 'soiled', 'in-laundry',
        _source_department, NULL, v_batch, (v_line->>'quantity')::numeric, auth.uid()
      );
    END IF;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('id', v_batch, 'batch_number', v_number, 'lines', v_count, 'kind', v_kind);
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_laundry_batch_return(_batch uuid DEFAULT NULL, _lines jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  b record; l jsonb; li record;
  v_returned numeric; v_damaged numeric; v_missing numeric;
  v_incidents int := 0; v_guest_notes text := '';
BEGIN
  SELECT * INTO b FROM laundry_batches WHERE id = _batch AND organization_id = v_org FOR UPDATE;
  IF b IS NULL THEN RAISE EXCEPTION 'Unknown laundry batch'; END IF;
  IF NOT (has_exact_permission('laundry','batches','edit')
          OR is_org_admin()
          OR (b.attendant_id = auth.uid() AND has_exact_permission('laundry','my-work','edit'))) THEN
    RAISE EXCEPTION 'Not permitted to hand this batch back';
  END IF;

  FOR l IN SELECT * FROM jsonb_array_elements(COALESCE(_lines,'[]'::jsonb)) LOOP
    SELECT * INTO li FROM laundry_batch_items
      WHERE id = (l->>'id')::uuid AND batch_id = _batch AND organization_id = v_org FOR UPDATE;
    CONTINUE WHEN li IS NULL;

    v_returned := COALESCE((l->>'returned_quantity')::numeric, li.quantity);
    v_damaged := COALESCE((l->>'damaged_quantity')::numeric, 0);
    v_missing := GREATEST(li.quantity - v_returned - v_damaged, 0);

    IF v_returned + v_damaged > li.quantity THEN
      RAISE EXCEPTION 'More items returned than were handed over on this line';
    END IF;

    UPDATE laundry_batch_items
       SET returned_quantity = v_returned,
           damaged_quantity = v_damaged,
           missing_quantity = v_missing
     WHERE id = li.id;

    IF li.item_kind = 'guest' OR li.linen_item_id IS NULL THEN
      -- Guest garments never touch hotel linen stock; discrepancies belong to the guest order.
      IF li.guest_laundry_item_id IS NOT NULL THEN
        UPDATE guest_laundry_items
           SET counted_quantity = v_returned,
               condition_notes = COALESCE(NULLIF(l->>'notes',''), condition_notes)
         WHERE id = li.guest_laundry_item_id AND organization_id = v_org;
      END IF;
      IF (v_damaged + v_missing) > 0 THEN
        v_guest_notes := v_guest_notes || COALESCE(li.description,'Garment')
          || ': ' || v_damaged::text || ' damaged, ' || v_missing::text || ' missing. ';
        v_incidents := v_incidents + 1;
      END IF;
      CONTINUE;
    END IF;

    INSERT INTO linen_movements (
      organization_id, branch_id, linen_item_id, from_state, to_state,
      from_department_id, to_department_id, batch_id, quantity, received_quantity,
      discrepancy, performed_by, confirmed_by, confirmed_at
    ) VALUES (
      v_org, b.branch_id, li.linen_item_id, 'in-laundry', 'clean',
      NULL, b.source_department_id, _batch, li.quantity, v_returned,
      (v_damaged + v_missing) > 0, auth.uid(), auth.uid(), now()
    );

    IF v_damaged > 0 THEN
      INSERT INTO linen_incidents (
        organization_id, branch_id, linen_item_id, quantity, department_id,
        reason, condition, responsible_process, reported_by, status
      ) VALUES (
        v_org, b.branch_id, li.linen_item_id, v_damaged, b.source_department_id,
        COALESCE(l->>'notes','Damaged during laundry processing'), 'damaged', 'laundry', auth.uid(), 'reported'
      );
      v_incidents := v_incidents + 1;
    END IF;

    IF v_missing > 0 THEN
      INSERT INTO linen_incidents (
        organization_id, branch_id, linen_item_id, quantity, department_id,
        reason, condition, responsible_process, reported_by, status
      ) VALUES (
        v_org, b.branch_id, li.linen_item_id, v_missing, b.source_department_id,
        COALESCE(l->>'notes','Not returned from laundry'), 'missing', 'laundry', auth.uid(), 'reported'
      );
      v_incidents := v_incidents + 1;
    END IF;
  END LOOP;

  IF v_guest_notes <> '' AND b.guest_order_id IS NOT NULL THEN
    UPDATE guest_laundry_orders
       SET discrepancy_notes = concat_ws(' ', NULLIF(discrepancy_notes,''), v_guest_notes)
     WHERE id = b.guest_order_id AND organization_id = v_org;
  END IF;

  UPDATE laundry_batches
     SET status = 'completed', completed_at = now()
   WHERE id = _batch;

  RETURN jsonb_build_object('ok', true, 'incidents', v_incidents);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_laundry_batch_create(uuid, text, jsonb, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_laundry_batch_create(uuid, text, jsonb, uuid, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_laundry_batch_return(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_laundry_batch_return(uuid, jsonb) TO authenticated, service_role;