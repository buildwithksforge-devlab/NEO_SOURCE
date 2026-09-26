-- 1. Stores queue visibility ------------------------------------------------
-- A Store Keeper works the requisitions RAISED BY other departments for their
-- property. Departmental record scope hides those rows, so the queue was empty.
-- Additive policy: same organisation, same property, and an explicit Stores
-- requisition grant. It never widens another module.
CREATE POLICY internal_requisitions_select_stores
  ON public.internal_requisitions
  FOR SELECT
  TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (branch_id IS NULL OR branch_id = ANY (public.current_branch_ids()))
    AND (
      public.has_permission('stores', 'requisitions', 'view')
      OR public.has_permission('stores', 'requisitions', 'edit')
      OR public.has_permission('stores', 'issues', 'create')
      OR public.has_permission('stores', 'view')
    )
  );

-- 2. Kitchen stock needs -----------------------------------------------------
ALTER TABLE public.department_stock_needs ALTER COLUMN status SET DEFAULT 'reported';

CREATE OR REPLACE FUNCTION public.neo_kitchen_requisition_from_needs(_needs uuid[], _required_date date DEFAULT NULL::date, _priority text DEFAULT 'normal'::text, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_lines jsonb; v_req jsonb; v_branch uuid; v_dept uuid; v_id uuid;
BEGIN
  -- Both spellings name the same authority; role templates carry either.
  IF NOT (public.has_permission('kitchen', 'requisition', 'create')
          OR public.has_permission('kitchen', 'requisitions', 'create')) THEN
    RAISE EXCEPTION 'Only the Kitchen Manager / Head Chef can send a Stores requisition for the Main Kitchen';
  END IF;
  IF _needs IS NULL OR array_length(_needs, 1) IS NULL THEN
    RAISE EXCEPTION 'Select at least one reported need';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'description', n.item, 'quantity_requested', n.quantity,
           'unit', n.unit, 'notes', n.notes)),
         min(n.branch_id), min(n.department_id)
    INTO v_lines, v_branch, v_dept
  FROM public.department_stock_needs n
  WHERE n.id = ANY(_needs)
    AND n.organization_id = current_org_id()
    AND n.module = 'kitchen'
    -- 'pending' is the historical spelling of a freshly reported need.
    AND n.status IN ('pending', 'reported', 'acknowledged');

  IF v_lines IS NULL THEN RAISE EXCEPTION 'No open kitchen needs match that selection'; END IF;

  v_req := public.neo_department_requisition_create(
    v_branch, v_lines, v_dept, _required_date,
    coalesce(nullif(btrim(_priority), ''), 'normal'),
    coalesce(nullif(btrim(_reason), ''), 'Main Kitchen consolidated requisition'),
    NULL
  );

  v_id := nullif(v_req->>'requisition_id', '')::uuid;

  UPDATE public.department_stock_needs
     SET status = 'requisitioned', reviewed_by = auth.uid(), reviewed_at = now(),
         requisition_id = v_id, updated_at = now()
   WHERE id = ANY(_needs) AND organization_id = current_org_id() AND module = 'kitchen';

  RETURN v_req;
END; $function$;

-- 3. Reservation financial state derives from deposit allocations ------------
CREATE OR REPLACE FUNCTION public.neo_reservation_financial_state_sync(_reservation uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_paid numeric; v_required numeric; v_status text;
BEGIN
  IF _reservation IS NULL THEN RETURN; END IF;

  SELECT coalesce(sum(d.amount), 0) INTO v_paid
    FROM public.reservation_deposits d
   WHERE d.reservation_id = _reservation
     AND d.status IN ('held', 'applied');

  SELECT coalesce(r.deposit_required, 0), r.status INTO v_required, v_status
    FROM public.reservations r WHERE r.id = _reservation;

  UPDATE public.reservations r
     SET deposit_paid = v_paid,
         payment_status = CASE
           WHEN v_paid <= 0 THEN 'unpaid'
           WHEN v_required > 0 AND v_paid + 0.009 >= v_required THEN 'paid'
           ELSE 'part-paid' END,
         -- A satisfied deposit clears the pre-arrival hold; every other
         -- lifecycle status (checked-in, checked-out, cancelled) is untouched.
         status = CASE
           WHEN r.status = 'pending-deposit'
                AND v_required > 0 AND v_paid + 0.009 >= v_required THEN 'confirmed'
           ELSE r.status END,
         updated_at = now()
   WHERE r.id = _reservation;
END; $$;

CREATE OR REPLACE FUNCTION public.neo_reservation_deposit_state_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.neo_reservation_financial_state_sync(
    coalesce(NEW.reservation_id, OLD.reservation_id));
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_reservation_deposit_state ON public.reservation_deposits;
CREATE TRIGGER trg_reservation_deposit_state
AFTER INSERT OR UPDATE OR DELETE ON public.reservation_deposits
FOR EACH ROW EXECUTE FUNCTION public.neo_reservation_deposit_state_trigger();

-- 4. A room may not be unsellable and sellable at once -----------------------
CREATE OR REPLACE FUNCTION public.neo_room_state_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.room_condition IN ('out-of-order', 'out-of-service', 'maintenance')
     OR NEW.status IN ('inactive', 'out-of-order', 'out-of-service') THEN
    NEW.sellable := false;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_room_state_consistency ON public.rooms;
CREATE TRIGGER trg_room_state_consistency
BEFORE INSERT OR UPDATE ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.neo_room_state_consistency();