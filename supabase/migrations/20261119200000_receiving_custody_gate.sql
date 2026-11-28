BEGIN;
-- Rejected attempts remain in history. A physical recount can reuse the supplier note
-- only after rejection, while active and posted counts retain database uniqueness.
DROP INDEX IF EXISTS public.neo_blind_receiving_unique_delivery;
CREATE UNIQUE INDEX neo_blind_receiving_unique_delivery
ON public.neo_blind_receiving_counts (organization_id, purchase_order_id, lower(btrim(supplier_delivery_note)))
WHERE status <> 'rejected' OR posted_grn_id IS NOT NULL;

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

    IF public.is_active_staff() IS NOT TRUE
       OR public.has_permission('procurement', 'receiving', 'create') IS NOT TRUE THEN
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

    IF public.neo_branch_in_scope(v_po.branch_id) IS NOT TRUE THEN
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
          AND sl.branch_id IS NOT DISTINCT FROM v_po.branch_id
    ) THEN
        RAISE EXCEPTION 'Receiving store is invalid for this purchase order'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.neo_blind_receiving_counts c
        WHERE c.organization_id = v_org
          AND c.purchase_order_id = _order
          AND (c.status <> 'rejected' OR c.posted_grn_id IS NOT NULL)
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

        IF v_qty::text IN ('NaN','Infinity','-Infinity')
           OR v_rejected::text IN ('NaN','Infinity','-Infinity')
           OR v_qty < 0
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

CREATE TABLE public.neo_receiving_custody (
    count_id uuid PRIMARY KEY REFERENCES public.neo_blind_receiving_counts(id),
    accepted_by uuid NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT now(),
    lines jsonb NOT NULL,
    discrepancy boolean NOT NULL,
    prior_review jsonb
);
ALTER TABLE public.neo_receiving_custody ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.neo_receiving_custody FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.neo_receiving_custody_queue()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'count_id', c.id, 'branch_id', c.branch_id, 'order_number', po.order_number,
        'delivery_note', c.supplier_delivery_note,
        'lines', (
            SELECT jsonb_agg(jsonb_build_object(
                'line_id', cl.id, 'order_line_id', pl.id, 'item_name', si.name, 'unit', pl.unit
            ) ORDER BY si.name, cl.id)
            FROM public.neo_blind_receiving_count_lines cl
            JOIN public.purchase_order_lines pl ON pl.id = cl.purchase_order_line_id
            LEFT JOIN public.stock_items si ON si.id = pl.stock_item_id
            WHERE cl.count_id = c.id
        )
    ) ORDER BY c.submitted_at), '[]'::jsonb)
    FROM public.neo_blind_receiving_counts c
    JOIN public.purchase_orders po ON po.id = c.purchase_order_id
    WHERE auth.uid() IS NOT NULL AND public.is_active_staff()
      AND public.has_permission('stores', 'issues', 'create')
      AND c.organization_id = public.current_org_id()
      AND public.neo_branch_in_scope(c.branch_id)
      AND c.submitted_by <> auth.uid()
      AND c.status IN ('submitted', 'under_review', 'approved')
      AND c.posted_grn_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.neo_receiving_custody x WHERE x.count_id = c.id);
$$;

CREATE FUNCTION public.neo_accept_receiving_custody(_count_id uuid, _lines jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    c public.neo_blind_receiving_counts%ROWTYPE;
    recorded public.neo_receiving_custody%ROWTYPE;
    expected integer;
    matched integer;
    differs boolean;
BEGIN
    IF auth.uid() IS NULL OR public.is_active_staff() IS NOT TRUE
       OR public.has_permission('stores', 'issues', 'create') IS NOT TRUE THEN
        RAISE EXCEPTION 'Storekeeper custody authorization required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO c FROM public.neo_blind_receiving_counts
    WHERE id = _count_id AND organization_id = public.current_org_id() FOR UPDATE;
    IF NOT FOUND OR public.neo_branch_in_scope(c.branch_id) IS NOT TRUE
       OR c.submitted_by IS NOT DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'An independent Storekeeper in the delivery property is required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO recorded FROM public.neo_receiving_custody WHERE count_id = c.id;
    IF FOUND THEN
        IF recorded.accepted_by = auth.uid() AND recorded.lines = _lines THEN RETURN true; END IF;
        RAISE EXCEPTION 'Custody is already recorded';
    END IF;
    IF c.status NOT IN ('submitted', 'under_review', 'approved') OR c.posted_grn_id IS NOT NULL THEN
        RAISE EXCEPTION 'This delivery cannot enter custody review';
    END IF;
    IF jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Enter an independent count for every line'; END IF;
    SELECT count(*) INTO expected FROM public.neo_blind_receiving_count_lines WHERE count_id = c.id;
    SELECT count(DISTINCT cl.id), bool_or(
        l.delivered IS DISTINCT FROM cl.quantity_delivered
        OR l.rejected IS DISTINCT FROM cl.quantity_rejected
        OR NULLIF(btrim(l.batch),'') IS DISTINCT FROM cl.batch_number
        OR l.expiry IS DISTINCT FROM cl.expiry_date
    ) INTO matched, differs
    FROM jsonb_to_recordset(_lines) l(line_id uuid, delivered numeric, rejected numeric, batch text, expiry date)
    JOIN public.neo_blind_receiving_count_lines cl ON cl.id = l.line_id AND cl.count_id = c.id
    WHERE l.delivered >= 0 AND l.rejected BETWEEN 0 AND l.delivered
      AND l.delivered::text NOT IN ('NaN','Infinity','-Infinity')
      AND l.rejected::text NOT IN ('NaN','Infinity','-Infinity');
    IF expected = 0 OR expected <> matched OR expected <> jsonb_array_length(_lines) THEN
        RAISE EXCEPTION 'Enter one valid delivered and rejected quantity for each count line';
    END IF;
    INSERT INTO public.neo_receiving_custody(count_id, accepted_by, lines, discrepancy, prior_review)
    VALUES (c.id, auth.uid(), _lines, differs, CASE WHEN c.status = 'approved' THEN
        jsonb_build_object('reviewed_by', c.reviewed_by, 'reviewed_at', c.reviewed_at, 'review_notes', c.review_notes)
    END);
    IF c.status = 'approved' THEN
        UPDATE public.neo_blind_receiving_counts SET status = 'under_review', reviewed_by = NULL,
            reviewed_at = NULL, review_notes = NULL WHERE id = c.id;
    END IF;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_receiving_custody_queue(), public.neo_accept_receiving_custody(uuid,jsonb)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_receiving_custody_queue(), public.neo_accept_receiving_custody(uuid,jsonb)
TO authenticated;
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

    
-- neo_receiving_role_handoff_v1
IF (
  public.is_active_staff() IS TRUE
  AND (
    public.is_org_admin() IS TRUE
    OR public.has_permission('procurement', 'orders', 'approve') IS TRUE
  )
) IS NOT TRUE THEN

        RAISE EXCEPTION 'Independent review authorization required'
            USING ERRCODE = '42501';
    END IF;

    IF v_decision IS NULL OR v_decision NOT IN ('approved', 'rejected') THEN
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

    IF public.neo_branch_in_scope(v_count.branch_id) IS NOT TRUE THEN
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

    IF v_decision = 'approved' AND NOT EXISTS (
        SELECT 1 FROM public.neo_receiving_custody x
        WHERE x.count_id = _count_id AND NOT x.discrepancy
          AND x.accepted_by <> auth.uid()
          AND x.accepted_by <> v_count.submitted_by
    ) THEN
        RAISE EXCEPTION 'Approval requires matching custody by a separate Storekeeper. Reject and recount discrepancies.';
    END IF;

    SELECT
        count(*),
        count(*) FILTER (
            WHERE
                cl.quantity_delivered
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


    
-- neo_receiving_role_handoff_v1
IF (
  public.is_active_staff() IS TRUE
  AND (
    public.is_org_admin() IS TRUE
    OR public.has_permission(
      'procurement', 'receiving.manage'
    ) IS TRUE
  )
) IS NOT TRUE THEN

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

    IF public.neo_branch_in_scope(v_count.branch_id) IS NOT TRUE THEN
        RAISE EXCEPTION
            'Receiving count outside authorized branch'
            USING ERRCODE = '42501';
    END IF;

    -------------------------------------------------------
    -- PREVENT DUPLICATE POSTING
    -------------------------------------------------------

    IF v_count.submitted_by = auth.uid() THEN
        RAISE EXCEPTION 'You cannot post your own receiving count'
            USING ERRCODE = '42501';
    END IF;

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

    IF lower(concat_ws(' ',v_count.supplier_delivery_note,v_count.remarks,v_count.review_notes))
       LIKE ANY(ARRAY['%virtual test only%','%no actual goods%','%no real goods%',
                      '%no physical goods%','%simulation only%','%no supplier commitment%']) THEN
        RAISE EXCEPTION 'This count is marked as virtual/test-only; inventory posting is prohibited' USING ERRCODE='22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.neo_receiving_custody x
        WHERE x.count_id = _count_id AND NOT x.discrepancy
          AND x.accepted_by <> auth.uid()
          AND x.accepted_by <> v_count.reviewed_by
          AND x.accepted_by <> v_count.submitted_by
    ) THEN
        RAISE EXCEPTION 'Posting requires independent Storekeeper custody' USING ERRCODE = '42501';
    END IF;

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
          AND sl.branch_id IS NOT DISTINCT FROM v_count.branch_id
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

    
-- neo_receiving_role_handoff_v1
IF (
  public.is_active_staff() IS TRUE
  AND (
    public.is_org_admin() IS TRUE
    OR public.has_permission(
      'procurement', 'receiving.manage'
    ) IS TRUE
  )
) IS NOT TRUE THEN

        RAISE EXCEPTION 'Authorized inventory posting access required'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'count_id', c.id,
                'purchase_order_id', c.purchase_order_id,
                'branch_id', c.branch_id,
                'order_number', po.order_number,
                'delivery_note', c.supplier_delivery_note,
                'submitted_at', c.submitted_at,
                'reviewed_at', c.reviewed_at,
                'review_notes', c.review_notes,
                'status', c.status,
                'posting_block_reason', CASE
                    WHEN lower(concat_ws(' ',c.supplier_delivery_note,c.remarks,c.review_notes))
                        LIKE ANY(ARRAY['%virtual test only%','%no actual goods%','%no real goods%',
                            '%no physical goods%','%simulation only%','%no supplier commitment%'])
                    THEN 'This count is marked as virtual/test-only; inventory posting is prohibited.'
                END,
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
      AND EXISTS (
        SELECT 1 FROM public.neo_receiving_custody x
        WHERE x.count_id = c.id AND NOT x.discrepancy AND x.accepted_by <> auth.uid()
      )
      AND public.neo_branch_in_scope(c.branch_id)
      AND c.submitted_by <> auth.uid();

    RETURN v_result;
END;
$function$;

-- Preserve the existing posting engine and restrict the raw GRN command to its owner.
REVOKE ALL ON FUNCTION public.neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text)
FROM PUBLIC, anon, authenticated, service_role;

-- The private entry point is used by the GRN engine. Keep existing Finance retries
-- and standalone receipts available through the original public signature.
ALTER FUNCTION public.inventory_post_receipt(uuid) RENAME TO neo_receiving_post_receipt_internal;
REVOKE ALL ON FUNCTION public.neo_receiving_post_receipt_internal(uuid)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.inventory_post_receipt(_receipt uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r public.goods_receipts%ROWTYPE;
BEGIN
    SELECT * INTO r FROM public.goods_receipts
    WHERE id = _receipt AND organization_id = public.current_org_id() FOR UPDATE;
    IF FOUND AND r.status IS DISTINCT FROM 'posted' THEN
        RAISE EXCEPTION 'Stock posting requires approved receiving' USING ERRCODE = '42501';
    END IF;
    RETURN public.neo_receiving_post_receipt_internal(_receipt);
END;
$$;
REVOKE ALL ON FUNCTION public.inventory_post_receipt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_post_receipt(uuid) TO authenticated, service_role;

DO $$
DECLARE
    definition text;
    engine regprocedure := 'public.neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text)';
BEGIN
    definition := pg_get_functiondef(engine);
    IF strpos(definition, 'public.inventory_post_receipt(_grn)') = 0 THEN
        RAISE EXCEPTION 'Unrecognized receiving engine. Review the installed definition.';
    END IF;
    EXECUTE replace(definition, 'public.inventory_post_receipt(_grn)',
        'public.neo_receiving_post_receipt_internal(_grn)');
END;
$$;

-- Receipt writes are owned by the receiving engine and Finance routines.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.goods_receipts, public.goods_receipt_lines
FROM PUBLIC, anon, authenticated;

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

    
-- neo_receiving_role_handoff_v1
IF (
  public.is_active_staff() IS TRUE
  AND (
    public.is_org_admin() IS TRUE
    OR public.has_permission(
      'procurement', 'orders.approve'
    ) IS TRUE
  )
) IS NOT TRUE THEN

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
                'custody_status', COALESCE((
                    SELECT CASE WHEN x.discrepancy THEN 'discrepancy'
                                WHEN x.accepted_by = auth.uid() THEN 'own-custody'
                                ELSE 'matched' END
                    FROM public.neo_receiving_custody x WHERE x.count_id = c.id
                ), 'pending'),
                'custody_lines', (
                    SELECT x.lines FROM public.neo_receiving_custody x WHERE x.count_id = c.id
                ),
                'remarks', c.remarks,
                'lines', (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'count_line_id', cl.id,
                                'order_line_id', pl.id,
                                'item_name', COALESCE(
                                    (
                                        SELECT si.name
                                        FROM public.stock_items si
                                        WHERE si.id = pl.stock_item_id
                                          AND si.organization_id = v_org
                                    ),
                                    pl.description,
                                    'Unidentified item'
                                ),
                                'unit', pl.unit,

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
                                        WHEN cl.quantity_delivered >
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

ALTER FUNCTION public.inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date)
RENAME TO neo_receiving_movement_internal;
REVOKE ALL ON FUNCTION public.neo_receiving_movement_internal(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.inventory_apply_movement(
    _item uuid, _location uuid, _quantity numeric, _unit text, _movement_type text,
    _unit_cost numeric DEFAULT NULL, _reference_type text DEFAULT NULL, _reference_id uuid DEFAULT NULL,
    _reason text DEFAULT NULL, _idempotency_key text DEFAULT NULL, _batch_number text DEFAULT NULL,
    _expiry date DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF (lower(btrim(coalesce(_movement_type,''))) = 'receipt'
            AND NOT (lower(btrim(coalesce(_reference_type,''))) = 'direct-receipt'
                AND public.has_permission('inventory', 'stock', 'manage') IS TRUE))
       OR lower(btrim(coalesce(_reference_type,''))) = 'goods_receipt'
       OR lower(coalesce(_idempotency_key,'')) LIKE 'grn:%' THEN
        RAISE EXCEPTION 'Receipt stock movements must use receipt posting' USING ERRCODE = '42501';
    END IF;
    RETURN public.neo_receiving_movement_internal(
        _item, _location, _quantity, _unit, _movement_type, _unit_cost, _reference_type,
        _reference_id, _reason, _idempotency_key, _batch_number, _expiry
    );
END;
$$;
REVOKE ALL ON FUNCTION public.inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date)
TO authenticated, service_role;

DO $$
DECLARE
    definition text := pg_get_functiondef('public.neo_receiving_post_receipt_internal(uuid)'::regprocedure);
BEGIN
    IF strpos(definition, 'inventory_apply_movement(') = 0 THEN
        RAISE EXCEPTION 'Unrecognized inventory receipt engine. Review the installed definition.';
    END IF;
    EXECUTE replace(definition, 'inventory_apply_movement(', 'neo_receiving_movement_internal(');
END;
$$;

COMMIT;


