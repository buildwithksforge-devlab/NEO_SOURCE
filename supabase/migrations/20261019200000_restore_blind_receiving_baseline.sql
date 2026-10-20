-- Receiving baseline recovered from database exports dated 2026-10-19.
-- DRAFT: validate on a disposable database before applying.
-- Preserves existing behavior; functional fixes follow separately.
-- Does not submit, approve or post any receiving count.

BEGIN;

CREATE TABLE IF NOT EXISTS public.neo_blind_receiving_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    purchase_order_id uuid NOT NULL,
    receiving_location_id uuid NOT NULL,
    supplier_delivery_note text NOT NULL,
    remarks text,
    status text DEFAULT 'submitted'::text NOT NULL,
    submitted_by uuid NOT NULL,
    submitted_at timestamptz DEFAULT now() NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamptz,
    review_notes text,
    posted_grn_id uuid,

    CONSTRAINT neo_blind_receiving_counts_pkey
        PRIMARY KEY (id),

    CONSTRAINT blind_receiving_delivery_note_required
        CHECK (length(btrim(supplier_delivery_note)) > 0),

    CONSTRAINT neo_blind_receiving_counts_status_check
        CHECK (
            status IN (
                'submitted',
                'under_review',
                'approved',
                'rejected',
                'posted'
            )
        ),

    CONSTRAINT neo_blind_receiving_counts_purchase_order_id_fkey
        FOREIGN KEY (purchase_order_id)
        REFERENCES public.purchase_orders(id),

    CONSTRAINT neo_blind_receiving_counts_receiving_location_id_fkey
        FOREIGN KEY (receiving_location_id)
        REFERENCES public.stock_locations(id),

    CONSTRAINT neo_blind_receiving_counts_posted_grn_id_fkey
        FOREIGN KEY (posted_grn_id)
        REFERENCES public.goods_receipts(id)
);

CREATE TABLE IF NOT EXISTS public.neo_blind_receiving_count_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    count_id uuid NOT NULL,
    purchase_order_line_id uuid NOT NULL,
    quantity_delivered numeric NOT NULL,
    quantity_rejected numeric DEFAULT 0 NOT NULL,
    rejection_reason text,
    batch_number text,
    expiry_date date,

    CONSTRAINT neo_blind_receiving_count_lines_pkey
        PRIMARY KEY (id),

    CONSTRAINT blind_receiving_unique_line
        UNIQUE (count_id, purchase_order_line_id),

    CONSTRAINT blind_receiving_valid_split
        CHECK (quantity_rejected <= quantity_delivered),

    CONSTRAINT neo_blind_receiving_count_lines_quantity_delivered_check
        CHECK (quantity_delivered >= 0),

    CONSTRAINT neo_blind_receiving_count_lines_quantity_rejected_check
        CHECK (quantity_rejected >= 0),

    CONSTRAINT neo_blind_receiving_count_lines_count_id_fkey
        FOREIGN KEY (count_id)
        REFERENCES public.neo_blind_receiving_counts(id)
        ON DELETE RESTRICT,

    CONSTRAINT neo_blind_receiving_count_lines_purchase_order_line_id_fkey
        FOREIGN KEY (purchase_order_line_id)
        REFERENCES public.purchase_order_lines(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS neo_blind_receiving_unique_delivery
    ON public.neo_blind_receiving_counts (
        organization_id,
        purchase_order_id,
        lower(btrim(supplier_delivery_note))
    );

CREATE INDEX IF NOT EXISTS idx_blind_counts_organization_branch
    ON public.neo_blind_receiving_counts (
        organization_id,
        branch_id,
        status
    );

CREATE INDEX IF NOT EXISTS idx_blind_counts_purchase_order
    ON public.neo_blind_receiving_counts (purchase_order_id);

CREATE UNIQUE INDEX IF NOT EXISTS neo_blind_receiving_unique_posted_grn
    ON public.neo_blind_receiving_counts (posted_grn_id)
    WHERE posted_grn_id IS NOT NULL;

ALTER TABLE public.neo_blind_receiving_counts
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.neo_blind_receiving_count_lines
    ENABLE ROW LEVEL SECURITY;

-- Preserve the exported RPC-only access for ordinary clients.
REVOKE ALL ON TABLE
    public.neo_blind_receiving_counts,
    public.neo_blind_receiving_count_lines
FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE
    public.neo_blind_receiving_counts,
    public.neo_blind_receiving_count_lines
TO service_role;

-- Preserve this environment-specific grant only if the role exists.
DO $role_grants$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec'
    ) THEN
        GRANT SELECT, INSERT ON TABLE
            public.neo_blind_receiving_counts,
            public.neo_blind_receiving_count_lines
        TO sandbox_exec;
    END IF;
END
$role_grants$;


CREATE OR REPLACE FUNCTION public.neo_stores_receive_goods(
  _order uuid, _location uuid, _lines jsonb, _attempt uuid, _notes text DEFAULT NULL,
  _over_receipt_reason text DEFAULT NULL, _delivery_note text DEFAULT NULL, _supplier_invoice text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id(); _p record; _line jsonb; _pl record;
        _grn uuid; _number text; _prior jsonb; _count integer := 0;
        _qty numeric; _outstanding numeric; _lreason text; _post jsonb; _partial boolean := false;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;

  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='goods.receive' AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;

  IF NOT (public.has_permission('procurement','receiving.manage')
          OR public.has_permission('procurement','receiving.create')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _p FROM public.purchase_orders WHERE id=_order AND organization_id=_org;
  IF _p IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF _p.status NOT IN ('approved','pending-delivery','sent','partially-received','partially_received') THEN
    RAISE EXCEPTION 'order_not_receivable' USING ERRCODE='22023';
  END IF;
  IF _location IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.stock_locations sl WHERE sl.id=_location AND sl.organization_id=_org AND sl.active) THEN
    RAISE EXCEPTION 'store_location_required' USING ERRCODE='22023';
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('grn:'||_order::text, 7));

  _number := public.next_document_number('goods_receipt','GRN', _p.branch_id);
  INSERT INTO public.goods_receipts (organization_id, branch_id, order_id, supplier_id, location_id,
    grn_number, status, received_at, received_by, notes, delivery_note_number, supplier_invoice_number)
  VALUES (_org, _p.branch_id, _order, _p.supplier_id, _location, _number, 'received', now(), auth.uid(),
          _notes, nullif(btrim(coalesce(_delivery_note,'')),''), nullif(btrim(coalesce(_supplier_invoice,'')),''))
  RETURNING id INTO _grn;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO _pl FROM public.purchase_order_lines
     WHERE id = (_line->>'order_line_id')::uuid AND order_id = _order;
    IF _pl IS NULL THEN RAISE EXCEPTION 'order_line_not_on_order' USING ERRCODE='22023'; END IF;

    _qty := COALESCE((_line->>'quantity_received')::numeric, 0);
    IF _qty <= 0 THEN CONTINUE; END IF;

    _lreason := nullif(btrim(coalesce(_line->>'over_receipt_reason', _over_receipt_reason, '')), '');

    _outstanding := COALESCE(_pl.quantity,0) - COALESCE(_pl.cancelled_quantity,0) - COALESCE(_pl.received_quantity,0);
    IF _qty > _outstanding + 0.0001 THEN
      RAISE EXCEPTION 'over_receipt_refused: % outstanding on this line, % offered', _outstanding, _qty
        USING ERRCODE='23514';
    END IF;

    INSERT INTO public.goods_receipt_lines (organization_id, receipt_id, order_line_id, stock_item_id,
      quantity_ordered, quantity_previously_received, quantity_received, quantity_rejected, quantity_damaged,
      quantity_accepted, unit, unit_price, batch_number, expiry_date, location_id, notes,
      rejection_reason, over_receipt_reason)
    VALUES (_org, _grn, _pl.id, _pl.stock_item_id, _pl.quantity, COALESCE(_pl.received_quantity,0), _qty,
      COALESCE((_line->>'quantity_rejected')::numeric,0), COALESCE((_line->>'quantity_damaged')::numeric,0),
      GREATEST(_qty - COALESCE((_line->>'quantity_rejected')::numeric,0)
                    - COALESCE((_line->>'quantity_damaged')::numeric,0), 0),
      COALESCE(_line->>'unit', _pl.unit), _pl.unit_price,
      nullif(_line->>'batch_number',''), (nullif(_line->>'expiry_date',''))::date,
      COALESCE((nullif(_line->>'location_id',''))::uuid, _location), nullif(_line->>'notes',''),
      nullif(btrim(coalesce(_line->>'rejection_reason','')),''),
      CASE WHEN _qty > _outstanding + 0.0001 THEN _lreason ELSE NULL END);
    _count := _count + 1;
  END LOOP;

  IF _count = 0 THEN RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE='22023'; END IF;

  _post := public.inventory_post_receipt(_grn);

  SELECT EXISTS (
    SELECT 1 FROM public.purchase_order_lines pl
     WHERE pl.order_id=_order
       AND COALESCE(pl.accepted_quantity,0) + COALESCE(pl.cancelled_quantity,0) < pl.quantity
  ) INTO _partial;
  UPDATE public.goods_receipts SET is_partial=_partial WHERE id=_grn;

  _prior := jsonb_build_object('ok',true,'receipt_id',_grn,'grn_number',_number,
              'lines',_count,'posting',_post,'partial',_partial,
              'order_status',(SELECT status FROM public.purchase_orders WHERE id=_order));
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'goods.receive',_attempt,_grn,_prior);
  RETURN _prior;
END $$;

CREATE OR REPLACE FUNCTION public.neo_blind_receiving_orders()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid;
    v_result jsonb;
BEGIN
    -- Identify the authenticated user's organization.
    v_org := public.current_org_id();

    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    -- Only authorized receiving personnel may access this endpoint.
    IF NOT (
        public.has_permission('procurement', 'receiving.create')
        OR public.has_permission('procurement', 'receiving.manage')
        OR public.is_org_admin()
    ) THEN
        RAISE EXCEPTION 'Not authorized to access blind receiving'
            USING ERRCODE = '42501';
    END IF;

    -- Return only information needed to identify and count a delivery.
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', po.id,
                'order_number', po.order_number,
                'supplier_name', s.name,
                'branch_id', po.branch_id,
                'deliver_to_location_id', po.deliver_to_location_id,
                'items', (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'id', pol.id,
                                'stock_item_id', pol.stock_item_id,
                                'name', COALESCE(
                                    si.name,
                                    pol.description,
                                    'Unidentified item'
                                ),
                                'unit', pol.unit
                            )
                            ORDER BY pol.id
                        ),
                        '[]'::jsonb
                    )
                    FROM public.purchase_order_lines pol
                    LEFT JOIN public.stock_items si
                        ON si.id = pol.stock_item_id
                       AND si.organization_id = v_org
                    WHERE pol.order_id = po.id
                )
            )
            ORDER BY po.created_at DESC
        ),
        '[]'::jsonb
    )
    INTO v_result
    FROM public.purchase_orders po
    LEFT JOIN public.suppliers s
        ON s.id = po.supplier_id
       AND s.organization_id = v_org
    WHERE po.organization_id = v_org
      AND public.neo_branch_in_scope(po.branch_id)
      AND po.status IN (
          'approved',
          'pending-delivery',
          'sent',
          'partially-received',
          'partially_received'
      )
      AND EXISTS (
          SELECT 1
          FROM public.purchase_order_lines pol
          WHERE pol.order_id = po.id
            AND COALESCE(pol.quantity, 0)
                - COALESCE(pol.cancelled_quantity, 0)
                - COALESCE(pol.received_quantity, 0) > 0
      );

    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_submit_blind_receiving_count(_order uuid, _location uuid, _delivery_note text, _lines jsonb, _remarks text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_po record;
    v_count uuid;
    v_line jsonb;
    v_po_line record;
    v_qty numeric;
    v_rejected numeric;
    v_saved integer := 0;
    v_note text := NULLIF(btrim(_delivery_note), '');
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT (
        public.has_permission('procurement', 'receiving.create')
        OR public.has_permission('procurement', 'receiving.manage')
        OR public.is_org_admin()
    ) THEN
        RAISE EXCEPTION 'Not permitted to submit blind receiving count'
            USING ERRCODE = '42501';
    END IF;

    IF v_note IS NULL THEN
        RAISE EXCEPTION 'Supplier delivery note number is required'
            USING ERRCODE = '22023';
    END IF;

    IF _lines IS NULL
       OR jsonb_typeof(_lines) <> 'array'
       OR jsonb_array_length(_lines) = 0 THEN
        RAISE EXCEPTION 'At least one receiving line is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_po
    FROM public.purchase_orders
    WHERE id = _order
      AND organization_id = v_org;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Purchase order not found'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.neo_branch_in_scope(v_po.branch_id) THEN
        RAISE EXCEPTION 'Purchase order is outside authorized branch'
            USING ERRCODE = '42501';
    END IF;

    IF v_po.status NOT IN (
        'approved',
        'pending-delivery',
        'sent',
        'partially-received',
        'partially_received'
    ) THEN
        RAISE EXCEPTION 'Purchase order is not available for receiving'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.stock_locations sl
        WHERE sl.id = _location
          AND sl.organization_id = v_org
          AND sl.active = true
          AND (
              sl.branch_id = v_po.branch_id
              OR sl.branch_id IS NULL
          )
    ) THEN
        RAISE EXCEPTION 'Receiving store is invalid for this purchase order'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.neo_blind_receiving_counts c
        WHERE c.organization_id = v_org
          AND c.purchase_order_id = _order
          AND lower(btrim(c.supplier_delivery_note)) = lower(v_note)
    ) THEN
        RAISE EXCEPTION 'This supplier delivery note has already been recorded against the purchase order'
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.neo_blind_receiving_counts (
        organization_id,
        branch_id,
        purchase_order_id,
        receiving_location_id,
        supplier_delivery_note,
        remarks,
        submitted_by
    )
    VALUES (
        v_org,
        v_po.branch_id,
        _order,
        _location,
        v_note,
        _remarks,
        auth.uid()
    )
    RETURNING id INTO v_count;

    FOR v_line IN
        SELECT value FROM jsonb_array_elements(_lines)
    LOOP
        SELECT *
        INTO v_po_line
        FROM public.purchase_order_lines
        WHERE id = (v_line->>'order_line_id')::uuid
          AND order_id = _order
          AND organization_id = v_org;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'An item does not belong to this purchase order'
                USING ERRCODE = '22023';
        END IF;

        v_qty := COALESCE((v_line->>'quantity_delivered')::numeric, 0);
        v_rejected := COALESCE((v_line->>'quantity_rejected')::numeric, 0);

        IF v_qty < 0
           OR v_rejected < 0
           OR v_rejected > v_qty THEN
            RAISE EXCEPTION 'Invalid delivered/rejected quantity'
                USING ERRCODE = '22023';
        END IF;

        IF v_rejected > 0
           AND NULLIF(btrim(v_line->>'rejection_reason'), '') IS NULL THEN
            RAISE EXCEPTION 'A rejection reason is required'
                USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.neo_blind_receiving_count_lines (
            count_id,
            purchase_order_line_id,
            quantity_delivered,
            quantity_rejected,
            rejection_reason,
            batch_number,
            expiry_date
        )
        VALUES (
            v_count,
            v_po_line.id,
            v_qty,
            v_rejected,
            NULLIF(btrim(v_line->>'rejection_reason'), ''),
            NULLIF(btrim(v_line->>'batch_number'), ''),
            NULLIF(v_line->>'expiry_date', '')::date
        );

        v_saved := v_saved + 1;
    END LOOP;

    IF v_saved = 0 THEN
        RAISE EXCEPTION 'No receiving lines were submitted'
            USING ERRCODE = '22023';
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'count_id', v_count,
        'status', 'submitted',
        'lines_saved', v_saved,
        'stock_posted', false,
        'finance_posted', false
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_blind_receiving_review_queue()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_result jsonb;
BEGIN

    -------------------------------------------------------
    -- AUTHENTICATION
    -------------------------------------------------------

    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION
            'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    -------------------------------------------------------
    -- INDEPENDENT REVIEW ACCESS
    --
    -- Intentionally restricted to organization admins
    -- until Procurement reviewer permissions are verified.
    -------------------------------------------------------

    IF NOT public.is_org_admin() THEN
        RAISE EXCEPTION
            'Independent receiving review requires administrator authorization'
            USING ERRCODE = '42501';
    END IF;

    -------------------------------------------------------
    -- REVIEW QUEUE
    -------------------------------------------------------

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'count_id', c.id,
                'purchase_order_id', c.purchase_order_id,
                'order_number', po.order_number,
                'branch_id', c.branch_id,
                'delivery_note', c.supplier_delivery_note,
                'submitted_by', c.submitted_by,
                'submitted_at', c.submitted_at,
                'status', c.status,
                'remarks', c.remarks,
                'lines', (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'count_line_id', cl.id,
                                'order_line_id', pl.id,

                                'ordered_quantity',
                                    pl.quantity,

                                'previously_received',
                                    COALESCE(
                                        pl.received_quantity, 0
                                    ),

                                'cancelled_quantity',
                                    COALESCE(
                                        pl.cancelled_quantity, 0
                                    ),

                                'outstanding_quantity',
                                    GREATEST(
                                        COALESCE(pl.quantity, 0)
                                        - COALESCE(
                                            pl.received_quantity, 0
                                          )
                                        - COALESCE(
                                            pl.cancelled_quantity, 0
                                          ),
                                        0
                                    ),

                                'physically_delivered',
                                    cl.quantity_delivered,

                                'rejected_quantity',
                                    cl.quantity_rejected,

                                'accepted_quantity',
                                    (
                                        cl.quantity_delivered
                                        - cl.quantity_rejected
                                    ),

                                'difference',
                                    (
                                        cl.quantity_delivered
                                        - cl.quantity_rejected
                                    )
                                    -
                                    GREATEST(
                                        COALESCE(pl.quantity, 0)
                                        - COALESCE(
                                            pl.received_quantity, 0
                                          )
                                        - COALESCE(
                                            pl.cancelled_quantity, 0
                                          ),
                                        0
                                    ),

                                'rejection_reason',
                                    cl.rejection_reason,

                                'batch_number',
                                    cl.batch_number,

                                'expiry_date',
                                    cl.expiry_date,

                                'reconciliation_result',
                                    CASE
                                        WHEN (
                                            cl.quantity_delivered
                                            - cl.quantity_rejected
                                        ) >
                                        GREATEST(
                                            COALESCE(pl.quantity, 0)
                                            - COALESCE(
                                                pl.received_quantity, 0
                                              )
                                            - COALESCE(
                                                pl.cancelled_quantity, 0
                                              ),
                                            0
                                        )
                                        THEN 'excess'

                                        WHEN (
                                            cl.quantity_delivered
                                            - cl.quantity_rejected
                                        ) <
                                        GREATEST(
                                            COALESCE(pl.quantity, 0)
                                            - COALESCE(
                                                pl.received_quantity, 0
                                              )
                                            - COALESCE(
                                                pl.cancelled_quantity, 0
                                              ),
                                            0
                                        )
                                        THEN 'partial_delivery'

                                        ELSE 'matched'
                                    END
                            )
                            ORDER BY cl.id
                        ),
                        '[]'::jsonb
                    )
                    FROM public.neo_blind_receiving_count_lines cl
                    JOIN public.purchase_order_lines pl
                      ON pl.id = cl.purchase_order_line_id
                     AND pl.order_id = c.purchase_order_id
                    WHERE cl.count_id = c.id
                )
            )
            ORDER BY c.submitted_at
        ),
        '[]'::jsonb
    )
    INTO v_result

    FROM public.neo_blind_receiving_counts c

    JOIN public.purchase_orders po
      ON po.id = c.purchase_order_id
     AND po.organization_id = v_org
     AND po.branch_id = c.branch_id

    WHERE c.organization_id = v_org

      AND c.status IN (
          'submitted',
          'under_review'
      )

      AND public.neo_branch_in_scope(c.branch_id)

      -- The person who counted cannot review their own count.
      AND c.submitted_by <> auth.uid();

    RETURN v_result;

END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_blind_receiving_decide(_count_id uuid, _decision text, _notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_count record;
    v_excess integer;
    v_lines integer;
    v_decision text := lower(btrim(_decision));
    v_notes text := NULLIF(btrim(_notes), '');
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_org_admin() THEN
        RAISE EXCEPTION 'Independent review authorization required'
            USING ERRCODE = '42501';
    END IF;

    IF v_decision NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Decision must be approved or rejected'
            USING ERRCODE = '22023';
    END IF;

    IF v_notes IS NULL THEN
        RAISE EXCEPTION 'A review reason is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT c.*
    INTO v_count
    FROM public.neo_blind_receiving_counts c
    WHERE c.id = _count_id
      AND c.organization_id = v_org
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Blind receiving count not found'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.neo_branch_in_scope(v_count.branch_id) THEN
        RAISE EXCEPTION 'Count is outside authorized branch'
            USING ERRCODE = '42501';
    END IF;

    IF v_count.submitted_by = auth.uid() THEN
        RAISE EXCEPTION 'You cannot review your own receiving count'
            USING ERRCODE = '42501';
    END IF;

    IF v_count.status NOT IN ('submitted', 'under_review') THEN
        RAISE EXCEPTION 'This count has already been decided'
            USING ERRCODE = '22023';
    END IF;

    SELECT
        count(*),
        count(*) FILTER (
            WHERE
                cl.quantity_delivered - cl.quantity_rejected
                >
                GREATEST(
                    COALESCE(pl.quantity, 0)
                    - COALESCE(pl.received_quantity, 0)
                    - COALESCE(pl.cancelled_quantity, 0),
                    0
                )
        )
    INTO v_lines, v_excess
    FROM public.neo_blind_receiving_count_lines cl
    JOIN public.purchase_order_lines pl
      ON pl.id = cl.purchase_order_line_id
     AND pl.order_id = v_count.purchase_order_id
    WHERE cl.count_id = _count_id;

    IF v_lines = 0 THEN
        RAISE EXCEPTION 'Cannot review a count without lines'
            USING ERRCODE = '22023';
    END IF;

    IF v_decision = 'approved' AND v_excess > 0 THEN
        RAISE EXCEPTION
            'Excess quantities require a separate exception authorization; approval blocked'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.neo_blind_receiving_counts
    SET
        status = v_decision,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = v_notes
    WHERE id = _count_id;

    RETURN jsonb_build_object(
        'ok', true,
        'count_id', _count_id,
        'status', v_decision,
        'reviewed_by', auth.uid(),
        'stock_posted', false,
        'finance_posted', false
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_blind_receiving_approved_queue()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_org_admin() THEN
        RAISE EXCEPTION 'Authorized inventory posting access required'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'count_id', c.id,
                'order_number', po.order_number,
                'delivery_note', c.supplier_delivery_note,
                'submitted_at', c.submitted_at,
                'reviewed_at', c.reviewed_at,
                'review_notes', c.review_notes,
                'status', c.status,
                'line_count', (
                    SELECT count(*)
                    FROM public.neo_blind_receiving_count_lines cl
                    WHERE cl.count_id = c.id
                )
            )
            ORDER BY c.reviewed_at
        ),
        '[]'::jsonb
    )
    INTO v_result
    FROM public.neo_blind_receiving_counts c
    JOIN public.purchase_orders po
      ON po.id = c.purchase_order_id
     AND po.organization_id = v_org
     AND po.branch_id = c.branch_id
    WHERE c.organization_id = v_org
      AND c.status = 'approved'
      AND c.posted_grn_id IS NULL
      AND public.neo_branch_in_scope(c.branch_id)
      AND c.submitted_by <> auth.uid();

    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_post_approved_blind_receiving(_count_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_count record;
    v_po record;
    v_line record;
    v_lines jsonb := '[]'::jsonb;
    v_result jsonb;
    v_grn_id uuid;
    v_outstanding numeric;
    v_accepted numeric;
    v_line_count integer := 0;
BEGIN

    -------------------------------------------------------
    -- AUTHENTICATION AND AUTHORIZATION
    -------------------------------------------------------

    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION
            'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    -- Initially restricted to organization administrators.
    -- Dedicated inventory-posting permissions come later.

    IF NOT public.is_org_admin() THEN
        RAISE EXCEPTION
            'Authorized inventory posting required'
            USING ERRCODE = '42501';
    END IF;

    -------------------------------------------------------
    -- LOCK THE BLIND COUNT
    -------------------------------------------------------

    SELECT *
    INTO v_count
    FROM public.neo_blind_receiving_counts
    WHERE id = _count_id
      AND organization_id = v_org
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Blind receiving count not found'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.neo_branch_in_scope(v_count.branch_id) THEN
        RAISE EXCEPTION
            'Receiving count outside authorized branch'
            USING ERRCODE = '42501';
    END IF;

    -------------------------------------------------------
    -- PREVENT DUPLICATE POSTING
    -------------------------------------------------------

    IF v_count.status = 'posted'
       OR v_count.posted_grn_id IS NOT NULL THEN

        RETURN jsonb_build_object(
            'ok', true,
            'replayed', true,
            'count_id', v_count.id,
            'grn_id', v_count.posted_grn_id,
            'status', v_count.status
        );

    END IF;

    -------------------------------------------------------
    -- INDEPENDENT APPROVAL
    -------------------------------------------------------

    IF v_count.status <> 'approved' THEN
        RAISE EXCEPTION
            'Only independently approved counts may be posted'
            USING ERRCODE = '22023';
    END IF;

    IF v_count.reviewed_by IS NULL
       OR v_count.reviewed_at IS NULL THEN
        RAISE EXCEPTION
            'Independent review record is incomplete'
            USING ERRCODE = '22023';
    END IF;

    IF v_count.submitted_by = v_count.reviewed_by THEN
        RAISE EXCEPTION
            'Receiving Clerk cannot approve their own count'
            USING ERRCODE = '42501';
    END IF;

    -------------------------------------------------------
    -- VALIDATE PURCHASE ORDER
    -------------------------------------------------------

    SELECT *
    INTO v_po
    FROM public.purchase_orders
    WHERE id = v_count.purchase_order_id
      AND organization_id = v_org
      AND branch_id = v_count.branch_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Linked purchase order is invalid'
            USING ERRCODE = '22023';
    END IF;

    IF v_po.status NOT IN (
        'approved',
        'pending-delivery',
        'sent',
        'partially-received',
        'partially_received'
    ) THEN
        RAISE EXCEPTION
            'Purchase order is no longer eligible for receiving'
            USING ERRCODE = '22023';
    END IF;

    -------------------------------------------------------
    -- REVALIDATE RECEIVING LOCATION
    -------------------------------------------------------

    IF NOT EXISTS (
        SELECT 1
        FROM public.stock_locations sl
        WHERE sl.id = v_count.receiving_location_id
          AND sl.organization_id = v_org
          AND sl.active = true
          AND (
              sl.branch_id = v_count.branch_id
              OR sl.branch_id IS NULL
          )
    ) THEN
        RAISE EXCEPTION
            'Approved receiving location is no longer valid'
            USING ERRCODE = '22023';
    END IF;

    -------------------------------------------------------
    -- BUILD POSTING LINES FROM SAVED PHYSICAL COUNTS
    --
    -- Never accept quantity, price or stock location
    -- overrides from the browser.
    -------------------------------------------------------

    FOR v_line IN
        SELECT
            cl.purchase_order_line_id,
            cl.quantity_delivered,
            cl.quantity_rejected,
            cl.rejection_reason,
            cl.batch_number,
            cl.expiry_date,

            pl.quantity AS ordered_quantity,
            pl.received_quantity,
            pl.cancelled_quantity,
            pl.stock_item_id

        FROM public.neo_blind_receiving_count_lines cl

        JOIN public.purchase_order_lines pl
          ON pl.id = cl.purchase_order_line_id
         AND pl.order_id = v_count.purchase_order_id

        WHERE cl.count_id = _count_id

        ORDER BY cl.id
    LOOP

        v_line_count := v_line_count + 1;

        v_accepted :=
            v_line.quantity_delivered
            - v_line.quantity_rejected;

        v_outstanding := GREATEST(
            COALESCE(v_line.ordered_quantity, 0)
            - COALESCE(v_line.received_quantity, 0)
            - COALESCE(v_line.cancelled_quantity, 0),
            0
        );

        IF v_accepted < 0 THEN
            RAISE EXCEPTION
                'Invalid accepted quantity in original physical count'
                USING ERRCODE = '22023';
        END IF;

        IF v_line.quantity_delivered > v_outstanding THEN
            RAISE EXCEPTION
                'Approved count exceeds current outstanding PO quantity'
                USING ERRCODE = '22023';
        END IF;

        IF v_line.stock_item_id IS NULL THEN
            RAISE EXCEPTION
                'Purchase order line is not linked to a stock item'
                USING ERRCODE = '22023';
        END IF;

        IF v_line.quantity_delivered > 0 THEN

            v_lines := v_lines || jsonb_build_array(
                jsonb_build_object(
                    'order_line_id',
                        v_line.purchase_order_line_id,

                    'quantity_received',
                        v_line.quantity_delivered,

                    'quantity_rejected',
                        v_line.quantity_rejected,

                    'rejection_reason',
                        v_line.rejection_reason,

                    'batch_number',
                        v_line.batch_number,

                    'expiry_date',
                        v_line.expiry_date
                )
            );

        END IF;

    END LOOP;

    IF v_line_count = 0
       OR jsonb_array_length(v_lines) = 0 THEN
        RAISE EXCEPTION
            'No physical delivery quantities available to post'
            USING ERRCODE = '22023';
    END IF;

    -------------------------------------------------------
    -- POST THROUGH EXISTING NEØ RECEIVING LIFECYCLE
    --
    -- The blind count ID is the stable attempt key.
    -- If the existing routine fails, this transaction
    -- rolls back.
    -------------------------------------------------------

    v_result := public.neo_stores_receive_goods(
        v_count.purchase_order_id,
        v_count.receiving_location_id,
        v_lines,
        v_count.id,
        CONCAT(
            'Blind receiving count: ',
            v_count.id::text,
            CASE
                WHEN v_count.remarks IS NOT NULL
                THEN ' | ' || v_count.remarks
                ELSE ''
            END
        ),
        NULL,
        v_count.supplier_delivery_note,
        NULL
    );

    -------------------------------------------------------
    -- EXTRACT THE CREATED GRN IDENTIFIER
    -------------------------------------------------------

    v_grn_id := COALESCE(
        NULLIF(v_result->>'grn_id', ''),
        NULLIF(v_result->>'receipt_id', ''),
        NULLIF(v_result->>'goods_receipt_id', ''),
        NULLIF(v_result->>'goods_receipt', '')
    )::uuid;

    IF v_grn_id IS NULL THEN
        RAISE EXCEPTION
            'Receiving lifecycle did not return a GRN identifier'
            USING ERRCODE = '22023';
    END IF;

    -------------------------------------------------------
    -- VERIFY THE CREATED GRN BELONGS TO THIS PO
    -------------------------------------------------------

    IF NOT EXISTS (
        SELECT 1
        FROM public.goods_receipts gr
        WHERE gr.id = v_grn_id
          AND gr.organization_id = v_org
          AND gr.order_id = v_count.purchase_order_id
    ) THEN
        RAISE EXCEPTION
            'Generated GRN does not match the approved count'
            USING ERRCODE = '22023';
    END IF;

    -------------------------------------------------------
    -- LINK GRN AND MARK ORIGINAL COUNT AS POSTED
    -------------------------------------------------------

    UPDATE public.neo_blind_receiving_counts
    SET
        status = 'posted',
        posted_grn_id = v_grn_id
    WHERE id = _count_id;

    RETURN jsonb_build_object(
        'ok', true,
        'count_id', _count_id,
        'grn_id', v_grn_id,
        'status', 'posted',
        'replayed', false,
        'lifecycle_result', v_result
    );

END;
$function$;

REVOKE ALL ON FUNCTION public.neo_blind_receiving_orders() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_blind_receiving_orders() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.neo_submit_blind_receiving_count(uuid,uuid,text,jsonb,text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_submit_blind_receiving_count(uuid,uuid,text,jsonb,text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.neo_blind_receiving_review_queue() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_blind_receiving_review_queue() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.neo_blind_receiving_decide(uuid,text,text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_blind_receiving_decide(uuid,text,text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.neo_blind_receiving_approved_queue() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_blind_receiving_approved_queue() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.neo_post_approved_blind_receiving(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_post_approved_blind_receiving(uuid) TO authenticated, service_role;

-- The underlying GRN function is internal in the exported database.
REVOKE ALL ON FUNCTION
    public.neo_stores_receive_goods(
        uuid,uuid,jsonb,uuid,text,text,text,text
    )
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.neo_stores_receive_goods(
        uuid,uuid,jsonb,uuid,text,text,text,text
    )
TO service_role;

COMMIT;
