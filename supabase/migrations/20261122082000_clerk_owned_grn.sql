-- Clerk-owned GRNs keep independent review and use the approved count as the posting input.
BEGIN;

DO $receiving_baseline$
DECLARE mismatch text;
BEGIN
  SELECT string_agg(signature, ', ') INTO mismatch
  FROM (VALUES
    ('public.neo_blind_receiving_decide(uuid,text,text)', ARRAY['1caba518c36793706d2cce33f201995e','764991c4b5bb786410e0e08776d78c06','e2be8f7d872d0aaca87606a576ea0c09']),
    ('public.neo_post_approved_blind_receiving(uuid)', ARRAY['27154efb39e351bbdeba6b4301b512fc','e5dae5fbeefe865533a5309c3d2f5ba3','fc3ae6e7d18c322f114a331fee1e99da']),
    ('public.neo_blind_receiving_approved_queue()', ARRAY['1afc41c5957e70ab02db12c694137d2b','87a68de16d8c6ec616aad60d07d1f59f','e1e76d7aa6ced7790192bf5c15a050d4']),
    ('public.neo_blind_receiving_review_queue()', ARRAY['144238f2a1fb98d421834ef66594dafe','778ce55b8d107ee93666dc12a8a6a549','bd8ba9da435ba30e909fd0eb39f5cefa']),
    ('public.neo_receiving_post_receipt_internal(uuid)', ARRAY['88942e02590968c978ca9e28ce98c2ab','59ffb83f0d54333aa0bbbdfc62b486cc'])
  ) AS expected(signature, fingerprints)
  LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR NOT p.prosecdef
    OR NOT (md5(replace(p.prosrc, chr(13)||chr(10), chr(10))) = ANY(expected.fingerprints));
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'Unreviewed receiving functions: %', mismatch;
  END IF;
END;
$receiving_baseline$;

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

    IF v_decision = 'approved' AND EXISTS (
        SELECT 1 FROM public.neo_receiving_custody x WHERE x.count_id = _count_id AND x.discrepancy
    ) THEN
        RAISE EXCEPTION 'Reject this count with the discrepancy reason so the clerk can correct it.';
    END IF;

    SELECT
        count(*),
        count(*) FILTER (
            WHERE
                (cl.quantity_delivered - cl.quantity_rejected)
                >
                GREATEST(
                    COALESCE(pl.quantity, 0)
                    - COALESCE(pl.accepted_quantity, 0)
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
            'Excess accepted quantities exceed the outstanding order. Correct the count or purchase order before approving.'
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



    IF NOT (public.is_active_staff() IS TRUE AND (
        public.is_org_admin() IS TRUE
        OR public.has_permission('procurement', 'receiving.manage') IS TRUE
        OR public.has_permission('procurement', 'receiving', 'create') IS TRUE
    )) THEN

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

    IF v_count.submitted_by IS DISTINCT FROM auth.uid()
       AND NOT coalesce(public.is_org_admin() OR public.has_permission('procurement', 'receiving.manage'), false) THEN
        RAISE EXCEPTION 'Only the submitting clerk or a receiving manager can post this approved count' USING ERRCODE = '42501';
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

    IF EXISTS (SELECT 1 FROM public.neo_receiving_custody x WHERE x.count_id = _count_id AND x.discrepancy) THEN
        RAISE EXCEPTION 'An unresolved discrepancy must be corrected before posting';
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
            pl.accepted_quantity,
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
            - COALESCE(v_line.accepted_quantity, 0)
            - COALESCE(v_line.cancelled_quantity, 0),
            0
        );

        IF v_accepted < 0 THEN
            RAISE EXCEPTION
                'Invalid accepted quantity in original physical count'
                USING ERRCODE = '22023';
        END IF;

        IF v_accepted > v_outstanding THEN
            RAISE EXCEPTION
                'Approved accepted quantity exceeds current outstanding PO quantity'
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


    IF NOT (public.is_active_staff() IS TRUE AND (
        public.is_org_admin() IS TRUE
        OR public.has_permission('procurement', 'receiving.manage') IS TRUE
        OR public.has_permission('procurement', 'receiving', 'create') IS TRUE
    )) THEN

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
      AND NOT EXISTS (SELECT 1 FROM public.neo_receiving_custody x WHERE x.count_id = c.id AND x.discrepancy)
      AND public.neo_branch_in_scope(c.branch_id)
      AND (c.submitted_by = auth.uid() OR coalesce(public.is_org_admin() OR public.has_permission('procurement', 'receiving.manage'), false));

    RETURN v_result;
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
                'clerk_grn_workflow', true,
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
                                        pl.accepted_quantity, 0
                                    ),

                                'cancelled_quantity',
                                    COALESCE(
                                        pl.cancelled_quantity, 0
                                    ),

                                'outstanding_quantity',
                                    GREATEST(
                                        COALESCE(pl.quantity, 0)
                                        - COALESCE(
                                            pl.accepted_quantity, 0
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
                                            pl.accepted_quantity, 0
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
                                        WHEN (cl.quantity_delivered - cl.quantity_rejected) >
                                        GREATEST(
                                            COALESCE(pl.quantity, 0)
                                            - COALESCE(
                                                pl.accepted_quantity, 0
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
                                                pl.accepted_quantity, 0
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

CREATE OR REPLACE FUNCTION public.neo_receiving_post_receipt_internal(_receipt uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=current_org_id(); r record; l record; v_total numeric:=0; v_lines integer:=0; v_accepted numeric; v_err text; v_prior_posting text;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not permitted to receive stock'; END IF;
 SELECT * INTO r FROM goods_receipts WHERE id=_receipt AND organization_id=v_org FOR UPDATE;
 IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
 IF NOT coalesce(public.has_permission('procurement','receiving.manage'),false)
    AND NOT (r.received_by IS NOT DISTINCT FROM auth.uid()
      AND public.has_permission('procurement','receiving','create') IS TRUE
      AND EXISTS (SELECT 1 FROM public.neo_blind_receiving_counts c
        WHERE c.organization_id=v_org AND c.branch_id=r.branch_id AND c.purchase_order_id=r.order_id
          AND c.supplier_delivery_note=r.delivery_note_number AND c.status='approved'
          AND c.submitted_by=auth.uid() AND c.reviewed_by IS DISTINCT FROM auth.uid()
          AND c.reviewed_by IS NOT NULL AND c.reviewed_at IS NOT NULL
          AND c.posted_grn_id IS NULL)
    ) THEN RAISE EXCEPTION 'Not permitted to receive stock' USING ERRCODE='42501';
 END IF;
 IF NOT coalesce(public.neo_branch_in_scope(r.branch_id),false) THEN RAISE EXCEPTION 'Receipt outside authorized property'; END IF;
 IF r.status IS NULL OR r.status NOT IN ('received','approved','posted') THEN RAISE EXCEPTION 'Receipt is not approved for stock posting'; END IF;
 IF r.status='posted' AND r.accrual_journal_id IS NOT NULL THEN RETURN jsonb_build_object('status','already-posted','journal_id',r.accrual_journal_id); END IF;
 IF r.status<>'posted' THEN
  FOR l IN SELECT * FROM goods_receipt_lines WHERE receipt_id=_receipt LOOP
   v_accepted:=COALESCE(l.quantity_accepted,GREATEST(COALESCE(l.quantity_received,0)-COALESCE(l.quantity_rejected,0)-COALESCE(l.quantity_damaged,0)-COALESCE(l.quantity_returned,0),0));
   IF EXISTS(SELECT 1 FROM unnest(ARRAY[l.quantity_received,l.quantity_rejected,l.quantity_damaged,l.quantity_returned]) q
       WHERE q<0 OR q::text IN ('NaN','Infinity','-Infinity'))
     OR l.organization_id IS DISTINCT FROM v_org
     OR v_accepted IS NULL OR v_accepted<0 OR v_accepted::text IN ('NaN','Infinity','-Infinity')
     OR l.unit_price IS NULL OR l.unit_price<0 OR l.unit_price::text IN ('NaN','Infinity','-Infinity')
     OR v_accepted>coalesce(l.quantity_received,0)-coalesce(l.quantity_rejected,0)-coalesce(l.quantity_damaged,0)-coalesce(l.quantity_returned,0) THEN
     RAISE EXCEPTION 'Receipt accepted quantities and cost need reconciliation';
   END IF;
   IF l.order_line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.purchase_order_lines pl
     WHERE pl.id=l.order_line_id AND pl.order_id=r.order_id AND pl.stock_item_id=l.stock_item_id
       AND lower(btrim(pl.unit))=lower(btrim(l.unit))) THEN
     RAISE EXCEPTION 'Receipt line item or unit differs from its original purchase line';
   END IF;
   IF v_accepted>0 THEN
    v_prior_posting := coalesce(current_setting('neo.system_posting',true),'off');
    PERFORM set_config('neo.system_posting','on',true);
    PERFORM public.neo_receiving_movement_internal(l.stock_item_id,COALESCE(l.location_id,r.location_id),v_accepted,l.unit,'receipt',
      l.unit_price/NULLIF(public.inventory_convert_strict(1,l.unit,(SELECT base_unit FROM stock_items WHERE id=l.stock_item_id)),0),
      'goods_receipt',_receipt,'Goods accepted','grn:'||_receipt::text||':'||l.id::text,l.batch_number,l.expiry_date);
    PERFORM set_config('neo.system_posting',v_prior_posting,true);
    v_total:=v_total+(v_accepted*COALESCE(l.unit_price,0)); v_lines:=v_lines+1;
   END IF;
   IF l.order_line_id IS NOT NULL THEN UPDATE purchase_order_lines SET received_quantity=COALESCE(received_quantity,0)+COALESCE(l.quantity_received,0),accepted_quantity=COALESCE(accepted_quantity,0)+v_accepted,rejected_quantity=COALESCE(rejected_quantity,0)+COALESCE(l.quantity_rejected,0),returned_quantity=COALESCE(returned_quantity,0)+COALESCE(l.quantity_returned,0) WHERE id=l.order_line_id; END IF;
  END LOOP;
  UPDATE goods_receipts SET status='posted',posted_at=now(),total_value=v_total WHERE id=_receipt;
 ELSE v_total:=COALESCE(r.total_value,0); END IF;
 BEGIN
  PERFORM public.neo_grn_post_accrual(_receipt);
  UPDATE goods_receipts SET accrual_error=NULL WHERE id=_receipt;
 EXCEPTION WHEN OTHERS THEN
  v_err:=SQLERRM; UPDATE goods_receipts SET accrual_error=v_err WHERE id=_receipt;
  PERFORM public.neo_record_posting_receipt(v_org,r.branch_id,'inventory',_receipt,COALESCE(r.grn_number,_receipt::text),'failed',v_total,'KES',NULL,'Goods receipt accrual',v_err,CURRENT_DATE);
 END;
 RETURN jsonb_build_object('status',CASE WHEN v_err IS NULL THEN 'posted' ELSE 'pending-finance' END,'lines',v_lines,'value',v_total,'finance_error',v_err);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_receiving_post_receipt_internal(uuid)
FROM PUBLIC, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
