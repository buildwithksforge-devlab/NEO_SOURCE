-- ============================================================
-- 1. STOCK COUNT INTEGRITY
-- ============================================================

-- A physical count is what is on the shelf: it cannot be negative, and the
-- variance is always derived from the saved line rather than trusted from the
-- caller. Historic rows are left exactly as they are.
CREATE OR REPLACE FUNCTION public.neo_stock_take_line_validate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.counted_quantity IS NOT NULL AND NEW.counted_quantity < 0 THEN
    RAISE EXCEPTION 'count_negative: a physical count cannot be negative (%).', NEW.counted_quantity
      USING HINT = 'Enter the quantity actually on the shelf. A negative system balance is a ledger problem, not a count.';
  END IF;

  IF NEW.counted_quantity IS NULL THEN
    NEW.variance := NULL;
  ELSE
    NEW.variance := NEW.counted_quantity - COALESCE(NEW.system_quantity, 0);
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_stock_take_line_validate ON public.stock_take_lines;
CREATE TRIGGER trg_stock_take_line_validate
BEFORE INSERT OR UPDATE ON public.stock_take_lines
FOR EACH ROW EXECUTE FUNCTION public.neo_stock_take_line_validate();

-- One open count per store. A double-tap on "Open count" therefore fails
-- loudly instead of freezing a second, competing snapshot.
CREATE OR REPLACE FUNCTION public.neo_stock_take_single_open()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE v_open text;
BEGIN
  IF NEW.status <> 'in-progress' OR NEW.location_id IS NULL THEN RETURN NEW; END IF;

  SELECT reference INTO v_open
    FROM public.stock_takes
   WHERE organization_id = NEW.organization_id
     AND location_id = NEW.location_id
     AND status = 'in-progress'
     AND id <> NEW.id
   LIMIT 1;

  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'count_already_open: count % is still open for this store.', v_open
      USING HINT = 'Finish or abandon the open count before starting another one.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_stock_take_single_open ON public.stock_takes;
CREATE TRIGGER trg_stock_take_single_open
BEFORE INSERT OR UPDATE OF status, location_id ON public.stock_takes
FOR EACH ROW EXECUTE FUNCTION public.neo_stock_take_single_open();

-- Closing refuses an invalid line, recalculates every variance from the saved
-- lines, and refuses a "no variance" close that is really an uncounted count.
CREATE OR REPLACE FUNCTION public.neo_stores_count_submit_variance(_take uuid, _notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  IF s.status IN ('closed','awaiting-approval') THEN
    RETURN jsonb_build_object('status', s.status, 'adjustment', NULL);
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
END $$;

-- ============================================================
-- 2. EVENTS: CLOSE-OUT AND OVERDUE VISIBILITY
-- ============================================================

-- An event cannot be worked as live until the banquet order the departments
-- read from has actually been published.
CREATE OR REPLACE FUNCTION public.neo_event_requires_published_beo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'in-progress' AND COALESCE(OLD.status, '') <> 'in-progress' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.banquet_event_orders o
       WHERE o.booking_id = NEW.id AND o.status = 'published'
    ) THEN
      RAISE EXCEPTION 'beo_not_published: event % has no published banquet order.', NEW.event_reference
        USING HINT = 'Raise and publish the banquet event order so the departments have their instructions.';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_event_requires_published_beo ON public.event_bookings;
CREATE TRIGGER trg_event_requires_published_beo
BEFORE UPDATE OF status ON public.event_bookings
FOR EACH ROW EXECUTE FUNCTION public.neo_event_requires_published_beo();

-- Deliberate end state for an event: completed, a no-show, or cancelled.
-- Open department handoffs are closed with the event, the reason is recorded,
-- and any outstanding balance is reported rather than silently written off.
CREATE OR REPLACE FUNCTION public.neo_event_close_out(_booking uuid, _outcome text, _reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  b record;
  v_status text;
  v_billed numeric := 0;
  v_paid numeric := 0;
  v_reqs int := 0;
BEGIN
  IF NOT (has_permission('events','bookings.edit') OR has_permission('events','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to close out events';
  END IF;

  v_status := CASE lower(COALESCE(_outcome, ''))
                WHEN 'completed' THEN 'completed'
                WHEN 'no-show'   THEN 'cancelled'
                WHEN 'cancelled' THEN 'cancelled'
                ELSE NULL END;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'invalid_outcome: choose completed, no-show or cancelled.';
  END IF;

  IF lower(COALESCE(_outcome,'')) <> 'completed' AND COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'reason_required: record why this event did not take place.';
  END IF;

  SELECT * INTO b FROM public.event_bookings
   WHERE id = _booking AND organization_id = v_org FOR UPDATE;
  IF b IS NULL THEN RAISE EXCEPTION 'Event not found'; END IF;

  IF b.status IN ('completed','closed','cancelled') THEN
    RETURN jsonb_build_object('status', b.status, 'already_closed', true);
  END IF;

  SELECT COALESCE(sum(i.line_total),0) INTO v_billed FROM public.event_billing_items i WHERE i.booking_id = _booking;
  SELECT COALESCE(sum(p.amount),0)     INTO v_paid   FROM public.event_payments p      WHERE p.booking_id = _booking;

  UPDATE public.event_department_requirements
     SET readiness = 'completed',
         blocker = NULL,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE booking_id = _booking
     AND readiness NOT IN ('completed','ready');
  GET DIAGNOSTICS v_reqs = ROW_COUNT;

  UPDATE public.banquet_event_orders
     SET status = 'cancelled', updated_at = now()
   WHERE booking_id = _booking
     AND v_status = 'cancelled'
     AND status NOT IN ('cancelled','superseded');

  UPDATE public.event_bookings
     SET status = v_status,
         internal_notes = CONCAT_WS(E'\n', internal_notes,
           'Closed out as ' || lower(_outcome) || ' on ' || to_char(now(), 'DD Mon YYYY')
           || CASE WHEN COALESCE(btrim(_reason),'') = '' THEN '' ELSE ': ' || btrim(_reason) END),
         updated_at = now()
   WHERE id = _booking;

  BEGIN
    PERFORM public.write_audit_log('events', 'event.closed-out', _booking::text, NULL,
      jsonb_build_object('outcome', lower(_outcome), 'reason', _reason,
                         'billed', v_billed, 'paid', v_paid), _reason);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'status', v_status,
    'outcome', lower(_outcome),
    'handoffs_closed', v_reqs,
    'billed', v_billed,
    'paid', v_paid,
    'outstanding', GREATEST(v_billed - v_paid, 0)
  );
END $$;

GRANT EXECUTE ON FUNCTION public.neo_event_close_out(uuid, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_event_close_out(uuid, text, text) FROM anon;

-- Chain status now states, for each event, how close the date is, whether the
-- banquet order is overdue, whether the date has passed and what is still owed.
DROP FUNCTION IF EXISTS public.neo_event_chain_status(uuid);
CREATE FUNCTION public.neo_event_chain_status(_branch uuid DEFAULT NULL::uuid)
RETURNS TABLE(booking_id uuid, event_reference text, event_name text, branch_id uuid, event_date date,
              status text, beo_id uuid, beo_number text, beo_status text,
              kitchen_handoff boolean, housekeeping_handoff boolean, front_office_handoff boolean,
              housekeeping_job boolean, billing_items integer, billed_amount numeric, paid_amount numeric,
              days_to_event integer, is_past boolean, beo_overdue boolean, outstanding numeric, missing text[])
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH scoped AS (
    SELECT b.*
      FROM public.event_bookings b
     WHERE b.organization_id = public.current_org_id()
       AND (_branch IS NULL OR b.branch_id = _branch)
       AND (public.current_access_scope() = 'all' OR b.branch_id = ANY (public.current_branch_ids()))
  ), rows AS (
    SELECT
      b.id, b.event_reference, b.event_name, b.branch_id, b.event_date, b.status,
      o.id AS beo_id, o.beo_number, o.status AS beo_status,
      EXISTS (SELECT 1 FROM public.event_department_requirements r WHERE r.booking_id = b.id AND upper(r.department_key) IN ('KITC','REST','FNB','KITCHEN')) AS kitchen_handoff,
      EXISTS (SELECT 1 FROM public.event_department_requirements r WHERE r.booking_id = b.id AND upper(r.department_key) = 'HOUS') AS housekeeping_handoff,
      EXISTS (SELECT 1 FROM public.event_department_requirements r WHERE r.booking_id = b.id AND upper(r.department_key) = 'FRON') AS front_office_handoff,
      EXISTS (SELECT 1 FROM public.housekeeping_jobs j WHERE j.source_record_id = b.id AND j.source = 'events') AS housekeeping_job,
      (SELECT count(*)::int FROM public.event_billing_items i WHERE i.booking_id = b.id) AS billing_items,
      coalesce((SELECT sum(i.line_total) FROM public.event_billing_items i WHERE i.booking_id = b.id), 0) AS billed_amount,
      coalesce((SELECT sum(p.amount) FROM public.event_payments p WHERE p.booking_id = b.id), 0) AS paid_amount
    FROM scoped b
    LEFT JOIN LATERAL (
      SELECT * FROM public.banquet_event_orders x
       WHERE x.booking_id = b.id AND x.status <> 'superseded'
       ORDER BY x.revision DESC LIMIT 1
    ) o ON true
  )
  SELECT r.id, r.event_reference, r.event_name, r.branch_id, r.event_date, r.status,
         r.beo_id, r.beo_number, r.beo_status,
         r.kitchen_handoff, r.housekeeping_handoff, r.front_office_handoff,
         r.housekeeping_job, r.billing_items, r.billed_amount, r.paid_amount,
         (r.event_date - CURRENT_DATE)::int AS days_to_event,
         (r.event_date < CURRENT_DATE) AS is_past,
         (r.status IN ('confirmed','in-planning','ready','in-progress')
           AND COALESCE(r.beo_status, '') <> 'published'
           AND (r.event_date - CURRENT_DATE) <= 3) AS beo_overdue,
         GREATEST(r.billed_amount - r.paid_amount, 0) AS outstanding,
         (ARRAY_REMOVE(ARRAY[
            CASE WHEN r.beo_id IS NULL THEN 'Banquet event order' END,
            CASE WHEN r.beo_id IS NOT NULL AND r.beo_status <> 'published' THEN 'Banquet order not published' END,
            CASE WHEN NOT r.kitchen_handoff THEN 'Kitchen handoff' END,
            CASE WHEN NOT r.housekeeping_handoff THEN 'Housekeeping handoff' END,
            CASE WHEN NOT r.front_office_handoff THEN 'Front office handoff' END,
            CASE WHEN NOT r.housekeeping_job THEN 'Venue preparation job' END,
            CASE WHEN r.billing_items = 0 THEN 'Billing' END,
            CASE WHEN r.billing_items > 0 AND r.paid_amount <= 0 THEN 'Payment' END
          ], NULL))::text[]
    FROM rows r
   ORDER BY r.event_date DESC;
$$;

GRANT EXECUTE ON FUNCTION public.neo_event_chain_status(uuid) TO authenticated;