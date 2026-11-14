BEGIN;
DO $guard$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM (VALUES ('neo_submit_blind_receiving_count(uuid,uuid,text,jsonb,text)','4858e25ef1f5d388757d70ceb692075d', '101eef804063fc39bd5061bd026411e1'),
('neo_blind_receiving_review_queue()','7a1b445f51e33133a59ce1b16692414a', '7a1b445f51e33133a59ce1b16692414a'),
('neo_blind_receiving_approved_queue()','a92b598439f73550fe6f01a352e8a758', 'a92b598439f73550fe6f01a352e8a758'),
('neo_post_approved_blind_receiving(uuid)','1ecb74d175e97a372dffe61b6f38df8f', '0f0667bf31a0da1cda9addf6fdee7999'),
('neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text)','373ae1b84909eff55404e9579f943a79', '373ae1b84909eff55404e9579f943a79'),
('neo_blind_receiving_decide(uuid,text,text)','ca8c08384d55eb24b659ca5f038f65dc', 'a4be8e8d48afb4fc7003da651d5bdc92'),
('neo_blind_receiving_orders()','816576204c37b4afb17806f91c7af095', '816576204c37b4afb17806f91c7af095'),
('inventory_post_receipt(uuid)','86bbb5119fea9f5f4954bf9fe7035d29', '86bbb5119fea9f5f4954bf9fe7035d29')) v(signature,original_hash,repaired_hash) LOOP
  IF coalesce(md5(pg_get_functiondef(to_regprocedure(r.signature))) IN (r.original_hash,r.repaired_hash),false) IS NOT TRUE THEN
   RAISE EXCEPTION 'Receiving definition changed: %. Nothing installed; inspect first.',r.signature;
  END IF;
 END LOOP;
END $guard$;
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
    v_posting jsonb;
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
      'procurement', 'orders.approve'
    ) IS TRUE
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

    IF v_decision='approved' AND (public.is_org_admin() IS TRUE
        OR public.has_permission('procurement','receiving.manage') IS TRUE) THEN
        -- Review and posting share one transaction only for a caller who holds
        -- both existing capabilities. Review-only staff never gain stock authority.
        v_posting := public.neo_post_approved_blind_receiving(_count_id);
        IF coalesce((v_posting->>'ok')::boolean,false) IS NOT TRUE
          OR v_posting->>'status' IS DISTINCT FROM 'posted'
          OR nullif(v_posting->>'grn_id','') IS NULL THEN
            RAISE EXCEPTION 'Approved receiving did not return its posted GRN';
        END IF;
        RETURN jsonb_build_object('ok',true,'count_id',_count_id,'status','posted',
          'grn_id',v_posting->>'grn_id','stock_posted',true,
          'posting_result',v_posting,'reviewed_by',auth.uid());
    END IF;

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
WITH expected(signature,hash) AS (VALUES ('neo_submit_blind_receiving_count(uuid,uuid,text,jsonb,text)','101eef804063fc39bd5061bd026411e1'),
('neo_post_approved_blind_receiving(uuid)','0f0667bf31a0da1cda9addf6fdee7999'),
('neo_blind_receiving_decide(uuid,text,text)','a4be8e8d48afb4fc7003da651d5bdc92')), checked AS (
 SELECT signature,md5(pg_get_functiondef(to_regprocedure(signature)))=hash AS matches FROM expected)
SELECT jsonb_build_object('diagnostic_version','receiving-review-grn-handoff-v1',
 'definitions_match',(SELECT bool_and(matches) FROM checked),
 'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),
 'scope','Installs three guarded receiving handoff corrections only. Existing independent-review and posting permissions remain separate. No count approved, GRN created, stock moved or history changed by installation.') AS result;
COMMIT;
